import { open, alloc, platform, libc } from 'sysrt:ffi';
import { loadBindings } from './sysrt/sdk/js/native.mjs';

function check(value, message) { if (!value) throw new Error(message); }
function refuses(action, code) {
  try { action(); } catch (error) { check(error.code === code, String(error)); return; }
  throw new Error('Expected ' + code);
}
const library = open(fixtureLibrary);
const allocate = library.bind('sr_allocate', { result: 'pointer', parameters: ['size'] });
const release = library.bind('sr_release', { result: 'void', parameters: ['pointer'] });
const observer = loadBindings({ library: fixtureLibrary, functions: {
  count: { symbol: 'sr_allocations', result: 'i32', parameters: [] },
  fill: { symbol: 'sr_delay_fill', result: 'i32', parameters: ['pointer', 'size', 'u8', 'i32'] },
}});
const count = () => observer.call('count').value;
check(count() === 0, 'Native fixture begins without allocations');
const pointer = allocate(8).value;
refuses(() => pointer.read(1), 'ERR_FFI_MEMORY');
pointer.adopt(8, release);
refuses(() => pointer.adopt(8, release), 'ERR_FFI_OWNERSHIP');
check(new Uint8Array(pointer.read(8)).every(value => value === 0), 'Explicit native extent makes the allocation readable');
const view = pointer.slice(2, 4);
const returned = observer.callAsync('fill', view, 4, 19, 1);
refuses(() => pointer.read(1), 'ERR_FFI_BUSY');
check((await returned).value === 4 && new Uint8Array(pointer.read(8)).join(',') === '0,0,19,19,19,19,0,0',
  'Adopted memory uses the same async loan rules');
pointer.close();
refuses(() => view.read(1), 'ERR_FFI_CLOSED');
check(count() === 1, 'Native release waits for the retained view');
view.close();
check(count() === 0, 'Native release runs exactly once after the last view');
pointer.close(); view.close();
check(count() === 0, 'Repeated close cannot release twice');

let collected = allocate(8).value;
collected.adopt(8, release); collected = null; collect();
check(count() === 0, 'GC calls the declared native releaser');
const busy = allocate(8).value;
busy.adopt(8, release);
const inFlight = observer.callAsync('fill', busy, 8, 7, 10);
busy.close();
check(count() === 1, 'Closed allocation stays alive for accepted worker');
check((await inFlight).value === 8 && count() === 0, 'Completion releases a closed adopted allocation');

const external = allocate(8).value;
const bad = library.bind('sr_echo_pointer', { result: 'pointer', parameters: ['pointer'] });
refuses(() => external.adopt(8, bad), 'ERR_FFI_OWNERSHIP');
release(external); external.close(); bad.close();
const managed = alloc(1);
refuses(() => managed.adopt(1, release), 'ERR_FFI_OWNERSHIP');
managed.close();

const retained = allocate(8).value;
retained.adopt(8, release);
release.close(); allocate.close(); library.close();
retained.close();
check(count() === 0, 'Release code remains available after the user closes its binding and library');
observer.close();

const crt = loadBindings({
  library: platform === 'windows' ? 'ucrtbase.dll' : libc === 'glibc' ? 'libc.so.6' :
    platform === 'macos' ? '/usr/lib/libSystem.B.dylib' : 'libc.musl-x86_64.so.1',
  functions: {
    allocate: { symbol: 'malloc', result: 'pointer', parameters: ['size'] },
    release: { symbol: 'free', result: 'void', parameters: ['pointer'] },
  },
});
const nativeMemory = crt.call('allocate', 16).value;
check(nativeMemory !== null, 'Actual system CRT allocation');
crt.adopt(nativeMemory, 16, 'release');
nativeMemory.write(new Uint8Array([1, 2, 3, 0]).buffer);
check(new Uint8Array(nativeMemory.read(4)).join(',') === '1,2,3,0', 'JS owns bounded access to a real native allocation');
crt.close(); nativeMemory.close();
