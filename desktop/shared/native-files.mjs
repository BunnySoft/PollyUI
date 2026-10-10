import { libc } from 'sysrt:ffi';
import { createFileSystem } from './sysrt/sdk/js/files.mjs';
import { filesBindings, fileConstants as C } from './sysrt/bindings/files.mjs';

export const errors = {
  1: 'EPERM', 2: 'ENOENT', 4: 'EINTR', 5: 'EIO', 9: 'EBADF', 12: 'ENOMEM',
  13: 'EACCES', 17: 'EEXIST', 20: 'ENOTDIR', 21: 'EISDIR', 22: 'EINVAL', 27: 'EFBIG',
  28: 'ENOSPC', 30: 'EROFS', 36: 'ENAMETOOLONG', 38: 'ENOSYS', 40: 'ELOOP',
  75: 'EOVERFLOW', 84: 'EILSEQ', 95: 'ENOTSUP', 116: 'ESTALE',
};
let native = null;
function backend() { return native ??= createFileSystem(); }
export function failure(code, syscall = '') {
  return Object.assign(new Error(code + (syscall ? ': ' + syscall : '')), { code, syscall });
}
export function raw(name, ...args) {
  return backend()[filesBindings[libc].functions[name].symbol](...args);
}
export function call(name, ...args) {
  const result = raw(name, ...args);
  if (result.value < 0) throw failure(errors[result.errno] ?? 'ERR_OS_' + result.errno, name);
  return result.value;
}
export function usingFD(fd, action) {
  let primary = null;
  try { return action(fd); }
  catch (error) { primary = error; throw error; }
  finally {
    try { call('close', fd); }
    catch (cleanup) {
      if (primary) {
        throw Object.assign(new Error(primary.message + '; descriptor cleanup failed: ' + cleanup.message),
          { code: primary.code, cause: primary, cleanup, committed: primary.committed });
      }
      throw cleanup;
    }
  }
}
export function status(fd, name = '', flags = C.emptyPath) {
  const record = backend().createRecord('statx');
  try {
    call('status', fd, name, flags, C.basicStatus, record.pointer);
    const value = record.read();
    if ((value.mask & C.basicStatus) !== C.basicStatus) throw failure('ENOTSUP', 'statx mask');
    if (value.mtimeNanos >= 1000000000 || value.ctimeNanos >= 1000000000) throw failure('EIO', 'statx timestamp');
    return value;
  } finally { record.close(); }
}
