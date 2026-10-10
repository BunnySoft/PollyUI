import { alloc, libc } from 'sysrt:ffi';
import { createFileSystem, constants as C } from './sysrt/sdk/js/files.mjs';
import { filesBindings, fileConstants } from './sysrt/bindings/files.mjs';
import { fileAbiLayouts, fileAbiTarget, nativeFileConstants } from './sysrt/bindings/generated/files-linux-x86_64.mjs';
import { loadBindings } from './sysrt/sdk/js/native.mjs';

const fs = createFileSystem();
const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
function check(value, message) { if (!value) throw new Error(message); }
function value(result, message) {
  check(result.value >= 0 && result.systemError === null, message + ': errno=' + result.errno);
  return result.value;
}
check(filesBindings[libc].layouts === fileAbiLayouts && filesBindings[libc].target === fileAbiTarget,
  'Native bindings use generated target and layouts');
for (const [name, constant] of Object.entries(C))
  check(constant === nativeFileConstants[name], 'Native SDK uses measured ' + name);
check(filesBindings.glibc.functions.entries.symbol === 'getdents64' &&
  filesBindings.glibc.functions.entries.result === 'ssize' &&
  filesBindings.musl.functions.entries.symbol === 'getdents' &&
  filesBindings.musl.functions.entries.result === 'i32', 'Libc enumeration signatures remain distinct');
