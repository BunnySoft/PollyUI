import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const build = path.resolve(process.argv[2]);
const temporary = mkdtempSync(path.join(tmpdir(), 'polly install,'));
try {
  const root = path.join(temporary, 'staged');
  execFileSync('cmake', ['--install', build, '--prefix', '/usr', '--component', 'PollyDesktop'],
    { env: { ...process.env, DESTDIR: root }, timeout: 20000, stdio: 'pipe' });
  const program = path.join(root, 'usr/bin/polly-desktop');
  const libraries = execFileSync('ldd', [path.join(root, 'usr/bin/pollyui')], { encoding: 'utf8' });
  assert.ok(libraries.includes(root + '/usr/bin/../lib/pollyui/libSDL3.so.0'), libraries);
  assert.doesNotMatch(libraries, /lib(?:glib|gio|gobject)-2\.0|libharfbuzz/);
  for (const renderer of ['raster', 'gl']) {
    const runtime = path.join(temporary, renderer);
    mkdirSync(runtime, { mode: 0o700 });
    const result = spawnSync(program, ['--headless', '--audio', '--check',
      ...(process.argv[3] === '--ime' ? ['--ime'] : [])], {
      cwd: tmpdir(), encoding: 'utf8', timeout: 40000,
      env: { ...process.env, PU_RENDERER: renderer, SDL_RENDER_DRIVER: 'software',
        XDG_RUNTIME_DIR: runtime, XDG_CONFIG_HOME: path.join(temporary, 'config'),
        XDG_DATA_HOME: path.join(temporary, 'data'), XDG_CACHE_HOME: path.join(temporary, 'cache') },
    });
    const log = result.stdout + result.stderr;
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.status, 0, log);
    assert.match(log, /PASS: installed PollyDesktop session ready/);
    assert.doesNotMatch(log, /AddressSanitizer|LeakSanitizer|Failed to create|SDL_Init failed/);
    assert.deepEqual(readdirSync(runtime), [], 'installed session removes owned runtimes');
  }
  const invalid = spawnSync(program, ['--unknown-option'], { encoding: 'utf8' });
  assert.equal(invalid.status, 2);
  const help = execFileSync(program, ['--help'], { encoding: 'utf8' });
  assert.match(help, /--check/);
  console.log('PASS: relocated installation, private SDL, raster/GLES startup and cleanup');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
