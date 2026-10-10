import { alloc } from 'sysrt:ffi';
import { loadBindings } from './sysrt/sdk/js/native.mjs';
import { encodeUtf8, decodeUtf8 } from './sysrt/sdk/js/encoding.mjs';
import { fileConstants as C } from './sysrt/bindings/files.mjs';
import { errors, failure, raw, call, usingFD, status } from './desktop/shared/native-files.mjs';

const fileDigestBindings = {
  library: 'libcrypto.so.3', target: { pointerSize: 8, longSize: 8 },
  functions: {
    algorithm: { symbol: 'EVP_sha256', result: 'pointer', parameters: [] },
    digest: { symbol: 'EVP_Digest', result: 'i32',
      parameters: ['pointer', 'size', 'pointer', 'pointer', 'pointer', 'pointer'] },
  },
};
const PATH = 4096, NAME = 256, COUNT = 1024, TEXT = 1048576;
const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
let crypto = null, algorithm = null;
function ordinary() {
  const uid = call('uid'), gid = call('gid');
  if (!uid || uid !== call('euid') || gid !== call('egid')) throw failure('EPERM');
  return uid;
}
function execute(operation, args, count, action) {
  if (args.length !== count) throw new TypeError('Wrong filesystem argument count: ' + operation);
  try { ordinary(); return action(); }
  catch (error) { error.operation = operation; throw error; }
}
function bytes(text, maximum, code = 'EINVAL') {
  if (typeof text !== 'string') throw new TypeError('Filesystem requires explicit string arguments');
  if (text.includes('\0')) throw failure(code);
  try { return encodeUtf8(text, maximum); }
  catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) throw failure(code);
    throw error;
  }
}
function pathValue(path) {
  bytes(path, PATH - 1);
  if (!path.startsWith('/') || (path !== '/' && path.slice(1).split('/').some(part =>
    !part || part === '.' || part === '..' || bytes(part, NAME - 1).length === 0))) throw failure('EINVAL');
  return path;
}
function nameValue(name) {
  if (!bytes(name, NAME - 1).length || name.includes('/') || name === '.' || name === '..') throw failure('EINVAL');
  return name;
}
function join(parent, name) { return pathValue((parent === '/' ? '' : parent) + '/' + name); }
function split(path) {
  pathValue(path);
  if (path === '/') throw failure('EINVAL');
  const index = path.lastIndexOf('/');
  return [path.slice(0, index) || '/', path.slice(index + 1)];
}
function identity(s) {
  return [s.deviceMajor, s.deviceMinor, s.inode, s.links, s.mode.toString(8), s.size,
    s.mtimeSeconds, s.mtimeNanos, s.ctimeSeconds, s.ctimeNanos].join(':');
}
function matches(s, expected) {
  if (!s.links) throw failure('ESTALE');
  if (!bytes(expected, 191).length) throw failure('EINVAL');
  if (identity(s) !== expected) throw failure('ESTALE');
}
function kind(mode) {
  const type = mode & C.typeMask;
  return type === C.regular ? 'file' : type === C.directoryType ? 'directory' :
    type === C.symbolicLink ? 'symlink' : 'other';
}
function linkTarget(fd, name) {
  const buffer = alloc(PATH - 1);
  try {
    const length = Number(call('linkTarget', fd, name, buffer, PATH - 1));
    if (length === PATH - 1) throw failure('ENAMETOOLONG');
    try { return decodeUtf8(new Uint8Array(buffer.read(length))); }
    catch (error) { if (error instanceof TypeError) throw failure('EILSEQ'); throw error; }
  } finally { buffer.close(); }
}
function fdPath(fd) {
  if (!status(fd).links) throw failure('ESTALE');
  return pathValue(linkTarget(C.currentDirectory, '/proc/self/fd/' + fd));
}
function directory(path, expected, action) {
  pathValue(path);
  return usingFD(Number(call('open', C.currentDirectory, path,
    C.readOnly | C.directory | C.closeOnExec, 0)), fd => {
    if (expected !== null) matches(status(fd), expected);
    return action(fd, fdPath(fd));
  });
}
function accessible(fd, name, mode) {
  const result = raw('access', fd, name, mode, C.effectiveAccess);
  if (result.value === 0) return true;
  if ([1, 2, 13, 20, 40].includes(result.errno)) return false;
  throw failure(errors[result.errno] ?? 'ERR_OS_' + result.errno, 'faccessat');
}
function describe(fd, name, path) {
  const s = status(fd, name, C.noFollowStatus);
  const type = kind(s.mode);
  if (s.size > BigInt(Number.MAX_SAFE_INTEGER)) throw failure('EOVERFLOW', 'file size');
  const entry = {
    name, path, identity: identity(s), type, permissions: (s.mode & 0o7777).toString(8).padStart(4, '0'),
    bytes: Number(s.size), mtimeMs: Number(s.mtimeSeconds) * 1000 + s.mtimeNanos / 1000000,
    uid: s.uid, gid: s.gid, readable: false, writable: false,
    linkTarget: '', targetType: '', targetIdentity: '', targetError: null,
  };
  if (type === 'symlink') {
    entry.linkTarget = linkTarget(fd, name);
    try {
      const target = status(fd, name, 0);
      entry.targetType = kind(target.mode); entry.targetIdentity = identity(target);
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'EPERM', 'ELOOP', 'ENOTDIR'].includes(error.code)) throw error;
      entry.targetType = 'unavailable'; entry.targetError = error.code;
    }
  } else {
    const search = type === 'directory' ? 1 : 0;
    entry.readable = accessible(fd, name, 4 | search);
    entry.writable = accessible(fd, name, 2 | search);
  }
  return entry;
}
function inspect(path, follow) {
  if (typeof follow !== 'boolean') throw new TypeError('stat followLinks must be boolean');
  pathValue(path);
  if (path === '/') return directory(path, null, fd => ({ ...describe(fd, '.', '/'), name: '/' }));
  const [parent, name] = split(path);
  const entry = directory(parent, null, (fd, canonical) => describe(fd, name, join(canonical, name)));
  if (!follow || entry.type !== 'symlink') return entry;
  return usingFD(Number(call('open', C.currentDirectory, path, C.pathOnly | C.closeOnExec, 0)),
    fd => inspect(fdPath(fd), false));
}
function list(path, expected) {
  return directory(path, expected, (fd, canonical) => {
    const token = identity(status(fd)), entries = [], buffer = alloc(32768);
    let complete = true;
    try {
      outer: for (;;) {
        const length = Number(call('entries', fd, buffer, 32768));
        if (!length) break;
        const data = new Uint8Array(buffer.read(length)), view = new DataView(data.buffer);
        for (let offset = 0; offset < length;) {
          if (length - offset < 20) throw failure('EIO', 'directory record');
          const size = view.getUint16(offset + 16, littleEndian);
          if (size < 20 || size % 8 || size > length - offset) throw failure('EIO', 'directory record');
          const field = data.subarray(offset + 19, offset + size), end = field.indexOf(0);
          if (end < 0) throw failure('EIO', 'directory name terminator');
          let name;
          try { name = decodeUtf8(field.subarray(0, end)); }
          catch (error) { if (error instanceof TypeError) throw failure('EILSEQ'); throw error; }
          offset += size;
          if (name === '.' || name === '..') continue;
          if (entries.length === COUNT) { complete = false; break outer; }
          nameValue(name);
          entries.push(describe(fd, name, join(canonical, name)));
        }
      }
      matches(status(fd), token);
      return { version: 1, path: canonical, identity: token, entries, complete };
    } finally { buffer.close(); }
  });
}
function digest(buffer, size) {
  if (!crypto) {
    const bindings = loadBindings(fileDigestBindings);
    const method = bindings.call('algorithm').value;
    if (!method) { bindings.close(); throw failure('EIO', 'EVP_sha256'); }
    crypto = bindings; algorithm = method;
  }
  const output = alloc(32), length = alloc(4);
  try {
    if (crypto.call('digest', buffer, size, output, length, algorithm, null).value !== 1 ||
        new DataView(length.read(4)).getUint32(0, littleEndian) !== 32) throw failure('EIO', 'EVP_Digest');
    return Array.from(new Uint8Array(output.read(32)), byte => byte.toString(16).padStart(2, '0')).join('');
  } finally { output.close(); length.close(); }
}
function readRegular(fd, expected) {
  const before = status(fd);
  matches(before, expected);
  if (kind(before.mode) !== 'file' || before.size > BigInt(TEXT)) throw failure('EFBIG');
  const size = Number(before.size), buffer = alloc(size + 1);
  try {
    for (let offset = 0; offset < size;) {
      const view = buffer.slice(offset, size - offset);
      let result;
      try { result = raw('read', fd, view, size - offset); } finally { view.close(); }
      if (result.value < 0 && result.errno === 4) continue;
      if (result.value < 0) throw failure(errors[result.errno] ?? 'ERR_OS_' + result.errno, 'read');
      if (!result.value) throw failure('ESTALE');
      offset += Number(result.value);
    }
    const tail = buffer.slice(size, 1);
    try {
      let result;
      do { result = raw('read', fd, tail, 1); } while (result.value < 0 && result.errno === 4);
      if (result.value < 0) throw failure(errors[result.errno] ?? 'ERR_OS_' + result.errno, 'read');
      if (result.value) throw failure('ESTALE');
    } finally { tail.close(); }
    matches(status(fd), expected);
    let text;
    try { text = decodeUtf8(new Uint8Array(buffer.read(size))); }
    catch (error) { if (error instanceof TypeError) throw failure('EILSEQ'); throw error; }
    if (text.includes('\0')) throw failure('EILSEQ');
    return { text, contentIdentity: 'sha256:' + expected + ':' + digest(buffer, size) };
  } finally { buffer.close(); }
}
function readFile(path, expected) {
  const entry = inspect(path, false);
  if (entry.type !== 'file') throw failure('EINVAL');
  bytes(expected, 255);
  const strong = expected.startsWith('sha256:');
  if (!expected || (!strong && expected !== entry.identity)) throw failure('ESTALE');
  return usingFD(Number(call('open', C.currentDirectory, entry.path,
    C.readOnly | C.noFollow | C.nonblock | C.closeOnExec, 0)), fd => {
    const observed = readRegular(fd, entry.identity);
    if (strong && observed.contentIdentity !== expected) throw failure('ESTALE');
    return { ...entry, text: observed.text, contentIdentity: observed.contentIdentity,
      ...(strong ? { metadataIdentity: entry.identity, identity: observed.contentIdentity } : {}) };
  });
}
function writableTarget(fd, name, expected) {
  let target;
  try { target = Number(call('open', fd, name, C.readWrite | C.noFollow | C.nonblock | C.closeOnExec, 0)); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ELOOP') throw failure('ESTALE'); throw error; }
  return usingFD(target, opened => {
    const s = status(opened);
    if (kind(s.mode) !== 'file' || s.uid !== call('euid') || (s.mode & 0o6000)) throw failure('EPERM');
    if (readRegular(opened, identity(s)).contentIdentity !== expected) throw failure('ESTALE');
    return s.mode & 0o777;
  });
}
function randomName() {
  const buffer = alloc(16);
  try {
    let result;
    do { result = raw('random', buffer, 16, 0); } while (result.value < 0 && result.errno === 4);
    if (result.value !== 16n) throw failure(result.value < 0 ? errors[result.errno] ?? 'ERR_OS_' + result.errno : 'EIO', 'getrandom');
    return '.polly-save-' + Array.from(new Uint8Array(buffer.read(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  } finally { buffer.close(); }
}
function publish(parent, name, text, expectedParent, expected = null) {
  nameValue(name);
  if (!bytes(expectedParent, 191).length) throw failure('EINVAL');
  if (typeof text !== 'string') throw new TypeError('Text must be a string');
  if (text.includes('\0')) throw failure('EILSEQ');
  let encoded;
  try { encoded = encodeUtf8(text, TEXT); }
  catch (error) {
    if (error instanceof RangeError) throw failure('EFBIG');
    if (error instanceof TypeError) throw failure('EILSEQ');
    throw error;
  }
  let committed = false;
  const publishInDirectory = (fd, canonical) => {
    const full = join(canonical, name), parentStatus = status(fd);
    const mode = expected === null ? 0o600 : writableTarget(fd, name, expected);
    const temporary = randomName();
    const output = Number(call('open', fd, temporary, C.writeOnly | C.create | C.exclusive |
      C.noFollow | C.closeOnExec, 0o600));
    let primary = null, renamed = false;
    try {
      usingFD(output, opened => {
        const buffer = alloc(Math.max(1, encoded.length));
        try {
          buffer.write(encoded.buffer);
          for (let offset = 0; offset < encoded.length;) {
            const view = buffer.slice(offset, encoded.length - offset);
            let result;
            try { result = raw('write', opened, view, encoded.length - offset); } finally { view.close(); }
            if (result.value < 0 && result.errno === 4) continue;
            if (result.value <= 0) throw failure(result.value < 0 ? errors[result.errno] ?? 'ERR_OS_' + result.errno : 'EIO', 'write');
            offset += Number(result.value);
          }
          call('sync', opened); call('mode', opened, mode); call('sync', opened);
        } finally { buffer.close(); }
      });
      if (expected !== null) {
        let current;
        try { current = status(C.currentDirectory, canonical, 0); }
        catch (error) { if (error.code === 'ENOENT') throw failure('ESTALE'); throw error; }
        if (current.deviceMajor !== parentStatus.deviceMajor || current.deviceMinor !== parentStatus.deviceMinor ||
            current.inode !== parentStatus.inode) throw failure('ESTALE');
        writableTarget(fd, name, expected);
        call('rename', fd, temporary, fd, name, 0); renamed = true;
      } else call('link', fd, temporary, fd, name, 0);
      committed = true;
    } catch (error) { primary = error; throw error; }
    finally {
      if (!renamed) {
        try { call('unlink', fd, temporary, 0); }
        catch (cleanup) {
          throw Object.assign(new Error((primary ? primary.message + '; ' : '') +
            'Cannot remove staged file: ' + cleanup.message),
          { code: primary?.code ?? cleanup.code, cause: primary ?? cleanup, cleanup, committed });
        }
      }
    }
    return describe(fd, name, full);
  };
  try { return directory(parent, expectedParent, publishInDirectory); }
  catch (error) { if (committed) error.committed = true; throw error; }
}

export const fileSystem = Object.freeze({
  version: 1, implementation: 'desktop-files-v1', maxEntries: COUNT, maxTextBytes: TEXT,
  overwrite: true, textObservation: 'sha256-v1',
  locations(...args) {
    return execute('locations', args, 0, () => {
      const pointer = raw('environment', 'HOME').value;
      if (!pointer) throw failure('EINVAL', 'HOME');
      try {
        const size = Number(call('stringLength', pointer, PATH));
        if (size === PATH) throw failure('ENAMETOOLONG', 'HOME');
        const buffer = alloc(Math.max(size, 1));
        try {
          raw('copy', buffer, pointer, size).value.close();
          const home = pathValue(decodeUtf8(new Uint8Array(buffer.read(size))));
          return { home, documents: join(home, 'Documents'), downloads: join(home, 'Downloads'), desktop: join(home, 'Desktop') };
        } finally { buffer.close(); }
      } finally { pointer.close(); }
    });
  },
  stat(...args) { return execute('stat', args, 2, () => inspect(...args)); },
  listDirectory(...args) { return execute('listDirectory', args, 2, () => list(...args)); },
  readText(...args) { return execute('readText', args, 2, () => readFile(...args)); },
  observeText(...args) {
    return execute('observeText', args, 1, () => {
      const entry = inspect(args[0], false), read = readFile(args[0], entry.identity);
      const { text, ...value } = read;
      return { ...value, metadataIdentity: entry.identity, identity: read.contentIdentity };
    });
  },
  writeText(...args) { return execute('writeText', args, 4, () => publish(...args)); },
  replaceText(...args) {
    return execute('replaceText', args, 4, () => {
      const [path, text, expected, parent] = args;
      if (!bytes(expected, 255).length || !expected.startsWith('sha256:')) throw failure('EINVAL');
      const [directory, name] = split(path);
      return publish(directory, name, text, parent, expected);
    });
  },
  createDirectory(...args) {
    return execute('createDirectory', args, 3, () => {
      const [parent, name, expected] = args; nameValue(name);
      if (!bytes(expected, 191).length) throw failure('EINVAL');
      return directory(parent, expected, (fd, canonical) => {
        const path = join(canonical, name);
        call('mkdir', fd, name, 0o700);
        return describe(fd, name, path);
      });
    });
  },
  rename(...args) {
    return execute('rename', args, 4, () => {
      const [path, name, expected, expectedParent] = args, [parent, old] = split(path);
      nameValue(name);
      if (!bytes(expectedParent, 191).length) throw failure('EINVAL');
      return directory(parent, expectedParent, (fd, canonical) => {
        const full = join(canonical, name), s = status(fd, old, C.noFollowStatus);
        matches(s, expected);
        if (s.uid !== call('euid') || kind(s.mode) === 'other') throw failure('EPERM');
        call('rename', fd, old, fd, name, C.noReplace);
        return describe(fd, name, full);
      });
    });
  },
});
