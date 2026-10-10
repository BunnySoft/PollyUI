import { open, alloc, allocPointers, callback, callbacks, platform } from 'sysrt:ffi';
import { createCallback, loadBindings } from './sysrt/sdk/js/native.mjs';

function check(value, message) { if (!value) throw new Error(message); }
function refuses(action, code) {
  try { action(); } catch (error) {
    if (code) check(error?.code === code, 'Expected ' + code + ', received ' + error);
    return error;
  }
  throw new Error('Missing callback refusal: ' + code);
}
check(callbacks === true && createCallback === callback, 'SDK exposes the native callback capability');
const signature = { result: 'i32', parameters: ['i32'] };
const api = loadBindings({ library: fixtureLibrary, functions: {
  run: { symbol: 'sr_callback_i32', result: 'i32', parameters: ['callback', 'i32', 'i32'] },
  visits: { symbol: 'sr_callback_visits', result: 'i32', parameters: [] },
  i8: { symbol: 'sr_callback_i8', result: 'i8', parameters: ['callback', 'i8'] },
  i64: { symbol: 'sr_callback_i64', result: 'i64', parameters: ['callback', 'i64'] },
  mixed: { symbol: 'sr_callback_mixed', result: 'double', parameters: ['callback'] },
  void: { symbol: 'sr_callback_void', result: 'void', parameters: ['callback', 'i32'] },
  error: { symbol: 'sr_callback_error', result: 'i32', parameters: ['callback'] },
  wrongThread: { symbol: 'sr_callback_thread', result: 'i32', parameters: ['callback'] },
  setError: { symbol: 'sr_error', result: 'i32', parameters: ['i32'] },
}});
let count = 0;
const sum = createCallback(signature, value => { count++; return value * 2; });
check(api.call('run', sum, 7, 3).value === 48 && count === 3, 'Native code synchronously reenters JS through libffi');
collect();
check(api.call('run', sum, 1, 1).value === 2, 'Callback handle survives GC between separate native scopes');
refuses(() => api.callAsync('run', sum, 1, 1), 'ERR_FFI_ASYNC');
refuses(() => api.call('run', sum, 1, 'bad'));
check(api.call('run', sum, 1, 1).value === 2, 'Argument refusal releases partially prepared closures');
refuses(() => api.call('run', () => 0, 1, 1));
refuses(() => api.call('run', foreignObject, 1, 1));
refuses(() => Object.getPrototypeOf(sum).close.call(foreignObject));
refuses(() => allocPointers([sum]));
refuses(() => callback(signature, 1));
for (const unsupported of [
  { result: 'pointer', parameters: [] }, { result: 'cstring', parameters: [] },
  { result: 'callback', parameters: [] }, { result: 'i32', parameters: ['pointer'] },
  { result: 'i32', parameters: ['cstring'] }, { result: 'i32', parameters: ['callback'] },
  { ...signature, variadic: 1 }, { ...signature, clearErrors: false },
  Object.assign(Object.create({ variadic: 1 }), signature),
])
  refuses(() => callback(unsupported, () => 0), 'ERR_FFI_CALLBACK_SIGNATURE');
for (const unsupported of [
  { ...signature, abi: 'stdcall' }, { result: 'record', parameters: [] },
  { result: 'i32', parameters: ['void'] }, { ...signature, async: true },
  { result: 'i32', parameters: Array(17).fill('i32') },
])
  refuses(() => callback(unsupported, () => 0));
const library = open(fixtureLibrary);
refuses(() => library.bind('sr_callback_i32',
  { result: 'i32', parameters: ['callback', 'i32', 'i32'], variadic: 1 }), 'ERR_FFI_CALLBACK_SIGNATURE');
for (const type of ['pointer', 'cstring']) {
  const unsupported = library.bind('sr_callback_i32', { result: 'i32', parameters: ['callback', type, 'i32'] });
  refuses(() => unsupported(sum, null, 1), 'ERR_FFI_CALLBACK_SIGNATURE');
  unsupported.close();
}
const pointerResult = library.bind('sr_callback_i32', { result: 'pointer', parameters: ['callback', 'i32', 'i32'] });
refuses(() => pointerResult(sum, 0, 0), 'ERR_FFI_CALLBACK_SIGNATURE');
pointerResult.close(); library.close();

