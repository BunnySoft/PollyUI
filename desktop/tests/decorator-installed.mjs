import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const temporary = mkdtempSync(path.join(tmpdir(), 'polly-decorator-installed-'));
try {
  const root = path.join(temporary, 'staged');
  execFileSync('cmake', ['--install', path.resolve(process.argv[2]), '--prefix', '/usr', '--component', 'PollyDesktop'],
    { env: { ...process.env, DESTDIR: root }, timeout: 30000, stdio: 'pipe' });
  const entry = path.join(root, 'usr/bin/polly-desktop');
  const launcher = path.join(root, 'usr/share/pollyui/desktop/tools/run-decorator.sh');
  function run(name) {
    const runtime = path.join(temporary, name);
    mkdirSync(runtime, { mode: 0o700 });
    const result = spawnSync(entry, ['--headless', '--check'], {
      cwd: tmpdir(), encoding: 'utf8', timeout: 30000,
      env: { ...process.env, PU_RENDERER: 'raster', SDL_RENDER_DRIVER: 'software',
        XDG_RUNTIME_DIR: runtime, XDG_CONFIG_HOME: path.join(temporary, 'config'),
        XDG_DATA_HOME: path.join(temporary, 'data'), XDG_CACHE_HOME: path.join(temporary, 'cache') },
    });
    assert.equal(result.error, undefined);
    assert.deepEqual(readdirSync(runtime), [], 'relocated wrapper cleans its private runtime');
    return { status: result.status, log: result.stdout + result.stderr };
  }
  const ready = run('ready');
  assert.equal(ready.status, 0, ready.log);
  assert.match(ready.log, /Independent windowless GUI renderer ready/);
  assert.match(ready.log, /\[health\] shell=ready decorations=ready ime=disabled audio=disabled/);
  assert.match(ready.log, /PASS: installed PollyDesktop session ready/);
  assert.doesNotMatch(ready.log, /Uncaught|did not exit|restart budget exhausted|Cannot start decorator/);
  const preferences = path.join(temporary, 'config/pollyui/org.pollyui.shell/shell-preferences.json');
  const configuration = readFileSync(preferences);
  assert.equal(JSON.parse(configuration).version, 2);
  for (const area of ['config', 'data', 'cache']) {
    const children = readdirSync(path.join(temporary, area, 'pollyui'));
    assert.ok(!children.includes('org.pollyui.decorator'), 'decorator creates no ' + area + ' store');
  }
  renameSync(launcher, launcher + '.unavailable');
  const unavailable = run('unavailable');
  assert.equal(unavailable.status, 1, unavailable.log);
  assert.match(unavailable.log, /Cannot start decorator/);
  assert.doesNotMatch(unavailable.log, /PASS: installed PollyDesktop session ready/);
  assert.deepEqual(readFileSync(preferences), configuration, 'failed service launch cannot alter saved preferences');
  console.log('PASS: relocated installed entry launches independent service, reports readiness and fails closed without its launcher');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
