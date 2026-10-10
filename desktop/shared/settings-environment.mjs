import { alloc } from 'sysrt:ffi';
import { decodeUtf8 } from './sysrt/sdk/js/encoding.mjs';
import { fileConstants as C } from './sysrt/bindings/files.mjs';
import { call, raw, status, usingFD, errors, failure } from './desktop/shared/native-files.mjs';

function environment(name) {
  const pointer = raw('environment', name).value;
  if (pointer === null) return '';
  try {
    const size = Number(call('stringLength', pointer, 4096));
    if (size === 4096) throw new TypeError(name + ' exceeds the Settings environment bound');
    const buffer = alloc(size + 1);
    try {
      raw('copy', buffer, pointer, size).value.close();
      return decodeUtf8(new Uint8Array(buffer.read(size)));
    } finally { buffer.close(); }
  } finally { pointer.close(); }
}
function absolute(path) {
  if (!path.startsWith('/') || path.includes('\0') || path.split('/').some(part => part === '.' || part === '..'))
    throw new TypeError('Settings requires canonical absolute session paths');
  return path;
}
export function settingsEnvironment() {
  const address = environment('POLLY_SESSION_BUS_ADDRESS'), ambient = environment('DBUS_SESSION_BUS_ADDRESS');
  const runtime = absolute(environment('XDG_RUNTIME_DIR')), uid = call('uid');
  if (!address || address !== ambient) throw new Error('Settings requires the owned private session bus, not an ambient bus');
  const match = /^unix:path=([^,;]+)(?:,guid=[a-fA-F0-9]{32})?$/.exec(address);
  if (!match) throw new TypeError('Settings requires one explicit unix:path private session bus');
  const path = match[1].replace(/%([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  if (absolute(path) !== runtime + '/bus') throw new TypeError('Settings bus must be XDG_RUNTIME_DIR/bus');
  const fd = call('open', C.currentDirectory, runtime, C.pathOnly | C.directory | C.noFollow | C.closeOnExec, 0);
  usingFD(fd, directory => {
    const info = status(directory);
    if ((info.mode & C.typeMask) !== C.directoryType || info.uid !== uid || (info.mode & 0o777) !== 0o700)
      throw new TypeError('Settings runtime directory must be owned by this UID and mode 0700');
    const socket = status(directory, 'bus', C.noFollowStatus);
    if ((socket.mode & C.typeMask) !== 0o140000 || socket.uid !== uid)
      throw new TypeError('Settings private bus must be a same-UID Unix socket, not a symlink');
  });
  return { address, uid, pid: Number(readLink('/proc/self')) };
}
function readLink(path) {
  const buffer = alloc(4096);
  try {
    const size = Number(call('linkTarget', C.currentDirectory, path, buffer, 4096));
    if (!size || size === 4096) throw new Error('Settings native path exceeds its bound');
    return decodeUtf8(new Uint8Array(buffer.read(size)));
  } finally { buffer.close(); }
}
export function settingsLaunchSpec() {
  const executable = absolute(readLink('/proc/self/exe'));
  const candidate = raw('open', C.currentDirectory, application.moduleRoot,
    C.pathOnly | C.directory | C.closeOnExec, 0);
  let root;
  if (candidate.value >= 0) root = usingFD(candidate.value, fd => absolute(readLink('/proc/self/fd/' + fd)));
  else if (candidate.errno === 2 || candidate.errno === 20) root = absolute(readLink('/proc/self/cwd'));
  else throw failure(errors[candidate.errno] || 'ERR_OS_' + candidate.errno, 'Settings shared module root');
  const main = root + '/desktop/apps/settings/main.mjs';
  const info = status(C.currentDirectory, main, C.noFollowStatus);
  if ((info.mode & C.typeMask) !== C.regular) throw new TypeError('Standalone Settings entry is missing from the module root');
  return { argv: [executable, '--app-id', 'org.pollyui.settings', main, '--managed'], cwd: root };
}
