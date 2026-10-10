import { open, alloc, platform, pointerSize, longSize, maxBytes, callbacks, async as asyncCalls } from 'sysrt:ffi';
import { currentId, close as closeProcess } from './sysrt/sdk/js/process.mjs';
import { loadBindings } from './sysrt/sdk/js/native.mjs';

function check(value, message) { if (!value) throw new Error(message); }
function refuses(action, message, code) {
  try { action(); } catch (error) {
    if (code) check(error.code === code, message + ': ' + error);
    return;
  }
  throw new Error('Missing refusal: ' + message);
}
check(pointerSize === 4 || pointerSize === 8, 'Native pointer width is explicit');
check(longSize === 4 || longSize === 8, 'Native long width is explicit');
check(callbacks === false && asyncCalls === false, 'Unimplemented features are explicit');
const pid = currentId();
check(Number.isInteger(pid) && pid === expectedProcessId && currentId() === pid, 'JS process SDK calls the actual OS');
closeProcess();
check(currentId() === pid, 'SDK bindings can be closed and reloaded');
closeProcess();

let retainedFunction, retainedView;
{
  const temporaryLibrary = open(fixtureLibrary);
  retainedFunction = temporaryLibrary.bind('sr_echo_u32', { result: 'u32', parameters: ['u32'] });
  const temporaryBuffer = alloc(2);
  temporaryBuffer.write(new Uint8Array([11, 22]).buffer);
  retainedView = temporaryBuffer.slice(0, 2);
}
collect();
check(retainedFunction(77).value === 77, 'Binding survives library wrapper collection');
check(new Uint8Array(retainedView.read(2))[1] === 22, 'View survives buffer wrapper collection');
retainedFunction.close(); retainedView.close();
collect();

refuses(() => open('./relative/library'), 'Relative path is not a loader name');
if (platform === 'windows') refuses(() => open('C:relative.dll'), 'Drive-relative DLL path');
refuses(() => open('missing-polly-ffi-library-12345'), 'Unknown library', 'ERR_FFI_LIBRARY');
refuses(() => open('x\0y'), 'Library NUL');
const library = open(fixtureLibrary), functions = [];
function bind(name, result, parameters) {
  const function_ = library.bind(name, { result, parameters });
  functions.push(function_); return function_;
}
refuses(() => library.bind('missing_symbol', { result: 'i32', parameters: [] }), 'Unknown export', 'ERR_FFI_SYMBOL');
refuses(() => library.bind('sr_echo_i8', { result: 'record', parameters: [] }), 'Unsupported structure');
refuses(() => library.bind('sr_echo_i8', { result: 'i8', parameters: ['void'] }), 'void argument');
refuses(() => library.bind('sr_echo_i8', { result: 'i8', parameters: ['i8'], variadic: true }), 'Unsupported variadic metadata');
refuses(() => library.bind('sr_echo_i8', { result: 'i8', parameters: ['i8'], abi: 'unknown' }), 'Unknown ABI');
const cases = [
  ['i8', -128, 127], ['u8', 0, 255], ['i16', -32768, 32767], ['u16', 0, 65535],
  ['i32', -2147483648, 2147483647], ['u32', 0, 4294967295],
];
for (const [type, minimum, maximum] of cases) {
  const function_ = bind('sr_echo_' + type, type, [type]);
  check(function_(minimum).value === minimum && function_(maximum).value === maximum, type + ' ABI boundary');
  refuses(() => function_(minimum - 1), type + ' lower bound');
  refuses(() => function_(maximum + 1), type + ' upper bound');
  refuses(() => function_('1'), type + ' implicit coercion');
  refuses(() => function_(1.5), type + ' fractional input');
  refuses(() => function_(NaN), type + ' NaN integer');
  refuses(() => function_(), type + ' wrong argument count');
}
const signed = bind('sr_echo_i64', 'i64', ['i64']);
const unsigned = bind('sr_echo_u64', 'u64', ['u64']);
check(signed(-9223372036854775808n).value === -9223372036854775808n, 'Signed 64-bit minimum');
check(signed(9223372036854775807n).value === 9223372036854775807n, 'Signed 64-bit maximum');
check(unsigned(18446744073709551615n).value === 18446744073709551615n, 'Unsigned 64-bit maximum');
refuses(() => signed(9223372036854775808n), 'Signed overflow must not wrap');
refuses(() => signed(-9223372036854775809n), 'Signed underflow must not wrap');
refuses(() => unsigned(-1n), 'Unsigned negative must not wrap');
refuses(() => unsigned(18446744073709551616n), 'Unsigned overflow must not wrap');
refuses(() => unsigned(9007199254740992), 'Unsafe Number must not round');
const floating = bind('sr_echo_double', 'double', ['double']);
check(Number.isNaN(floating(NaN).value) && floating(Infinity).value === Infinity, 'IEEE floating values');
check(bind('sr_echo_float', 'float', ['float'])(0.5).value === 0.5, 'Single precision');
check(bind('sr_mixed', 'double', ['i8', 'u16', 'i32', 'double'])(-1, 65535, -4000, 0.25).value === 61534.25,
  'Mixed register types');
