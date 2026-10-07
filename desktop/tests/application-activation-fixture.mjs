import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, unlink, chmod, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const [runtimeArgument, serviceArgument, evidenceArgument] = process.argv.slice(2);
assert.ok(runtimeArgument && serviceArgument, 'Usage: fixture POLLYUI|--probe SERVICE [EVIDENCE_DIRECTORY]');
const probe = runtimeArgument === '--probe', runtime = probe ? null : path.resolve(runtimeArgument);
const service = path.resolve(serviceArgument), evidence = path.resolve(evidenceArgument || tmpdir());
await mkdir(evidence, { recursive: true });
// AF_UNIX sockets need a Linux filesystem, not a Windows-mounted evidence directory.
const root = await mkdtemp(path.join(tmpdir(), 'polly-activation-'));
const saved = path.join(evidence, 'saved-' + path.basename(root));
const run = path.join(root, 'run'), services = path.join(root, 'services');
const data = path.join(root, 'data'), system = path.join(root, 'system');
await Promise.all([mkdir(run, { mode: 0o700 }), mkdir(services), mkdir(path.join(data, 'applications'), { recursive: true }),
  mkdir(path.join(system, 'applications'), { recursive: true })]);
const address = 'unix:path=' + path.join(run, 'bus');
const env = { ...process.env, HOME: root, XDG_RUNTIME_DIR: run,
  XDG_DATA_HOME: data, XDG_DATA_DIRS: system, XDG_CONFIG_HOME: path.join(root, 'config'),
  XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'state'),
  DBUS_SESSION_BUS_ADDRESS: address, POLLY_SESSION_BUS_ADDRESS: address,
  DBUS_STARTER_ADDRESS: '', DBUS_STARTER_BUS_TYPE: '', WAYLAND_SOCKET: '', WAYLAND_DISPLAY: 'synthetic-activation',
  SDL_VIDEODRIVER: 'dummy', SDL_RENDER_DRIVER: 'software', PU_RENDERER: 'raster', LC_ALL: 'C' };
