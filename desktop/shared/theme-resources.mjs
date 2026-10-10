import { alloc } from 'sysrt:ffi';
import { encodeUtf8, decodeUtf8 } from './sysrt/sdk/js/encoding.mjs';
import { fileConstants as C } from './sysrt/bindings/files.mjs';
import { call, raw, usingFD, status, errors, failure } from './desktop/shared/native-files.mjs';

const DEFINITION = 128 * 1024, TOTAL = 512 * 1024, BINARY = 4 * 1024 * 1024;
const PIXELS = 16 * 1024 * 1024, SINGLE_PIXELS = 8 * 1024 * 1024;
const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const identifier = id => typeof id === 'string' && id.length <= 64 &&
  /^[a-z]/.test(id) && !/[^a-z0-9_-]/.test(id);
const directoryFlags = C.readOnly | C.directory | C.noFollow | C.closeOnExec;

export function checkThemeOwner(info, uid) {
  if (info.uid !== uid || (info.mode & 0o022))
    throw new TypeError('Theme paths must be user-owned and not writable by other users');
}

function environment(name) {
  const pointer = raw('environment', name).value;
  if (!pointer) return '';
  try {
    const size = Number(call('stringLength', pointer, 4096));
    if (size === 4096) throw new TypeError(name + ' must be a bounded absolute path');
    const buffer = alloc(Math.max(1, size));
    try {
      raw('copy', buffer, pointer, size).value.close();
      return decodeUtf8(new Uint8Array(buffer.read(size)));
    } finally { buffer.close(); }
  } finally { pointer.close(); }
}
function optionalOpen(parent, name, flags) {
  const result = raw('open', parent, name, flags, 0);
  if (result.value >= 0) return result.value;
  if (result.errno === 2) return null;
  throw failure(errors[result.errno] ?? 'ERR_OS_' + result.errno, 'open theme path');
}
function directory(parent, name, uid, action) {
  const fd = optionalOpen(parent, name, directoryFlags);
  if (fd === null) return null;
  return usingFD(fd, opened => {
    const info = status(opened);
    if ((info.mode & C.typeMask) !== C.directoryType) throw new TypeError('Theme directory required');
    checkThemeOwner(info, uid);
    return action(opened);
  });
}
function root(variable, fallback, child, uid, action) {
  let path = environment(variable);
  if (!path) {
    const home = environment('HOME');
    if (!home.startsWith('/')) throw new TypeError('Theme paths require an absolute HOME');
    path = home + '/' + fallback;
  }
  if (!path.startsWith('/') || encodeUtf8(path, 4095).length === 0)
    throw new TypeError(variable + ' must be a bounded absolute path');
  const parts = path.split('/').filter(Boolean);
  if (parts.some(part => part === '.' || part === '..'))
    throw new TypeError('Theme paths cannot contain relative components');
  // Iterative traversal keeps even a maximal XDG path from exhausting the JS stack.
  let fd = Number(call('open', C.currentDirectory, '/', directoryFlags, 0));
  try {
    for (const part of parts) {
      const next = optionalOpen(fd, part, directoryFlags);
      const previous = fd; fd = next;
      usingFD(previous, () => {});
      if (fd === null) return null;
    }
    return directory(fd, 'pollyui', uid, polly => child ?
      directory(polly, child, uid, action) : action(polly));
  } finally {
    if (fd !== null) usingFD(fd, () => {});
  }
}
function readFile(parent, name, limit, text, uid) {
  const fd = optionalOpen(parent, name, C.readOnly | C.noFollow | C.nonblock | C.closeOnExec);
  if (fd === null) return null;
  return usingFD(fd, opened => {
    const info = status(opened);
    if ((info.mode & C.typeMask) !== C.regular || info.size < 1n || info.size > BigInt(limit))
      throw new TypeError('Theme definitions must be bounded, regular, user-owned files');
    checkThemeOwner(info, uid);
    const size = Number(info.size), buffer = alloc(size + 1);
    try {
      for (let offset = 0; offset < size;) {
        const view = buffer.slice(offset, size - offset);
        let result;
        try { result = raw('read', opened, view, size - offset); } finally { view.close(); }
        if (result.value < 0 && result.errno === 4) continue;
        if (result.value <= 0) throw new Error('Theme definition changed or could not be read');
        offset += Number(result.value);
      }
      const tail = buffer.slice(size, 1);
      try {
        let result;
        do { result = raw('read', opened, tail, 1); } while (result.value < 0 && result.errno === 4);
        if (result.value !== 0n) throw new TypeError('Theme definition grew or could not be read');
      } finally { tail.close(); }
      const bytes = new Uint8Array(buffer.read(size));
      if (text && bytes.includes(0)) throw new TypeError('Theme definition contains a NUL');
      return { value: text ? decodeUtf8(bytes) : bytes, size };
    } finally { buffer.close(); }
  });
}
function eachEntry(fd, action) {
  const buffer = alloc(32768);
  try {
    for (;;) {
      const length = Number(call('entries', fd, buffer, 32768));
      if (!length) break;
      const bytes = new Uint8Array(buffer.read(length)), view = new DataView(bytes.buffer);
      for (let offset = 0; offset < length;) {
        if (length - offset < 20) throw failure('EIO', 'theme directory record');
        const size = view.getUint16(offset + 16, littleEndian);
        if (size < 20 || size % 8 || size > length - offset) throw failure('EIO', 'theme directory record');
        const field = bytes.subarray(offset + 19, offset + size), end = field.indexOf(0);
        if (end < 0) throw failure('EIO', 'theme directory name');
        const name = decodeUtf8(field.subarray(0, end));
        offset += size;
        if (!name.startsWith('.')) action(name);
      }
    }
  } finally { buffer.close(); }
}
function assetPath(id, path) {
  if (!identifier(id) || typeof path !== 'string' || !path.length || path.length > 192 ||
      !/\.(png|jpe?g)$/i.test(path)) throw new TypeError('Invalid theme bitmap path');
  const parts = path.split('/');
  if (parts.length > 8 || parts.some(part => !part || part.startsWith('.') || /[^A-Za-z0-9_.-]/.test(part)))
    throw new TypeError('Theme asset paths cannot contain hidden or relative components');
  return parts;
}