const oracle = loadBindings({ library: fixtureLibrary, functions: {
  offset: { symbol: 'sr_statx_offset', result: 'size', parameters: ['i32'] },
}});
try {
  const fields = Object.values(fileAbiLayouts.statx.fields);
  fields.forEach((field, index) =>
    check(Number(oracle.call('offset', index).value) === field.offset, 'Header statx offset ' + index));
  check(Number(oracle.call('offset', fields.length).value) === fileAbiLayouts.statx.byteLength, 'Header statx size');
  Object.values(fileConstants).forEach((constant, index) => {
    const expected = BigInt(constant) + (constant < 0 ? 18446744073709551616n : 0n);
    const actual = oracle.call('offset', fields.length + 1 + index).value;
    check(expected === actual, 'Header desktop constant ' + index + ': expected ' + expected + ', actual ' + actual);
  });
} finally { oracle.close(); }
function home() {
  const pointer = fs.getenv('HOME').value;
  check(pointer !== null, 'Private fixture HOME');
  const size = Number(value(fs.strnlen(pointer, 4096), 'HOME size'));
  const buffer = alloc(size + 1);
  try {
    fs.memcpy(buffer, pointer, size).value.close();
    const path = buffer.readString(size + 1);
    check(path.startsWith('/tmp/polly-files-sdk-'), 'Tests only use private fixture data');
    return path;
  } finally { pointer.close(); buffer.close(); }
}
const root = home() + '/native-' + fixtureRun;
value(fs.mkdirat(C.AT_FDCWD, root, 0o700), 'Native directory create');
const directory = Number(value(fs.openat(C.AT_FDCWD, root, C.O_RDONLY | C.O_DIRECTORY | C.O_CLOEXEC, 0), 'Directory open'));
const descriptors = new Set([directory]), buffer = alloc(2 * 1024 * 1024);
const record = fs.createRecord('statx');
try {
  const fd = Number(value(fs.openat(directory, 'binary.dat', C.O_CREAT | C.O_EXCL | C.O_RDWR | C.O_CLOEXEC, 0o600), 'Relative create'));
  descriptors.add(fd);
  const chunk = new Uint8Array(2 * 1024 * 1024).fill(0xa5);
  chunk[0] = 0; chunk[1] = 0xff;
  buffer.write(chunk.buffer);
  let total = 0n;
  while (total < 18n * 1024n * 1024n) {
    const count = value(fs.write(fd, buffer, chunk.length), 'Raw binary write');
    check(count > 0n, 'Write makes progress'); total += count;
  }
  check(total === 18n * 1024n * 1024n, 'File size exceeds 16 MiB without an SDK quota');
  value(fs.statx(fd, '', C.AT_EMPTY_PATH, C.STATX_BASIC_STATS, record.pointer), 'Native status');
  check(record.read().size === total, 'Actual file size');
  check(value(fs.lseek(fd, 0n, C.SEEK_SET), 'Seek') === 0n, 'Seek preserves exact offsets');
  check(value(fs.read(fd, buffer, 2), 'Binary read') === 2n, 'Read count is not text length');
  check(new Uint8Array(buffer.read(2)).join(',') === '0,255', 'NUL and invalid UTF-8 bytes remain binary data');
  const marker = new Uint8Array([9, 8, 7, 6]); buffer.write(marker.buffer);
  const offset = 4294967301n;
  const writing = fs.async.pwrite(fd, buffer, 4, offset);
  let busy = false;
  try { buffer.read(4); } catch (error) { busy = error.code === 'ERR_FFI_BUSY'; }
  check(busy, 'Native file write borrows its buffer before completion');
  check(value(await writing, 'Positioned write') === 4n, 'Positioned write beyond 4 GiB');
  check(value(fs.lseek(fd, 0n, C.SEEK_CUR), 'Current offset') === 2n, 'pwrite does not change file position');
  value(await fs.async.pread(fd, buffer, 4, offset), 'Positioned read');
  check(new Uint8Array(buffer.read(4)).join(',') === '9,8,7,6', 'Exact 64-bit positioned read');
  check(value(fs.lseek(fd, 0n, C.SEEK_CUR), 'Unchanged offset') === 2n, 'pread preserves file position');
  value(fs.ftruncate(fd, 3n), 'Truncate');
  value(fs.statx(fd, '', C.AT_EMPTY_PATH, C.STATX_BASIC_STATS, record.pointer), 'Truncated status');
  check(record.read().size === 3n, 'Native truncation');
  value(fs.fsync(fd), 'Sync');
  const collision = Number(value(fs.openat(directory, 'collision', C.O_CREAT | C.O_EXCL | C.O_WRONLY, 0o600), 'Collision fixture'));
  descriptors.add(collision);
  check(fs.renameat2(directory, 'binary.dat', directory, 'collision', C.RENAME_NOREPLACE).errno === 17,
    'Native no-replace EEXIST is not transformed');
  value(fs.renameat2(directory, 'binary.dat', directory, 'collision', 0), 'Native overwrite rename');
  value(fs.linkat(directory, 'collision', directory, 'hard-link', 0), 'Hard link');
  value(fs.symlinkat('collision', directory, 'symbolic-link'), 'Symbolic link');
  buffer.write(new ArrayBuffer(32));
  check(value(fs.readlinkat(directory, 'symbolic-link', buffer, 32), 'Read link') === 9n, 'Native link length');
  check(buffer.readString(10) === 'collision', 'Literal symbolic-link target');
  check(fs.openat(directory, 'missing', C.O_RDONLY, 0).value === -1 &&
    fs.openat(directory, 'missing', C.O_RDONLY, 0).errno === 2, 'OS errors remain result packets');
  for (let i = 0; i < 1025; i++) {
    const item = Number(value(fs.openat(directory, 'entry-' + i, C.O_CREAT | C.O_EXCL | C.O_WRONLY, 0o600), 'Enumeration fixture'));
    value(fs.close(item), 'Close enumeration file');
  }
  let entries = 0;
  const enumerate = libc === 'musl' ? fs.getdents : fs.getdents64;
  for (;;) {
    const size = Number(value(enumerate(directory, buffer, chunk.length), 'Native directory records'));
    if (!size) break;
    const data = new DataView(buffer.read(size));
    for (let at = 0; at < size;) {
      const length = data.getUint16(at + 16, littleEndian);
      check(length >= 20 && at + length <= size, 'Native directory record bounds');
      entries++; at += length;
    }
  }
  check(entries > 1024, 'No SDK directory-entry limit');
  value(fs.unlinkat(directory, 'hard-link', 0), 'Unlink');
  value(fs.unlinkat(directory, 'symbolic-link', 0), 'Unlink symbolic link');
  value(fs.unlinkat(directory, 'collision', 0), 'Unlink regular file');
  for (let i = 0; i < 1025; i++) value(fs.unlinkat(directory, 'entry-' + i, 0), 'Remove fixture file');
} finally {
  record.close(); buffer.close();
  for (const fd of descriptors) value(fs.close(fd), 'Descriptor cleanup');
  fs.dispose();
}
const cleanup = createFileSystem();
try { value(cleanup.unlinkat(C.AT_FDCWD, root, C.AT_REMOVEDIR), 'Remove empty fixture directory'); }
finally { cleanup.dispose(); }
let closed = false;
try { fs.openat(C.AT_FDCWD, root, C.O_RDONLY, 0); }
catch (error) { closed = /closed/.test(error.message); }
check(closed, 'Disposed binding lifetime is explicit');
