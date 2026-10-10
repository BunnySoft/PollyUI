import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const [runtime, fixture] = process.argv.slice(2).map(path => resolve(path));
const temporary = await mkdtemp(join(tmpdir(), 'polly-ffi-async-'));
try {
  const source = `
import { loadBindings } from './sysrt/sdk/js/native.mjs';
const native = loadBindings({ library: ${JSON.stringify(fixture)}, functions: {
  reset: { symbol: 'sr_gate_reset', result: 'void', parameters: [] },
  release: { symbol: 'sr_gate_release', result: 'void', parameters: [] },
  wait: { symbol: 'sr_gate_wait', result: 'i32', parameters: ['i32'] },
}});
native.call('reset');
let timer = false;
const pending = native.callAsync('wait', 41);
setTimeout(() => { timer = true; native.call('release'); }, 1);
const result = await pending;
if (!timer || result.value !== 41) throw new Error('Native work blocked the owning VM timer/event loop');
native.close();
console.log('PASS: native worker and JS timer/dispatcher/Promise closed loop');
`;
  const script = join(temporary, 'ui.mjs');
  await writeFile(script, source);
  const env = { ...process.env, PU_TEST_STORAGE: join(temporary, 'storage.dat') };
  const run = spawnSync(runtime, ['--test', script], { encoding: 'utf8', env, timeout: 10000 });
  const output = run.stdout + run.stderr;
  assert.equal(run.error, undefined, String(run.error));
  assert.equal(run.status, 0, output);
  assert.match(output, /PASS: native worker and JS timer/);
  assert.doesNotMatch(output, /Uncaught|AddressSanitizer|LeakSanitizer|without stopping/);
} finally { await rm(temporary, { recursive: true }); }
