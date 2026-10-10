import { loadBindings } from './sysrt/sdk/js/native.mjs';

const native = loadBindings({ library: fixtureLibrary, functions: {
  delay: { symbol: 'sr_async_delay', result: 'i32', parameters: ['i32', 'i32'] },
} });
const result = await native.callAsync('delay', 30, 19);
if (result.value !== 19) throw new Error('Shutdown must settle the actual native outcome');
let refused = false;
try { native.callAsync('delay', 1, 1); }
catch (error) { refused = error.code === 'ERR_FFI_SHUTDOWN'; }
if (!refused) throw new Error('Shutting-down execution must reject new submissions');
native.close();