export function createThemeResources(authorize, decode) {
  if (typeof authorize !== 'function' || typeof decode !== 'function')
    throw new TypeError('Theme resources require native authority and a GUI bitmap decoder');
  const assets = new Map();
  let pixels = 0;
  return Object.freeze({
    readThemeFiles() {
      authorize();
      const uid = call('euid'), files = [];
      let total = 0;
      root('XDG_DATA_HOME', '.local/share', 'themes', uid, fd => eachEntry(fd, id => {
        const info = status(fd, id, C.noFollowStatus), type = info.mode & C.typeMask;
        if (type === C.symbolicLink) throw new TypeError('Theme directory links are not supported');
        if (type !== C.directoryType) return;
        if (!identifier(id)) throw new TypeError('Invalid theme directory name');
        const read = directory(fd, id, uid, child => {
          const file = readFile(child, 'theme.json', DEFINITION, true, uid);
          if (!file) return false;
          total += file.size;
          if (files.length >= 64 || total > TOTAL) throw new RangeError('Theme catalog file limits exceeded');
          files.push({ id, text: file.value });
          return true;
        });
        if (read === null) throw new Error('Theme directory disappeared');
      }));
      const overrides = root('XDG_CONFIG_HOME', '.config', null, uid,
        fd => readFile(fd, 'theme-overrides.json', DEFINITION, true, uid)?.value ?? null);
      return { files, overrides };
    },
    loadThemeAsset(...args) {
      authorize();
      if (args.length !== 2) throw new TypeError('Theme asset requires an ID and relative bitmap path');
      const [id, path] = args;
      const parts = assetPath(id, path), uid = call('euid');
      if (assets.size >= 8) throw new RangeError('Theme asset limit reached');
      const read = (fd, index) => {
        if (index === parts.length - 1) return readFile(fd, parts[index], BINARY, false, uid);
        return directory(fd, parts[index], uid, child => read(child, index + 1));
      };
      const file = root('XDG_DATA_HOME', '.local/share', 'themes', uid,
        fd => directory(fd, id, uid, child => read(child, 0)));
      if (!file) throw new TypeError('Theme bitmap or resource directory is missing');
      const bitmap = decode(file.value, Math.min(SINGLE_PIXELS, PIXELS - pixels));
      if (bitmap.width > 4096 || bitmap.height > 4096) {
        bitmap.close();
        throw new TypeError('Theme bitmap exceeds supported dimensions');
      }
      assets.set(bitmap.key, bitmap);
      pixels += bitmap.width * bitmap.height;
      return bitmap.key;
    },
    releaseThemeAsset(...args) {
      authorize();
      if (args.length !== 1 || typeof args[0] !== 'string') throw new TypeError('A live theme asset key is required');
      const [key] = args;
      const bitmap = assets.get(key);
      if (!bitmap) throw new TypeError('Theme asset is no longer owned');
      bitmap.close();
      assets.delete(key);
      pixels -= bitmap.width * bitmap.height;
    },
  });
}
