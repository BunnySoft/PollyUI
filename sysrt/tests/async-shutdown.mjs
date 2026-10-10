import { loadBindings } from './sysrt/sdk/js/native.mjs';
import { alloc } from 'sysrt:ffi';

const native = loadBindings({ library: fixtureLibrary, functions: {
  fill: { symbol: 'sr_delay_fill', result: 'i32', parameters: ['pointer', 'size', 'u8', 'i32'] },
} });
const data = alloc(8);
const result = await native.callAsync('fill', data, 8, 19, 30);
if (result.value !== 8 || new Uint8Array(data.read(8)).some(value => value !== 19))
  throw new Error('Shutdown must settle the actual native outcome and return borrowed memory');
let refused = false;
try { native.callAsync('fill', data, 8, 1, 1); }
catch (error) { refused = error.code === 'ERR_FFI_SHUTDOWN'; }
if (!refused) throw new Error('Shutting-down execution must reject new submissions');
native.close();
data.close();