const nativeError = bind('sr_error', 'i32', ['i32'])(13);
check(nativeError.value === -1, 'Negative native result remains a result');
check(platform === 'windows' ? nativeError.systemError === 13 && nativeError.errno === null :
  nativeError.errno === 13 && nativeError.systemError === null, 'Error state is captured with its call');

const buffer = alloc(8);
refuses(() => Object.getPrototypeOf(buffer).read.call(foreignObject, 1),
  'Foreign native classes must not be interpreted as pointers');
check([...new Uint8Array(buffer.read(8))].every(byte => byte === 0), 'Managed allocation is initialized');
buffer.write(new Uint8Array([65, 66, 0]).buffer, 1);
check(buffer.readString(3, 1) === 'AB', 'Bounded string decode');
refuses(() => buffer.readString(2, 1), 'No terminator inside bound');
refuses(() => buffer.read(9), 'Read bound');
refuses(() => buffer.write(new Uint8Array(9).buffer), 'Write bound');
refuses(() => buffer.write(12), 'Write type');
refuses(() => alloc(maxBytes + 1), 'Allocation bound');
refuses(() => alloc(-1), 'Negative allocation');
refuses(() => buffer.slice(8, 1), 'View bound');
const fill = bind('sr_fill', 'void', ['pointer', 'size', 'u8']);
check(fill(buffer, 8, 90).value === undefined, 'void result');
check([...new Uint8Array(buffer.read(8))].every(byte => byte === 90), 'Native writes into managed memory');
refuses(() => fill(123n, 1, 1), 'Forged pointer');
const echo = bind('sr_echo_pointer', 'pointer', ['pointer']);
check(echo(null).value === null, 'Null pointer round-trip');
const view = buffer.slice(2, 2), echoed = echo(view).value;
check(echoed.read(2).byteLength === 2, 'Returned view pins its memory');
refuses(() => echoed.read(3), 'Returned view cannot widen its bound');
const tail = bind('sr_tail', 'pointer', ['cstring'])('A\u{1f642}').value;
collect();
check(tail.readString(5) === '\u{1f642}', 'Returned pointer pins temporary UTF-8 argument storage');
refuses(() => bind('sr_tail', 'pointer', ['cstring'])('A\0B'), 'CString NUL');
const getStatic = bind('sr_static', 'pointer', []);
const staticPointer = getStatic().value;
refuses(() => staticPointer.read(1), 'Unknown native allocation is not readable', 'ERR_FFI_MEMORY');
staticPointer.close();
buffer.close();
refuses(() => view.read(1), 'Owner close revokes views', 'ERR_FFI_CLOSED');
refuses(() => echo(view), 'Closed pointer cannot reach native code', 'ERR_FFI_CLOSED');
view.close(); echoed.close();
library.close();
refuses(() => tail.read(1), 'Library close revokes returned pointers', 'ERR_FFI_CLOSED');
refuses(() => signed(1n), 'Library close revokes bindings', 'ERR_FFI_CLOSED');
tail.close();
for (const function_ of functions) { function_.close(); function_.close(); }
library.close();
refuses(() => library.bind('sr_static', { result: 'pointer', parameters: [] }), 'No binding after close', 'ERR_FFI_CLOSED');

const configured = loadBindings({
  library: fixtureLibrary,
  functions: { echo: { symbol: 'sr_echo_u32', result: 'u32', parameters: ['u32'] } },
});
check(configured.call('echo', 123).value === 123, 'A new API needs only JS/config, not a new bridge');
configured.close();
refuses(() => configured.call('echo', 123), 'SDK close');
refuses(() => loadBindings({ library: fixtureLibrary,
  functions: { echo: { symbol: 'sr_echo_u32', result: 'u32', parameters: ['u32'], async: true } } }),
  'SDK must not silently ignore unsupported async metadata');
refuses(() => loadBindings({ library: fixtureLibrary,
  functions: { first: { symbol: 'sr_static', result: 'pointer', parameters: [] },
    bad: { symbol: 'missing', result: 'void', parameters: [] } } }), 'Partial construction releases bindings', 'ERR_FFI_SYMBOL');
