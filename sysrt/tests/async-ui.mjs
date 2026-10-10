import assert from 'node:assert/strict';
import { mkdtemp, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const [runtime, fixture] = process.argv.slice(2).map(path => resolve(path));
const temporary = await mkdtemp(join(tmpdir(), 'polly-ffi-async-'));
try {
  const exclusive = join(temporary, 'exclusive-' + basename(fixture));
  await copyFile(fixture, exclusive);
  const source = `
import { loadBindings } from './sysrt/sdk/js/native.mjs';
import { alloc, open } from 'sysrt:ffi';
const native = loadBindings({ library: ${JSON.stringify(fixture)}, functions: {
  reset: { symbol: 'sr_gate_reset', result: 'void', parameters: [] },
  release: { symbol: 'sr_gate_release', result: 'void', parameters: [] },
  fill: { symbol: 'sr_gate_fill', result: 'i32', parameters: ['pointer', 'size', 'u8'] },
}});
native.call('reset');
let timer = false;
const data = alloc(8);
const pending = native.callAsync('fill', data, 8, 41);
let busy = false;
try { data.read(8); } catch (error) { busy = error.code === 'ERR_FFI_BUSY'; }
setTimeout(() => { timer = true; native.call('release'); }, 1);
const result = await pending;
if (!timer || !busy || result.value !== 8 || new Uint8Array(data.read(8)).some(value => value !== 41))
  throw new Error('Native buffer work blocked the VM or did not return its memory loan');
data.close();
const library = open(${JSON.stringify(exclusive)});
let fill = library.bind('sr_delay_fill', { result: 'i32', parameters: ['pointer', 'size', 'u8', 'i32'] });
let owned = alloc(8);
const finishing = fill.callAsync(owned, 8, 7, 30);
fill.close(); library.close(); owned.close();
fill = owned = null;
if ((await finishing).value !== 8) throw new Error('Accepted work lost its exclusive DLL or closed allocation');
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
