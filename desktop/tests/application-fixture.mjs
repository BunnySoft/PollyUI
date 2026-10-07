import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const [runtime, helper] = process.argv.slice(2).map(value => path.resolve(value));
assert.ok(runtime && helper);
const root = await mkdtemp(path.join(tmpdir(), 'polly-applications-'));
const user = path.join(root, 'user'), system = path.join(root, 'system'), work = path.join(root, 'work space');
const echo = path.join(root, 'echo.bin'), result = path.join(root, 'exit.bin');
const quote = value => '"' + value.replaceAll('\\', '\\\\\\\\').replaceAll('"', '\\\\"') + '"';
const entry = extra => '[Desktop Entry]\nType=Application\nName=Example\n' + extra;
async function run(mode, output) {
  const child = spawn(runtime, ['--desktop', '--app-id', 'org.pollyui.app-test',
    'desktop/tests/application-client.mjs', mode, helper, output, work], {
    env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_RENDER_DRIVER: 'software', PU_RENDERER: 'raster',
      WAYLAND_DISPLAY: 'polly-test-display', WAYLAND_SOCKET: '3', DISPLAY: ':host',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/host/bus', SDL_APP_ID: 'must-not-leak',
      POLLY_SESSION_BUS_ADDRESS: '',
      XDG_RUNTIME_DIR: root, XDG_DATA_HOME: user, XDG_DATA_DIRS: system,
      XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache'), LC_ALL: 'zh_CN.UTF-8' },
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  });
  let text = '';
  child.stdout.on('data', data => { text += data; });
  child.stderr.on('data', data => { text += data; });
  child.stdio[3].on('error', error => {
    assert.ok(['EPIPE', 'ECONNRESET'].includes(error.code), 'Unexpected canary pipe error: ' + error);
  });
  child.stdio[3].end('fixture descriptor must not reach launched applications');
  const timer = setTimeout(() => child.kill('SIGKILL'), 12000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('close', resolve);
    });
    assert.equal(code, 0, text);
    assert.doesNotMatch(text, /FAIL:|AddressSanitizer|runtime error:/);
  } catch (error) { console.error(text); throw error; }
  finally { clearTimeout(timer); }
}
try {
  await mkdir(path.join(user, 'applications'), { recursive: true });
  await mkdir(path.join(system, 'applications', 'Utilities'), { recursive: true });
  await mkdir(work);
  await writeFile(path.join(work, 'broken-program'), '#!/nonexistent/polly-interpreter\n');
  await chmod(path.join(work, 'broken-program'), 0o755);
  await writeFile(path.join(user, 'applications', 'hidden.desktop'), entry('Hidden=true\nExec=/bin/true\n'));
  await writeFile(path.join(system, 'applications', 'hidden.desktop'), entry('Exec=/bin/true\n'));
  await writeFile(path.join(system, 'applications', 'Utilities', 'tool.desktop'), entry('Exec=/bin/true\n'));
  await writeFile(path.join(system, 'applications', 'org.pollyui.Bus.desktop'), entry('DBusActivatable=true\n'));
  const desktopFile = path.join(user, 'applications', 'echo.desktop');
  await writeFile(desktopFile, entry(`Name[zh_CN]=本地化 %u\nPath=${work}\nExec=${quote(helper)} ${quote(echo)} %c %k %% %f "two words"\n`));
  await run('launch', result);
  const values = (await readFile(echo)).toString('utf8').split('\0').slice(0, -1);
  assert.deepEqual(values, ['本地化 %u', desktopFile, '%', 'two words', work, 'polly-test-display']);
  assert.equal((await readFile(result)).toString('utf8').split('\0')[0], '--exit23');
  const later = path.join(root, 'later.bin');
  await run('survive', later);
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal((await readFile(later)).toString('utf8').split('\0')[0], '--later');
  console.log('PASS: native desktop discovery, argv/cwd, descriptor/environment isolation, exit reporting and child survival');
} finally {
  await rm(root, { recursive: true, force: true });
}
