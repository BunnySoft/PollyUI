import { alloc } from 'sysrt:ffi';
import { fileConstants as C } from './sysrt/bindings/files.mjs';
import { encodeUtf8 } from './sysrt/sdk/js/encoding.mjs';
import { raw, call, status, usingFD, errors, failure } from './desktop/shared/native-files.mjs';

const directories = C.readOnly | C.directory | C.noFollow | C.closeOnExec;
function retry(name, ...args) {
  let result;
  do { result = raw(name, ...args); } while (result.value < 0 && result.errno === 4);
  if (result.value < 0) throw failure(errors[result.errno] ?? 'ERR_OS_' + result.errno, name);
  return result.value;
}
function privateObject(info, type, uid) {
  if ((info.mode & C.typeMask) !== type || info.uid !== uid || (info.mode & 0o7077) ||
      (type === C.regular && info.links !== 1))
    throw failure('EPERM', 'configuration requires a private owned directory or regular single-link file');
}
function openDirectory(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0') ||
      path.slice(1).split('/').some(part => !part || part === '.' || part === '..'))
    throw new TypeError('Configuration requires an explicit absolute application directory');
  encodeUtf8(path, 4095);
  const uid = call('euid');
  let fd = Number(retry('open', C.currentDirectory, '/', directories, 0));
  try {
    for (const part of path.slice(1).split('/')) {
      const next = Number(retry('open', fd, part, directories, 0));
      const previous = fd; fd = next;
      call('close', previous);
      const info = status(fd);
      if ((info.uid !== uid && info.uid !== 0) ||
          ((info.mode & 0o022) && !(info.uid === 0 && (info.mode & 0o1000))))
        throw failure('EPERM', 'untrusted configuration directory ancestor');
    }
    privateObject(status(fd), C.directoryType, uid);
    const result = fd; fd = null;
    return result;
  } finally { if (fd !== null) call('close', fd); }
}
function optionalFile(parent, name, flags) {
  try { return Number(retry('open', parent, name, flags | C.noFollow | C.nonblock | C.closeOnExec, 0)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function read(parent, name) {
  const fd = optionalFile(parent, name, C.readOnly);
  if (fd === null) return null;
  return usingFD(fd, opened => {
    const before = status(opened);
    privateObject(before, C.regular, call('euid'));
    if (before.size >= BigInt(Number.MAX_SAFE_INTEGER)) throw failure('EOVERFLOW', 'configuration size');
    const size = Number(before.size), buffer = alloc(size + 1);
    try {
      for (let offset = 0; offset < size;) {
        const view = buffer.slice(offset, size - offset);
        let count;
        try { count = Number(retry('read', opened, view, size - offset)); } finally { view.close(); }
        if (!count) throw failure('ESTALE', 'truncated configuration');
        offset += count;
      }
      const tail = buffer.slice(size, 1);
      try { if (retry('read', opened, tail, 1)) throw failure('ESTALE', 'configuration grew'); }
      finally { tail.close(); }
      const after = status(opened);
      if (after.size !== before.size || after.mtimeSeconds !== before.mtimeSeconds ||
          after.mtimeNanos !== before.mtimeNanos || after.ctimeSeconds !== before.ctimeSeconds ||
          after.ctimeNanos !== before.ctimeNanos) throw failure('ESTALE', 'configuration changed during read');
      return new Uint8Array(buffer.read(size));
    } finally { buffer.close(); }
  });
}
export function readPrivateConfigurationFile(directory, name) {
  fileName(name);
  return usingFD(openDirectory(directory), fd => read(fd, name));
}
function temporaryName() {
  const buffer = alloc(16);
  try {
    for (let offset = 0; offset < 16;) {
      const view = buffer.slice(offset, 16 - offset);
      let count;
      try { count = Number(retry('random', view, 16 - offset, 0)); } finally { view.close(); }
      if (!count) throw failure('EIO', 'getrandom');
      offset += count;
    }
    return '.configuration-' + Array.from(new Uint8Array(buffer.read(16)),
      byte => byte.toString(16).padStart(2, '0')).join('');
  } finally { buffer.close(); }
}
function fileName(name) {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name))
    throw new TypeError('Configuration requires a plain file name');
  encodeUtf8(name, 255);
}

export function openConfigurationFiles(directory, name) {
  fileName(name);
  let parent = openDirectory(directory), lock = null, closed = false;
  function live() { if (closed) throw failure('EBADF', 'configuration is closed'); }
  function ownedLock() {
    privateObject(status(parent), C.directoryType, call('euid'));
    const held = status(lock), named = status(parent, name + '.lock', C.noFollowStatus);
    privateObject(held, C.regular, call('euid'));
    if (held.inode !== named.inode || held.deviceMajor !== named.deviceMajor ||
        held.deviceMinor !== named.deviceMinor) throw failure('ESTALE', 'configuration writer lock replaced');
  }
  try {
    lock = Number(retry('open', parent, name + '.lock',
      C.readWrite | C.create | C.noFollow | C.nonblock | C.closeOnExec, 0o600));
    privateObject(status(lock), C.regular, call('euid'));
    retry('lock', lock, C.exclusiveLock | C.nonblockingLock);
    ownedLock();
  } catch (error) {
    usingFD(parent, () => {
      if (lock !== null) usingFD(lock, () => { throw error; });
      throw error;
    });
  }
  return Object.freeze({
    read() { live(); ownedLock(); return read(parent, name); },
    write(bytes, initial = false) {
      live(); ownedLock();
      if (!(bytes instanceof Uint8Array)) throw new TypeError('Configuration bytes required');
      if (!initial) {
        const fd = optionalFile(parent, name, C.readWrite);
        if (fd === null) throw failure('ESTALE', 'configuration disappeared');
        usingFD(fd, opened => privateObject(status(opened), C.regular, call('euid')));
      }
      const temporary = temporaryName();
      const output = Number(retry('open', parent, temporary,
        C.writeOnly | C.create | C.exclusive | C.noFollow | C.closeOnExec, 0o600));
      let committed = false, primary = null;
      try {
        usingFD(output, opened => {
          const buffer = alloc(Math.max(1, bytes.length));
          try {
            buffer.write(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
            for (let offset = 0; offset < bytes.length;) {
              const view = buffer.slice(offset, bytes.length - offset);
              let count;
              try { count = Number(retry('write', opened, view, bytes.length - offset)); } finally { view.close(); }
              if (!count) throw failure('EIO', 'zero configuration write');
              offset += count;
            }
            retry('sync', opened);
          } finally { buffer.close(); }
        });
        ownedLock();
        retry('rename', parent, temporary, parent, name, initial ? C.noReplace : 0);
        committed = true;
        retry('sync', parent);
      } catch (error) {
        primary = error;
        error.committed = committed;
        if (committed) error.message += '; configuration published, but directory durability was not confirmed';
        throw error;
      } finally {
        if (!committed) {
          try { retry('unlink', parent, temporary, 0); }
          catch (cleanup) {
            throw Object.assign(new Error(primary.message + '; temporary cleanup failed: ' + cleanup.message),
              { cause: primary, cleanup, code: primary.code, committed: false });
          }
        }
      }
    },
    close() {
      if (closed) return;
      closed = true;
      const held = lock, directory = parent;
      lock = parent = null;
      usingFD(directory, () => usingFD(held, () => {}));
    },
  });
}
