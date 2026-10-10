import { open, async as supported, platform } from 'sysrt:ffi';
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
refuses(() => control.callAsync('pointerInput', null, 0, 0), 'ERR_FFI_ASYNC');
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
control.close(); api.dispose();