let smallReturn = 127;
const small = callback({ result: 'i8', parameters: ['i8'] }, value => { check(value === -128, 'Narrow native argument'); return smallReturn; });
check(api.call('i8', small, -128).value === 127, 'Narrow callback result follows libffi promotion rules');
smallReturn = -128;
check(api.call('i8', small, -128).value === -128, 'Signed narrow callback return is extended correctly');
small.close();
const exact = callback({ result: 'i64', parameters: ['i64'] }, value => {
  check(value === -9223372036854775808n, 'Exact 64-bit native callback argument');
  return 9223372036854775807n;
});
check(api.call('i64', exact, -9223372036854775808n).value === 9223372036854775807n, 'Exact 64-bit callback return');
exact.close();
const mixed = callback({ result: 'double', parameters: ['i8', 'u64', 'float', 'double'] }, (a, b, c, d) => {
  check(a === -7 && b === 18446744073709551615n && c === 0.5 && d === 1.25, 'Mixed callback register classes');
  return a + c + d;
});
check(api.call('mixed', mixed).value === -5.25, 'Native floating callback result');
mixed.close();
let observed;
const notification = callback({ result: 'void', parameters: ['i32'] }, value => { observed = value; });
check(api.call('void', notification, 42).value === undefined && observed === 42, 'Void notification is synchronous');
notification.close();
const promisedVoid = callback({ result: 'void', parameters: ['i32'] }, async () => {});
refuses(() => api.call('void', promisedVoid, 1), 'ERR_FFI_CALLBACK_RESULT');
promisedVoid.close();

const original = new Error('callback failed');
let failures = 0;
const failing = callback(signature, () => { failures++; throw original; });
check(refuses(() => api.call('run', failing, 1, 3)) === original, 'Original JS exception is rethrown by the outer call');
check(failures === 1 && api.call('visits').value === 3, 'Later JS callbacks are suppressed, not native execution cancelled');
failing.close();
for (const thrown of [null, undefined, 23]) {
  const failure = callback(signature, () => { throw thrown; });
  check(refuses(() => api.call('run', failure, 1, 1)) === thrown, 'Primitive exceptions propagate exactly');
  failure.close();
}
for (const returned of [2147483648, NaN, '7', Promise.resolve(7)]) {
  const invalid = callback(signature, () => returned);
  refuses(() => api.call('run', invalid, 1, 2));
  invalid.close();
}
const otherThread = callback(signature, () => { throw new Error('Foreign thread entered QuickJS'); });
refuses(() => api.call('wrongThread', otherThread), 'ERR_FFI_CALLBACK_THREAD');
otherThread.close();
check(api.call('run', sum, 2, 1).value === 4, 'A failed scope does not poison subsequent calls');

let busy;
busy = callback(signature, value => {
  refuses(() => busy.close(), 'ERR_FFI_BUSY');
  collect();
  return value;
});
check(api.call('run', busy, 2, 2).value === 5, 'Busy close refuses without freeing an executing closure');
busy.close(); busy.close();
refuses(() => api.call('run', busy, 1, 1), 'ERR_FFI_CLOSED');
const nested = callback(signature, value => api.call('run', sum, value, 1).value);
check(api.call('run', nested, 3, 1).value === 6, 'Nested synchronous scopes retain independent closures');
nested.close();
const preserve = callback(signature, value => { api.call('setError', 71); collect(); return value; });
const preserved = api.call('error', preserve);
check(preserved.value === 3 && (platform === 'windows' ? preserved.systemError : preserved.errno) === 29,
  'Bridge restores incoming native error state across JS callback work');
preserve.close();

function retained() {
  const buffer = alloc(1);
  buffer.write(new Uint8Array([37]).buffer);
  return callback(signature, () => new Uint8Array(buffer.read(1))[0]);
}
const retainedFunction = retained();
collect();
check(api.call('run', retainedFunction, 1, 1).value === 37, 'Callback marks its captured JS function and native buffer');
retainedFunction.close(); collect();
for (let i = 0; i < 32; i++) {
  const cycle = {};
  cycle.callback = callback(signature, value => cycle.callback ? value : 0);
}
collect();
const closingLibrary = open(fixtureLibrary);
let closingFunction = closingLibrary.bind('sr_callback_i32',
  { result: 'i32', parameters: ['callback', 'i32', 'i32'] });
const closing = callback(signature, value => {
  closingFunction.close(); closingLibrary.close(); collect(); return value;
});
check(closingFunction(closing, 4, 2).value === 9, 'Closing binding/library during callback keeps active native code loaded');
refuses(() => closingFunction(closing, 1, 1), 'ERR_FFI_CLOSED');
closing.close();
sum.close(); api.close();
// Leave a reachable callback for VM teardown; no persistent executable closure exists.
globalThis.callbackForVmExit = callback(signature, value => value);
