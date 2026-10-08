import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const [runtimeInput, serviceInput, processInput, evidenceInput] = process.argv.slice(2);
assert.ok(runtimeInput && serviceInput && processInput && evidenceInput,
  'Usage: fixture REBUILT_POLLYUI SERVICE PROCESS ABSOLUTE_EVIDENCE');
assert.notEqual(runtimeInput, '--probe', 'Standalone probes do not establish the product-native document contract');
assert.ok(path.isAbsolute(evidenceInput));
const runtime = path.resolve(runtimeInput), service = path.resolve(serviceInput), helper = path.resolve(processInput);
const root = await mkdtemp(path.join(tmpdir(), 'polly-documents-')), evidence = path.join(evidenceInput, path.basename(root));
const run = path.join(root, 'run'), services = path.join(root, 'services');
const data = path.join(root, 'data'), system = path.join(root, 'system');
const config = path.join(root, 'config'), systemConfig = path.join(root, 'system-config'), work = path.join(root, 'working directory');
await Promise.all([mkdir(run, { mode: 0o700 }), mkdir(services), mkdir(work), mkdir(config), mkdir(systemConfig),
  mkdir(path.join(data, 'applications'), { recursive: true }), mkdir(path.join(system, 'applications'), { recursive: true })]);
const documents = [path.join(root, 'ordinary $(not-command); document.txt'), path.join(root, '中文 %u.txt')];
await Promise.all(documents.map(file => writeFile(file, 'An ordinary temporary local text document.\n')));
const localUri = value => 'file://' + value.split('/').map(part => encodeURIComponent(part)
  .replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())).join('/');
const uris = documents.map(localUri), address = 'unix:path=' + path.join(run, 'bus');
const env = { ...process.env, HOME: root, XDG_RUNTIME_DIR: run, XDG_DATA_HOME: data, XDG_DATA_DIRS: system,
  XDG_CONFIG_HOME: config, XDG_CONFIG_DIRS: systemConfig, XDG_CACHE_HOME: path.join(root, 'cache'),
  XDG_STATE_HOME: path.join(root, 'state'), DBUS_SESSION_BUS_ADDRESS: address, POLLY_SESSION_BUS_ADDRESS: address,
  DBUS_STARTER_ADDRESS: '', DBUS_STARTER_BUS_TYPE: '', WAYLAND_SOCKET: '3', WAYLAND_DISPLAY: 'synthetic-document',
  DISPLAY: ':must-not-leak', SDL_APP_ID: 'must-not-leak', SDL_VIDEODRIVER: 'dummy',
  SDL_RENDER_DRIVER: 'software', PU_RENDERER: 'raster', LC_ALL: 'C' };
const quote = value => '"' + value.replaceAll('\\', '\\\\\\\\').replaceAll('"', '\\\\"') + '"';
const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const name = suffix => 'org.pollyui.DocumentFixture.' + suffix;
const entry = (id, body, directory = system) => writeFile(path.join(directory, 'applications', id),
  '[Desktop Entry]\nType=Application\nName=Document fixture\nMimeType=text/plain;\n' + body + '\n');
const specs = [['Success', 'ack'], ['Error', 'error'], ['Malformed', 'malformed'], ['Fds', 'fds'],
  ['Oversized', 'oversized'], ['Timeout', 'timeout'], ['Late', 'late'], ['Disconnect', 'disconnect']];