const states = [], wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function child(program, args, overrides = {}) {
  const process = spawn(program, args, { env: { ...env, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { process, output: '', finished: false, error: null };
  process.stdout.on('data', bytes => { state.output += bytes; });
  process.stderr.on('data', bytes => { state.output += bytes; });
  state.closed = new Promise(resolve => {
    process.once('error', error => { state.error = error; });
    process.once('close', (code, signal) => { state.finished = true; state.code = code; state.signal = signal; resolve(); });
  });
  states.push(state);
  return state;
}
async function until(predicate, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await wait(10); }
  throw new Error('Timed out: ' + message);
}
async function completed(state, label, limit = 15000) {
  const timer = setTimeout(() => state.process.kill('SIGKILL'), limit);
  try { await state.closed; } finally { clearTimeout(timer); }
  await writeFile(path.join(root, label + '.log'), state.output);
  assert.ifError(state.error);
  assert.equal(state.code, 0, label + '\n' + state.output);
  assert.doesNotMatch(state.output, /FAIL:|AddressSanitizer|LeakSanitizer|runtime error:/);
  console.log('PASS: ' + label);
}
const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const quote = value => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
const specs = [
  ['org.pollyui.Activation-fixture', 'slow-ack'], ['org.pollyui.ActivationFixture.Wrong', 'wrong'],
  ['org.pollyui.ActivationFixture.Error', 'error'], ['org.pollyui.ActivationFixture.Malformed', 'malformed'],
  ['org.pollyui.ActivationFixture.StartFailure', 'start-failure'], ['org.pollyui.ActivationFixture.Oversized', 'oversized'],
  ['org.pollyui.ActivationFixture.Timeout', 'timeout'], ['org.pollyui.ActivationFixture.Disconnect', 'disconnect'],
];
const logs = new Map();
for (const [name, mode] of specs) {
  const object = '/' + name.replaceAll('.', '/').replaceAll('-', '_');
  const log = path.join(root, name + '.service.log');
  logs.set(name, log);
  await writeFile(path.join(services, name + '.service'),
    '[D-BUS Service]\nName=' + name + '\nExec=' + [service, name, object, log, mode].map(quote).join(' ') + '\n');
}
function entry(name, extra = '', directory = system) {
  const id = name.includes('.') ? name + '.desktop' : 'org.pollyui.ActivationFixture.' + name + '.desktop';
  return writeFile(path.join(directory, 'applications', id),
    '[Desktop Entry]\nType=Application\nName=' + name + '\nDBusActivatable=true\n' + extra);
}
await Promise.all([...specs.map(([name]) => entry(name)), entry('Missing'), entry('Deleted'), entry('Masked'),
  entry('Nul', 'Comment=bad\0value\n')]);
await writeFile(path.join(system, 'applications', 'org.pollyui.ActivationFixture.BadBool.desktop'),
  '[Desktop Entry]\nType=Application\nName=Bad bool\nDBusActivatable=maybe\n');
const config = path.join(root, 'bus.conf');
await writeFile(config, '<busconfig><type>session</type><listen>' + xml(address) +
  '</listen><auth>EXTERNAL</auth><servicedir>' + xml(services) + '</servicedir>' +
  '<policy context="default"><allow own_prefix="org.pollyui"/><allow send_destination="*"/><allow receive_sender="*"/></policy>' +
  '<limit name="service_start_timeout">2000</limit><limit name="max_completed_connections">32</limit></busconfig>\n');
const daemon = child('dbus-daemon', ['--nofork', '--config-file=' + config, '--print-address=1', '--print-pid=1']);
async function client(mode, overrides = {}) {
  assert.ok(!probe);
  return child(runtime, ['--desktop', '--app-id', 'org.pollyui.activation-test',
    'desktop/tests/application-activation-client.mjs', mode], overrides);
}
async function contents(file) {
  try { return await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}
async function preserve(directory, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const source = path.join(directory, entry.name), target = path.join(destination, entry.name);
    if (entry.isDirectory()) await preserve(source, target);
    // Windows-mounted evidence can accept bytes but not copyFile's Unix metadata operations.
    else if (entry.isFile()) await writeFile(target, await readFile(source));
    else if (!entry.isSocket()) throw new Error('Unexpected synthetic fixture evidence type: ' + source);
  }
}
let passed = false;
try {
  await until(() => daemon.output.includes('guid=') || daemon.finished, 'isolated daemon readiness');
  assert.equal(daemon.finished, false, daemon.output);
  env.DBUS_SESSION_BUS_ADDRESS = env.POLLY_SESSION_BUS_ADDRESS = daemon.output.split('\n')[0].trim();
  assert.match(env.DBUS_SESSION_BUS_ADDRESS, /^unix:path=/);
  const guards = [
    ['missing-owned', { POLLY_SESSION_BUS_ADDRESS: '', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/host/bus' }],
    ['matching-fake-host', { POLLY_SESSION_BUS_ADDRESS: 'unix:path=/host/bus', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/host/bus' }],
    ['mismatched-host', { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/host/bus' }],
    ['missing-runtime', { XDG_RUNTIME_DIR: '' }], ['relative-runtime', { XDG_RUNTIME_DIR: 'relative' }],
    ['multiple-addresses', { POLLY_SESSION_BUS_ADDRESS: address + ';' + address, DBUS_SESSION_BUS_ADDRESS: address + ';' + address }],
    ['wrong-socket-path', { POLLY_SESSION_BUS_ADDRESS: address + '-other', DBUS_SESSION_BUS_ADDRESS: address + '-other' }],
  ];
  for (const [label, overrides] of guards)
    await completed(probe ? child(service, ['--guard'], overrides) : await client('guard', overrides), 'guard-' + label);
  await chmod(run, 0o755);
  try { await completed(probe ? child(service, ['--guard']) : await client('guard'), 'guard-runtime-mode'); }
  finally { await chmod(run, 0o700); }
  if (probe) {
    for (const [name, expected] of [
      ['org.pollyui.Activation-fixture', 'ack'], ['org.pollyui.ActivationFixture.Missing', 'ServiceUnknown'],
      ['org.pollyui.ActivationFixture.Wrong', 'UnknownMethod'], ['org.pollyui.ActivationFixture.Error', 'Failed'],
      ['org.pollyui.ActivationFixture.StartFailure', 'Spawn.ChildExited'],
      ['org.pollyui.ActivationFixture.Timeout', 'NoReply'],
    ]) await completed(child(service, ['--probe', name, '/' + name.replaceAll('.', '/').replaceAll('-', '_'), expected]),
      'probe-' + name);
  } else {
    await completed(await client('main'), 'native-main');
    await completed(await client('bounds'), 'native-queue-and-pump');
    const rediscovery = await client('rediscovery');
    await until(() => rediscovery.output.includes('WAIT: mutate') || rediscovery.finished, 'native rediscovery rendezvous');
    assert.equal(rediscovery.finished, false, rediscovery.output);
    await unlink(path.join(system, 'applications', 'org.pollyui.ActivationFixture.Deleted.desktop'));
    await entry('Masked', 'Hidden=true\n', data);
    await completed(rediscovery, 'native-rediscovery');
    const shutdown = await client('shutdown');
    await completed(shutdown, 'native-shutdown');
    assert.match(shutdown.output, /Application activation cancelled at shutdown/);
  }
  for (const [name, log] of logs) {
    const text = await contents(log);
    if (!text && probe && ['Malformed', 'Oversized', 'Disconnect'].some(suffix => name.endsWith(suffix))) continue;
    if (name.endsWith('Disconnect')) continue;
    if (name.endsWith('StartFailure')) {
      assert.match(text, /start-failed\t[0-9]+\torg.pollyui.ActivationFixture.StartFailure\n/);
      assert.doesNotMatch(text, /call\t/);
      assert.equal(text.trim().split('\n').length, 1, 'failed service activation is not automatically replayed');
      continue;
    }
    assert.match(text, new RegExp('started\\t[0-9]+\\t' + name.replaceAll('.', '\\.') + '\\n'));
    const lines = text.trim().split('\n').filter(line => line.startsWith('call\t'));
    assert.equal(lines.length, !probe && name.endsWith('Timeout') ? 10 : 1,
      name + ': exactly the requested deliveries, no automatic retry');
    for (const line of lines) assert.deepEqual(line.split('\t').slice(1), [
      '/' + name.replaceAll('.', '/').replaceAll('-', '_'), 'org.freedesktop.Application', 'Activate', 'a{sv}', '1', '1',
    ], 'exact member/interface/object path/empty platform data/auto-start flag');
    assert.equal(text.split('\n').filter(line => line.startsWith('started\t')).length, 1,
      'service came from bus auto-start, not repeated manual launches');
  }
  if (!probe) {
    const disconnect = await client('disconnect');
    await until(async () => (await contents(logs.get('org.pollyui.ActivationFixture.Disconnect'))).includes('call\t') ||
      disconnect.finished, 'actual activation delivery before daemon disconnect');
    assert.equal(disconnect.finished, false, disconnect.output);
    daemon.process.kill('SIGTERM');
    await completed(disconnect, 'native-disconnect');
    const disconnectCalls = (await contents(logs.get('org.pollyui.ActivationFixture.Disconnect'))).trim().split('\n')
      .filter(line => line.startsWith('call\t'));
    assert.equal(disconnectCalls.length, 1, 'disconnect does not replay an indeterminate delivery');
    assert.deepEqual(disconnectCalls[0].split('\t').slice(1), [
      '/org/pollyui/ActivationFixture/Disconnect', 'org.freedesktop.Application', 'Activate', 'a{sv}', '1', '1',
    ]);
  }
  passed = true;
  console.log(probe ? 'PASS: isolated daemon/service infrastructure only; product native API is NOT verified' :
    'PASS: rebuilt native activation, actual auto-start, strict guards, errors, bounds, rediscovery and shutdown');
} finally {
  for (const state of states) if (!state.finished) state.process.kill('SIGTERM');
  await Promise.all(states.map(state => state.closed));
  await writeFile(path.join(root, 'daemon.log'), daemon.output);
  await writeFile(path.join(root, 'fixture-result.json'), JSON.stringify({
    complete: passed, runtimeRoot: root, evidence: saved, mode: probe ? 'infrastructure-probe-NOT-product-native' : 'rebuilt-native',
    children: states.map(state => ({ pid: state.process.pid, code: state.code, signal: state.signal, output: state.output })),
  }, null, 2));
  await preserve(root, saved);
  console.log('Evidence preserved: ' + saved);
}
