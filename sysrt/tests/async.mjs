import { open, alloc, allocPointers, async as supported, platform } from 'sysrt:ffi';
import { loadBindings, loadNativeApi } from './sysrt/sdk/js/native.mjs';

function check(value, message) { if (!value) throw new Error(message); }
function refuses(action, code) {
  try { action(); } catch (error) { check(error.code === code, code + ': ' + error); return; }
  throw new Error('Expected ' + code);
}
check(supported === true, 'Asynchronous native execution is declared');
const description = { library: fixtureLibrary, functions: {
  thread: { symbol: 'sr_thread_id', result: 'u64', parameters: [] },
  delay: { symbol: 'sr_async_delay', result: 'i32', parameters: ['i32', 'i32'] },
  reset: { symbol: 'sr_gate_reset', result: 'void', parameters: [] },
  release: { symbol: 'sr_gate_release', result: 'void', parameters: [] },
  wait: { symbol: 'sr_gate_wait', result: 'i32', parameters: ['i32'] },
  error: { symbol: 'sr_error', result: 'i32', parameters: ['i32'] },
  strings: { symbol: 'sr_variadic_strings', result: 'size', parameters: ['i32', 'cstring', 'cstring'], variadic: 1 },
  pointer: { symbol: 'sr_echo_pointer', result: 'pointer', parameters: ['pointer'] },
  pointerInput: { symbol: 'sr_fill', result: 'void', parameters: ['pointer', 'size', 'u8'] },
  fill: { symbol: 'sr_gate_fill', result: 'i32', parameters: ['pointer', 'size', 'u8'] },
  pair: { symbol: 'sr_gate_pair', result: 'i32', parameters: ['pointer', 'pointer'] },
  bufferError: { symbol: 'sr_buffer_error', result: 'i32', parameters: ['pointer'] },
  external: { symbol: 'sr_static', result: 'pointer', parameters: [] },
  integer: { symbol: 'sr_echo_i64', result: 'i64', parameters: ['i64'] },
  floating: { symbol: 'sr_echo_double', result: 'double', parameters: ['double'] },
  observer: { symbol: 'sr_saved_error', result: 'i32', parameters: [], clearErrors: false },
} };
const control = loadBindings(description), api = loadNativeApi(description);
const mainThread = control.call('thread').value;
check((await control.callAsync('thread')).value !== mainThread, 'Real off-thread native call');
check((await api.async.sr_async_delay(1, 12)).value === 12, 'Native-symbol SDK async namespace');
check((await control.callAsync('integer', -9223372036854775808n)).value === -9223372036854775808n,
  'Exact 64-bit values cross the worker boundary');
check((await control.callAsync('floating', 1.25)).value === 1.25, 'Floating return packet');
const failures = await control.callAsync('error', 27);
check(failures.value === -1 && (platform === 'windows' ? failures.systemError === 27 && failures.errno === null :
  failures.errno === 27 && failures.systemError === null), 'Error state is captured on the worker');
check((await control.callAsync('strings', 2, 'abc', '\u4e2d')).value === 6n, 'Private CString copies and variadic signatures');
refuses(() => control.callAsync('pointer', null), 'ERR_FFI_ASYNC');
check((await control.callAsync('pointerInput', null, 0, 0)).value === undefined, 'Explicit null pointer retains native semantics');
refuses(() => control.callAsync('observer'), 'ERR_FFI_ASYNC');

control.call('reset');
let released = false;
const library = open(fixtureLibrary);
let wait = library.bind('sr_gate_wait', { result: 'i32', parameters: ['i32'] });
const pending = wait.callAsync(31);
wait.close(); library.close(); wait = null;
collect();
control.call('release'); released = true;
check((await pending).value === 31 && released, 'Main VM can release a blocked worker after caller GC/library close');
check((await control.callAsync('release')).value === undefined, 'Void calls settle a native result packet');
check((await Promise.all([control.callAsync('delay', 1, 4), control.callAsync('delay', 1, 5)]))
  .map(result => result.value).join(',') === '4,5', 'Separate native invocations settle correctly');

const data = alloc(8), view = data.slice(2, 4);
control.call('reset');
const filling = control.callAsync('fill', view, 4, 7);
refuses(() => data.read(8), 'ERR_FFI_BUSY');
refuses(() => data.readString(8), 'ERR_FFI_BUSY');
refuses(() => data.readPointer(), 'ERR_FFI_BUSY');
refuses(() => view.write(new Uint8Array(4).buffer), 'ERR_FFI_BUSY');
refuses(() => data.slice(0, 1), 'ERR_FFI_BUSY');
refuses(() => control.call('pointerInput', data, 0, 0), 'ERR_FFI_BUSY');
refuses(() => control.callAsync('fill', data, 0, 0), 'ERR_FFI_BUSY');
refuses(() => allocPointers([data, null]), 'ERR_FFI_BUSY');
view.close();
collect();
control.call('release');
check((await filling).value === 4 && new Uint8Array(data.read(8)).join(',') === '0,0,7,7,7,7,0,0',
  'View close does not revoke accepted work; allocation is returned before Promise handlers');
control.call('reset');
const alias = data.slice(2, 2), pair = control.callAsync('pair', alias, alias);
control.call('release');
check((await pair).value === 14 && data.read(8).byteLength === 8, 'Repeated aliases share one balanced allocation loan');
alias.close();
let conversionFailed = false;
try { control.callAsync('fill', data, 8, 256); } catch (error) { conversionFailed = error instanceof RangeError; }
check(conversionFailed && data.read(8).byteLength === 8, 'Invalid submissions return prior pins without reserving memory');
const nativeFailure = await control.callAsync('bufferError', data);
check(nativeFailure.value === -1 && new Uint8Array(data.read(1))[0] === 42 &&
  (platform === 'windows' ? nativeFailure.systemError === 27 : nativeFailure.errno === 27),
  'Native errors return loans and preserve partial native writes');
data.close();

control.call('reset');
let abandoned = alloc(8);
const abandonedCall = control.callAsync('fill', abandoned, 8, 9);
abandoned = null; collect();
control.call('release');
check((await abandonedCall).value === 8, 'GC cannot free a borrowed native allocation');
control.call('reset');
const closing = alloc(8), closingCall = control.callAsync('fill', closing, 8, 11);
closing.close();
refuses(() => closing.read(1), 'ERR_FFI_CLOSED');
control.call('release');
check((await closingCall).value === 8, 'Explicit owner close defers release until accepted native work finishes');

const unbounded = control.call('external').value, vector = allocPointers([null]);
refuses(() => control.callAsync('pointerInput', unbounded, 0, 0), 'ERR_FFI_ASYNC');
refuses(() => control.callAsync('pointerInput', vector, 0, 0), 'ERR_FFI_ASYNC');
unbounded.close(); vector.close();
const closedLibrary = open(fixtureLibrary);
const closedFunction = closedLibrary.bind('sr_async_delay', { result: 'i32', parameters: ['i32', 'i32'] });
closedFunction.close(); closedLibrary.close();
refuses(() => closedFunction.callAsync(1, 1), 'ERR_FFI_CLOSED');
control.close(); api.dispose();