const serviceLogs = new Map();
for (const [suffix, mode] of specs) {
  const busName = name(suffix), objectPath = '/' + busName.replaceAll('.', '/');
  const log = path.join(root, suffix + '.service.log');
  serviceLogs.set(suffix, log);
  await writeFile(path.join(services, busName + '.service'), '[D-BUS Service]\nName=' + busName +
    '\nExec=' + [service, busName, objectPath, log, mode]
      .map(value => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"').join(' ') + '\n');
  await entry(busName + '.desktop', 'DBusActivatable=true');
}
await entry(name('Missing') + '.desktop', 'DBusActivatable=true');
const editor = path.join(data, 'applications', 'editor.desktop');
await writeFile(editor, '[Desktop Entry]\nType=Application\nName=Editor %u 中文\nIcon=literal icon\nMimeType=text/plain;\n' +
  'NoDisplay=true\nPath=' + work + '\nExec=' + quote(helper) + ' ' + quote(path.join(root, 'argv.bin')) +
  ' %F %i %c %k %% "two words" ""\n');
await entry('uri.desktop', 'DBusActivatable=true\nPath=' + work + '\nExec=' + quote(helper) + ' ' +
  quote(path.join(root, 'uri.bin')) + ' %U');
await entry('single.desktop', 'Exec=' + quote(helper) + ' ' + quote(path.join(root, 'single.bin')) + ' %f');
await entry('launch-only.desktop', 'Exec=/bin/true');
await writeFile(path.join(system, 'applications', 'no-mime.desktop'),
  '[Desktop Entry]\nType=Application\nName=No MIME\nExec=/bin/true %F\n');
await entry('masked.desktop', 'Hidden=true\nExec=/bin/true %F', data);
await entry('masked.desktop', 'Exec=/bin/true %F');
await entry('invalid.desktop', 'Exec=/bin/true %F\nName=Duplicate', data);
await entry('invalid.desktop', 'Exec=/bin/true %F');
await writeFile(path.join(config, 'polly-mimeapps.list'), '[Default Applications]\ntext/plain=editor.desktop;\n');
await writeFile(path.join(config, 'mimeapps.list'), '[Default Applications]\ntext/plain=' + name('Success') + '.desktop;\n');
await writeFile(path.join(system, 'applications', 'mimeapps.list'), '[Default Applications]\ntext/plain=uri.desktop;\n');
const states = [], delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function child(program, args, overrides = {}) {
  const process = spawn(program, args, { env: { ...env, ...overrides }, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
  const state = { process, output: '', finished: false };
  process.stdout.on('data', bytes => { state.output += bytes; });
  process.stderr.on('data', bytes => { state.output += bytes; });
  process.stdio[3].on('error', error => {
    if (!['EPIPE', 'ECONNRESET'].includes(error.code)) state.error = error;
  });
  process.stdio[3].end('unrelated fixture descriptor must not reach an application');
  state.closed = new Promise(resolve => {
    process.once('error', error => { state.error = error; });
    process.once('close', (code, signal) => { Object.assign(state, { code, signal, finished: true }); resolve(); });
  });
  states.push(state); return state;
}
async function until(predicate, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(10); }
  throw new Error('Timed out: ' + message);
}
async function text(file) {
  try { return await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}
async function completed(state, label, timeout = 20000) {
  const timer = setTimeout(() => state.process.kill('SIGKILL'), timeout);
  try { await state.closed; } finally { clearTimeout(timer); }
  await writeFile(path.join(root, label + '.log'), state.output);
  assert.ifError(state.error);
  assert.equal(state.code, 0, label + '\n' + state.output);
  assert.doesNotMatch(state.output, /FAIL:|AddressSanitizer|LeakSanitizer|runtime error:/);
  assert.match(state.output, /requires actual newly built document native API/);
  console.log('PASS: ' + label);
}
const busConfig = path.join(root, 'bus.conf');
await writeFile(busConfig, '<busconfig><type>session</type><listen>' + xml(address) +
  '</listen><auth>EXTERNAL</auth><servicedir>' + xml(services) + '</servicedir>' +
  '<policy context="default"><allow own_prefix="org.pollyui"/><allow send_destination="*"/><allow receive_sender="*"/></policy>' +
  '<limit name="service_start_timeout">2000</limit><limit name="max_completed_connections">32</limit></busconfig>\n');
const daemon = child('dbus-daemon', ['--nofork', '--config-file=' + busConfig, '--print-address=1']);
const client = (mode, overrides = {}) => child(runtime, ['--desktop', '--app-id', 'org.pollyui.document-test',
  'desktop/tests/document-association-client.mjs', mode, ...documents, root], overrides);
async function preserve(directory, target) {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const source = path.join(directory, entry.name), destination = path.join(target, entry.name);
    if (entry.isDirectory()) await preserve(source, destination);
    else if (entry.isFile()) await writeFile(destination, await readFile(source));
    else if (!entry.isSocket()) throw new Error('Unexpected fixture evidence type: ' + source);
  }
}
let passed = false;
try {
  await until(() => daemon.output.includes('guid=') || daemon.finished, 'isolated daemon readiness');
  assert.equal(daemon.finished, false, daemon.output);
  env.POLLY_SESSION_BUS_ADDRESS = env.DBUS_SESSION_BUS_ADDRESS = daemon.output.split('\n')[0].trim();
  await completed(client('exec'), 'native-mime-default-exec');
  assert.deepEqual((await readFile(path.join(root, 'argv.bin'), 'utf8')).split('\0').slice(0, -1),
    [...documents, '--icon', 'literal icon', 'Editor %u 中文', editor, '%', 'two words', '',
      work, env.DBUS_SESSION_BUS_ADDRESS, 'synthetic-document'], 'actual application argv/cwd/private bus, not a stub');
  assert.deepEqual((await readFile(path.join(root, 'uri.bin'), 'utf8')).split('\0').slice(0, -1),
    [...uris, work, env.DBUS_SESSION_BUS_ADDRESS, 'synthetic-document'], 'actual multi-URI argv');
  await completed(client('open'), 'native-standard-open');
  await completed(client('bounds'), 'native-open-shared-queue');
  const late = client('late');
  await until(async () => (await text(serviceLogs.get('Late'))).includes('body\t2\t1') || late.finished,
    'actual Open service delivery before native pump block');
  assert.equal(late.finished, false, late.output);
  await entry('block-now.desktop', 'Hidden=true\nExec=/bin/true', data);
  await completed(late, 'native-open-expiry-first');
  assert.match(await text(serviceLogs.get('Late')), /reply\tlate\n/, 'actual method-return after 3500ms');
  const elapsed = Number((await text(serviceLogs.get('Late'))).match(/elapsed\t([0-9]+)/)?.[1]);
  assert.ok(elapsed >= 3000 && elapsed < 6000, 'measured actual method-return elapsed exceeds absolute deadline');
  const changed = client('rediscovery');
  await until(() => changed.output.includes('WAIT: change synthetic') || changed.finished, 'rediscovery rendezvous');
  assert.equal(changed.finished, false, changed.output);
  await writeFile(editor, '[Desktop Entry]\nType=Application\nName=Changed editor\nMimeType=application/json;\nExec=/bin/true %F\n');
  await writeFile(path.join(config, 'polly-mimeapps.list'), '[Default Applications]\ntext/plain=uri.desktop;\n');
  await entry('metadata-changed.desktop', 'Hidden=true\nExec=/bin/true', data);
  await completed(changed, 'native-document-rediscovery');
  await writeFile(path.join(config, 'mimeapps.list'), '[Default Applications]\ntext/plain=uri.desktop;\0\n');
  await completed(client('settings-error'), 'native-malformed-settings-refusal');
  await writeFile(path.join(config, 'mimeapps.list'), '');
  await completed(client('guard', { POLLY_SESSION_BUS_ADDRESS: '', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/host/bus' }),
    'native-open-host-bus-refusal');
  const shutdown = client('shutdown');
  await completed(shutdown, 'native-open-shutdown');
  assert.match(shutdown.output, /Application activation cancelled at shutdown/);
  const disconnect = client('disconnect');
  await until(async () => (await text(serviceLogs.get('Disconnect'))).includes('body\t2\t1') || disconnect.finished,
    'actual Open delivery before bus disconnect');
  assert.equal(disconnect.finished, false, disconnect.output);
  daemon.process.kill('SIGTERM');
  await completed(disconnect, 'native-open-disconnect');
  for (const [suffix] of specs) {
    const lines = (await text(serviceLogs.get(suffix))).trim().split('\n');
    const expected = suffix === 'Timeout' ? 10 : 1;
    assert.equal(lines.filter(line => line.startsWith('started\t')).length, 1, suffix + ': real one-time auto-start');
    assert.equal(lines.filter(line => line.startsWith('call\t')).length, expected, suffix + ': no automatic replay/fallback');
    assert.deepEqual(lines.filter(line => line.startsWith('call\t')), Array(expected).fill(
      'call\t/org/pollyui/DocumentFixture/' + suffix + '\torg.freedesktop.Application\tOpen\tasa{sv}\t1'));
    assert.deepEqual(lines.filter(line => line.startsWith('uri\t')),
      Array.from({ length: expected }, () => uris.map(uri => 'uri\t' + uri)).flat(), suffix + ': exact URI data');
    assert.deepEqual(lines.filter(line => line.startsWith('body\t')), Array(expected).fill('body\t2\t1'),
      suffix + ': standard empty platform data and no FD inputs');
  }
  passed = true;
  console.log('PASS: newly built actual local MIME/default/Exec and bounded standard document Open');
} finally {
  for (const state of states) if (!state.finished) state.process.kill('SIGTERM');
  const cleanup = setTimeout(() => {
    for (const state of states) if (!state.finished) state.process.kill('SIGKILL');
  }, 2000);
  try { await Promise.all(states.map(state => state.closed)); } finally { clearTimeout(cleanup); }
  await writeFile(path.join(root, 'daemon.log'), daemon.output);
  await writeFile(path.join(root, 'fixture-result.json'), JSON.stringify({ complete: passed, mode: 'rebuilt-native-only',
    runtime, service, helper, runtimeRoot: root, evidence,
    children: states.map(state => ({ pid: state.process.pid, code: state.code, signal: state.signal,
      error: state.error && String(state.error), output: state.output })) }, null, 2));
  await preserve(root, evidence);
  console.log('Evidence preserved: ' + evidence);
}
