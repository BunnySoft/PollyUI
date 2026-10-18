import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const executable = process.argv[2];
assert.ok(executable, 'Pass the current GUI executable');
const run = (value, script) => {
  const env = { ...process.env, PU_RENDERER: 'raster' };
  if (value === undefined) delete env.POLLY_EXPERIMENTAL_LAYOUT;
  else env.POLLY_EXPERIMENTAL_LAYOUT = value;
  const result = spawnSync(executable, ['--test', script], {
    cwd: root, env, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null);
  return result;
};
for (const value of [undefined, '0', '1']) {
  const result = run(value, value === '1' ?
    'gui/tests/layout-pixel-grid.js' : 'gui/tests/layout-pixel-grid-legacy.mjs');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /FAIL:|Uncaught/);
  assert.match(result.stdout, value === '1' ? /generic pixel-grid percent-max/ : /legacy pixel-grid percent-max/);
  console.log('PASS: native startup layout=' + (value ?? 'unset') + ' selects ' +
    (value === '1' ? 'coherent' : 'legacy'));
}
for (const value of ['', '2', '-1', 'true', 'false', '01', ' 1', '1 ']) {
  const result = run(value, 'gui/tests/layout-pixel-grid.js');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /\[layout\] POLLY_EXPERIMENTAL_LAYOUT must be unset, 0 or 1/);
  assert.doesNotMatch(result.stdout, /PASS:/, 'Invalid selection must fail before script/layout execution');
}
console.log('PASS: empty/nonbinary layout selections fail native startup explicitly; no silent fallback');
