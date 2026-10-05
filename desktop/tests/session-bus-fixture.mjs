import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const [wm, ui, helper] = process.argv.slice(2).map(value => path.resolve(value));
const root = await mkdtemp(path.join(tmpdir(), 'polly bus,'));
const children = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, description) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { if (predicate()) return; await wait(10); }
  throw new Error('Timed out: ' + description);
}
function start(index, hold = true) {
  const child = spawn('sh', ['desktop/tools/run-session.sh', '--headless', wm, ui,
    'desktop/tests/session-bus-client.mjs', helper, ...(hold ? ['hold'] : [])], {
    env: { ...process.env, XDG_RUNTIME_DIR: path.join(root, 'run'), XDG_CONFIG_HOME: path.join(root, 'config' + index),
      XDG_DATA_HOME: path.join(root, 'data' + index), XDG_CACHE_HOME: path.join(root, 'cache' + index),
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/parent/must-not-connect', POLLY_SESSION_BUS_ADDRESS: 'unix:path=/parent/must-not-connect',
      PU_RENDERER: 'raster', SDL_RENDER_DRIVER: 'software' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { child, output: '', finished: false };
  child.stdout.on('data', data => state.output += data);
  child.stderr.on('data', data => state.output += data);
  child.on('error', error => { state.error = error; state.finished = true; });
  child.on('close', (code, signal) => { state.code = code; state.signal = signal; state.finished = true; });
  children.push(state);
  return state;
}
try {
  await mkdir(path.join(root, 'run'), { mode: 0o700 });
  const first = start(1), second = start(2);
  for (const state of [first, second]) {
    await until(() => state.output.includes('PASS: launched application inherits') || state.finished, 'private bus readiness');
    assert.ifError(state.error);
    assert.match(state.output, /PASS: launched application inherits/);
    assert.doesNotMatch(state.output, /FAIL:|AddressSanitizer|LeakSanitizer/);
  }
  assert.notEqual(first.output.match(/private session bus ID ([0-9a-f]+)/)[1],
    second.output.match(/private session bus ID ([0-9a-f]+)/)[1], 'parallel sessions must not reuse a bus');
  first.child.kill('SIGTERM');
  await until(() => first.finished, 'signal cleanup');
  assert.equal(first.code, 143, first.output);
  assert.equal(second.finished, false, 'stopping one session leaves the other running');
  const busPid = Number(second.output.match(/Private session bus ready \(pid (\d+)\)/)[1]);
  assert.ok(Number.isSafeInteger(busPid) && busPid > 1);
  process.kill(busPid, 'SIGTERM');
  await until(() => second.finished, 'bus loss cleanup');
  assert.equal(second.code, 1, second.output);
  assert.match(second.output, /Private session bus exited/);
  const normal = start(3, false);
  await until(() => normal.finished, 'normal session exit');
  assert.equal(normal.code, 0, normal.output);
  for (const state of children) assert.doesNotMatch(state.output, /FAIL:|AddressSanitizer|LeakSanitizer/);
  assert.deepEqual(await readdir(path.join(root, 'run')), [], 'all owned sockets and runtimes are removed');
  console.log('PASS: private D-Bus sessions, application inheritance, parent isolation, parallelism and failure cleanup');
} catch (error) {
  for (const state of children) console.error(state.output);
  throw error;
} finally {
  for (const state of children) if (!state.finished) state.child.kill('SIGTERM');
  await Promise.all(children.map(state => until(() => state.finished, 'owned child cleanup')));
  await rm(root, { recursive: true, force: true });
}
