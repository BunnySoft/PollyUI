import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const gitName = process.platform === 'win32' ? 'git.exe' : 'git';
const git = (process.env.PATH || '').split(path.delimiter)
  .map(directory => path.join(directory.replace(/^"|"$/g, ''), gitName)).find(existsSync);
assert.ok(git, 'Git is required to verify actual build identity');

test('runtime identity follows actual clean/dirty Git state and version changes without reconfiguration', () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'polly-build-info-'));
  try {
    const source = path.join(temporary, 'source'), output = path.join(temporary, 'generated', 'identity.h');
    const launcher = path.join(source, 'desktop', 'launcher'), version = path.join(source, 'desktop', 'VERSION');
    mkdirSync(launcher, { recursive: true });
    copyFileSync(path.join(repo, 'desktop', 'launcher', 'build-info.h.in'), path.join(launcher, 'build-info.h.in'));
    writeFileSync(version, '0.1.0-alpha.6\n');
    const runGit = args => execFileSync(git, args, { cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    runGit(['init', '-q']);
    runGit(['add', '--', 'desktop']);
    runGit(['-c', 'user.name=Runtime fixture', '-c', 'user.email=runtime@pollyui.invalid',
      '-c', 'core.hooksPath=' + path.join(temporary, 'no-hooks'),
      'commit', '--no-gpg-sign', '-qm', 'Build identity fixture']);
    const revision = runGit(['rev-parse', 'HEAD']);
    const generate = (executable = git) => {
      const result = spawnSync('cmake', [`-DSOURCE_ROOT=${source}`, `-DOUTPUT_FILE=${output}`,
        `-DGIT_EXECUTABLE=${executable}`, '-P', path.join(repo, 'desktop', 'launcher', 'build-info.cmake')],
      { encoding: 'utf8', timeout: 10000 });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return readFileSync(output, 'utf8');
    };
    let header = generate();
    assert.ok(header.includes(`PU_RUNTIME_REVISION "${revision}"`));
    assert.match(header, /PU_RUNTIME_VERSION "0\.1\.0-alpha\.6"/);
    assert.match(header, /PU_RUNTIME_SOURCE_DIRTY 0\b/);
    writeFileSync(version, '0.1.0-alpha.7\n');
    header = generate();
    assert.match(header, /PU_RUNTIME_VERSION "0\.1\.0-alpha\.7"/);
    assert.match(header, /PU_RUNTIME_SOURCE_DIRTY 1\b/);
    assert.ok(header.includes(`PU_RUNTIME_REVISION "${revision}"`));
    writeFileSync(version, '0.1.0-alpha.6\n');
    assert.match(generate(), /PU_RUNTIME_SOURCE_DIRTY 0\b/);
    header = generate('');
    assert.match(header, /PU_RUNTIME_REVISION "unknown"/);
    assert.match(header, /PU_RUNTIME_SOURCE_DIRTY -1\b/);
    writeFileSync(version, 'not a release version\n');
    const invalid = spawnSync('cmake', [`-DSOURCE_ROOT=${source}`, `-DOUTPUT_FILE=${output}`,
      `-DGIT_EXECUTABLE=${git}`, '-P', path.join(repo, 'desktop', 'launcher', 'build-info.cmake')],
    { encoding: 'utf8', timeout: 10000 });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /Invalid runtime version/);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
