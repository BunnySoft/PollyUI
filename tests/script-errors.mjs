import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = mkdtempSync(path.join(tmpdir(), 'polly-module-errors-'));
try {
  const cases = [
    ['sync', 'throw new Error("module-sync");', 1, /module-sync/],
    ['async', 'await Promise.resolve(); throw new Error("module-async");', 1, /module-async/],
    ['pending', 'await new Promise(() => {});', 1, /did not complete/],
    ['success', 'await new Promise(resolve => setTimeout(resolve, 1)); console.log("module-complete");', 0, /module-complete/],
  ];
  for (const [name, source, expected, message] of cases) {
    const file = path.join(root, name + '.mjs');
    writeFileSync(file, source);
    const result = spawnSync(path.resolve(process.argv[2]), ['--test', file], {
      encoding: 'utf8', timeout: 10000, env: { ...process.env, PU_TEST_STORAGE: path.join(root, 'storage') },
    });
    assert.ifError(result.error);
    assert.equal(result.status, expected, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, message);
  }
  console.log('PASS: rejected and unfinished modules cannot report successful execution');
} finally { rmSync(root, { recursive: true, force: true }); }
