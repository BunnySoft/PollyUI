import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, readFileSync, writeFileSync, existsSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const build = path.resolve(process.argv[2]);
const temporary = mkdtempSync(path.join(tmpdir(), 'polly install,'));
try {
  const root = path.join(temporary, 'staged');
  execFileSync('cmake', ['--install', build, '--prefix', '/usr', '--component', 'PollyDesktop'],
    { env: { ...process.env, DESTDIR: root }, timeout: 20000, stdio: 'pipe' });
  const program = path.join(root, 'usr/bin/polly-desktop');
  const manager = path.join(root, 'usr/bin/polly-app');
  if (existsSync(manager)) {
    chmodSync(temporary, 0o755);
    const output = execFileSync('python3', [fileURLToPath(new URL('./bundle-manager.py', import.meta.url)),
      manager, path.join(root, 'usr/bin/pollyui')], {
      encoding: 'utf8', timeout: 30000,
    });
    assert.match(output, /native manager installs, validates, replaces and rolls back/);
  }
  const imeEnabled = process.argv[3] === '--ime';
  const libraries = execFileSync('ldd', [path.join(root, 'usr/bin/pollyui')], { encoding: 'utf8' });
  assert.ok(libraries.includes(root + '/usr/bin/../lib/pollyui/libSDL3.so.0'), libraries);
  assert.doesNotMatch(libraries, /lib(?:glib|gio|gobject)-2\.0|libharfbuzz/);
  for (const renderer of ['raster', 'gl']) {
    const runtime = path.join(temporary, renderer);
    mkdirSync(runtime, { mode: 0o700 });
    const result = spawnSync(program, ['--headless', '--audio', '--check',
      ...(imeEnabled ? ['--ime'] : [])], {
      cwd: tmpdir(), encoding: 'utf8', timeout: 40000,
      env: { ...process.env, PU_RENDERER: renderer, SDL_RENDER_DRIVER: 'software',
        XDG_RUNTIME_DIR: runtime, XDG_CONFIG_HOME: path.join(temporary, 'config'),
        XDG_DATA_HOME: path.join(temporary, 'data'), XDG_CACHE_HOME: path.join(temporary, 'cache') },
    });
    const log = result.stdout + result.stderr;
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.status, 0, log);
    assert.match(log, /PASS: installed PollyDesktop session ready/);
    assert.doesNotMatch(log, /AddressSanitizer|LeakSanitizer|Uncaught|did not exit|Failed to create|SDL_Init failed/);
    assert.match(log, /\[health\] shell=ready ime=(ready|disabled) audio=ready/);
    if (imeEnabled) {
      assert.ok(log.indexOf('Input-method engine and protocol initialized') >= 0, log);
      assert.ok(result.stdout.indexOf('ime=ready audio=ready') <
        result.stdout.indexOf('PASS: installed PollyDesktop session ready'), log);
    }
    assert.deepEqual(readdirSync(runtime), [], 'installed session removes owned runtimes');
    const config = path.join(temporary, 'config/pollyui/org.pollyui.shell/shell-preferences.json');
    assert.equal(JSON.parse(readFileSync(config, 'utf8')).version, 1);
    assert.equal(statSync(config).mode & 0o777, 0o600);
    writeFileSync(path.join(temporary, 'data/pollyui/org.pollyui.shell/localstorage.dat'),
      'Corrupt old storage must not block the next installed Shell start', { mode: 0o600 });
  }
  const invoke = (name, extra = [], environment = {}) => {
    const runtime = path.join(temporary, name);
    mkdirSync(runtime, { mode: 0o700 });
    const result = spawnSync(program, ['--headless', '--check', ...extra], {
      cwd: tmpdir(), encoding: 'utf8', timeout: 40000,
      env: { ...process.env, PU_RENDERER: 'raster', SDL_RENDER_DRIVER: 'software',
        XDG_RUNTIME_DIR: runtime, XDG_CONFIG_HOME: path.join(temporary, name + '-config'),
        XDG_DATA_HOME: path.join(temporary, name + '-data'), XDG_CACHE_HOME: path.join(temporary, name + '-cache'),
        ...environment },
    });
    assert.equal(result.error, undefined, String(result.error));
    assert.deepEqual(readdirSync(runtime), [], name + ': diagnostic cleanup');
    return { status: result.status, log: result.stdout + result.stderr };
  };
  const optional = invoke('optional');
  assert.equal(optional.status, 0, optional.log);
  assert.match(optional.log, /shell=ready ime=disabled audio=disabled/);
  if (imeEnabled) {
    const launcher = path.join(root, 'usr/share/pollyui/desktop/tools/run-input-method.sh');
    const original = readFileSync(launcher, 'utf8').replace(/\r\n/g, '\n');
    writeFileSync(launcher, original.replace('set -eu\n', 'set -eu\nsleep 2\n'));
    const delayed = invoke('delayed', ['--ime']);
    assert.equal(delayed.status, 0, delayed.log);
    assert.match(delayed.log, /\[health\].*ime=starting/);
    assert.match(delayed.log, /\[health\].*ime=ready/);
    assert.ok(delayed.log.indexOf('ime=ready audio=disabled') <
      delayed.log.indexOf('PASS: installed PollyDesktop session ready'), delayed.log);
    assert.doesNotMatch(delayed.log, /Uncaught|did not exit|FAIL:/);
    writeFileSync(launcher, original);
    const failed = invoke('failed', ['--ime'], { POLLY_IME_SCHEMA: 'polly_nonexistent_schema' });
    assert.equal(failed.status, 1, failed.log);
    assert.match(failed.log, /input method failed or disconnected/);
    assert.doesNotMatch(failed.log, /PASS: installed PollyDesktop session ready/);
    writeFileSync(launcher, '#!/bin/sh\nexec sleep 60\n');
    const stalled = invoke('stalled', ['--ime']);
    assert.equal(stalled.status, 1, stalled.log);
    assert.match(stalled.log, /Session readiness deadline exceeded:.*ime=starting/);
    assert.doesNotMatch(stalled.log, /PASS: installed PollyDesktop session ready/);
    writeFileSync(launcher, original);
  }
  const retry = spawnSync(program, ['--headless', '--check', '--restarts', '2'], { encoding: 'utf8' });
  assert.equal(retry.status, 2, retry.stdout + retry.stderr);
  const invalid = spawnSync(program, ['--unknown-option'], { encoding: 'utf8' });
  assert.equal(invalid.status, 2);
  const help = execFileSync(program, ['--help'], { encoding: 'utf8' });
  assert.match(help, /--check/);
  console.log('PASS: relocated startup waits for enabled services, fails closed and cleans up on every outcome');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
