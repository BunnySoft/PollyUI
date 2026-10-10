import { open, alloc, platform, pointerSize, longSize, maxBytes, callbacks, async as asyncCalls } from 'sysrt:ffi';
import { currentId, close as closeProcess } from './sysrt/sdk/js/process.mjs';
import { loadBindings } from './sysrt/sdk/js/native.mjs';
import { createRecord } from './sysrt/sdk/js/memory.mjs';
import { monotonicNanoseconds, close as closeClock } from './sysrt/sdk/js/clock.mjs';

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

if (platform === 'windows' || platform === 'linux') {
  let previous = monotonicNanoseconds();
  check(typeof previous === 'bigint' && previous >= 0n, 'OS clock returns exact nanosecond units');
  let changed = false;
  for (let i = 0; i < 64; i++) {
    const current = monotonicNanoseconds();
    check(current >= previous, 'Monotonic time never goes backwards');
    changed ||= current > previous;
    previous = current;
  }
  check(changed, 'OS clock advances rather than returning a constant');
  closeClock();
  check(monotonicNanoseconds() >= previous, 'Clock reload preserves monotonic source');
  closeClock();
}

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
if (platform === 'windows' || platform === 'linux') {
  const reference = bind('sr_monotonic_ns', 'u64', []);
  const before = reference().value;
  const observed = monotonicNanoseconds();
  const after = reference().value;
  check(before !== 18446744073709551615n && after !== 18446744073709551615n &&
    before <= observed && observed <= after, 'Clock units and source match direct native OS calls');
  closeClock();
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

const recordLayout = {
  byteLength: Number(bind('sr_record_size', 'size', [])().value),
  fields: {
    tag: { type: 'i8', offset: 0 },
    count: { type: 'i64', offset: Number(bind('sr_record_count_offset', 'size', [])().value) },
    ratio: { type: 'double', offset: Number(bind('sr_record_ratio_offset', 'size', [])().value) },
  },
};
const records = loadBindings({
  library: fixtureLibrary, target: { pointerSize, longSize }, layouts: { sample: recordLayout },
  functions: {
    fill: { symbol: 'sr_record_fill', result: 'void', parameters: ['pointer'] },
    check: { symbol: 'sr_record_check', result: 'i32', parameters: ['pointer'] },
  },
});
const record = records.createRecord('sample');
records.call('fill', record.pointer);
const observed = record.read();
check(observed.tag === -7 && observed.count === -9223372036854775807n && observed.ratio === 1.25,
  'JS layout decodes compiler-verified native offsets');
refuses(() => record.write({ tag: 12, count: 9223372036854775808n }), 'Record overflow');
check(record.read().tag === -7, 'Rejected multi-field update does not partially write');
refuses(() => record.write({ unknown: 1 }), 'Unknown field');
record.write({ tag: 12, count: 9223372036854775807n, ratio: 2.5 });
check(records.call('check', record.pointer).value === 1, 'Native code observes JS/config field writes');
record.close();
refuses(() => record.read(), 'Closed record read');
refuses(() => record.pointer, 'Closed record pointer');
refuses(() => records.createRecord('missing'), 'Unknown layout');
records.close();
refuses(() => records.createRecord('sample'), 'No allocation after binding close');
refuses(() => loadBindings({ library: fixtureLibrary, functions: {},
  target: { pointerSize: pointerSize === 8 ? 4 : 8 } }), 'Wrong ABI profile');
for (const layout of [
  { byteLength: 0, fields: { a: { type: 'i32', offset: 0 } } },
  { byteLength: maxBytes + 1, fields: { a: { type: 'i32', offset: 0 } } },
  { byteLength: 4, fields: { a: { type: 'i64', offset: 0 } } },
  { byteLength: 4, fields: { a: { type: 'i32', offset: -1 } } },
  { byteLength: 8, fields: { a: { type: 'i64', offset: 0 }, b: { type: 'u8', offset: 1 } } },
  { byteLength: 8, fields: { a: { type: 'pointer', offset: 0 } } },
  { byteLength: 4, fields: { a: { type: 'i32', offset: 0, automatic: true } } },
]) refuses(() => createRecord(layout), 'Invalid or unsupported layout');

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
