import { alloc } from 'sysrt:ffi';
import { createFileSystem, constants as C } from './sysrt/sdk/js/files.mjs';
import { createThemeResources, checkThemeOwner } from './desktop/shared/theme-resources.mjs';
import { call, raw, usingFD, status } from './desktop/shared/native-files.mjs';

function check(value, message) { if (!value) throw new Error(message); }
function rejects(action, message) {
  let rejected = false;
  try { action(); } catch (error) { rejected = true; }
  check(rejected, message);
}
function environment(name) {
  const pointer = raw('environment', name).value;
  try {
    const size = Number(call('stringLength', pointer, 4096)), buffer = alloc(size + 1);
    try {
      raw('copy', buffer, pointer, size).value.close();
      return buffer.readString(size + 1);
    } finally { buffer.close(); }
  } finally { pointer.close(); }
}
const home = environment('HOME');
check(home.startsWith('/tmp/polly-theme-sdk-'), 'Only private fixture paths are used');
const fs = createFileSystem();
let authorized = true, checks = 0, closed = 0, serial = 0, large = false, dimension = false;
function authorize() { checks++; if (!authorized) throw new Error('No Shell authority'); }
const service = createThemeResources(authorize, (bytes, limit) => {
  check(bytes instanceof Uint8Array && (bytes.length === 4 * 1024 * 1024 ||
    bytes.slice(0, 3).join(',') === '0,255,128'), 'Native read keeps binary bytes and exact length');
  const width = dimension ? 4097 : large ? 4096 : 2, height = large ? 2048 : 2;
  if (width * height > limit) throw new RangeError('Decoder pixel limit');
  return Object.freeze({ key: 'fixture:' + ++serial, width, height, close() { closed++; } });
});
function move(from, to) { call('rename', C.AT_FDCWD, from, C.AT_FDCWD, to, C.RENAME_NOREPLACE); }
const themes = home + '/data/pollyui/themes', active = themes + '/fixture';
function scenario(name, action, target = active) {
  const source = home + '/cases/' + name;
  move(source, target);
  try { return action(); } finally { move(target, source); }
}
function descriptorCount() {
  const buffer = alloc(32768), little = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
  try {
    return usingFD(Number(call('open', C.AT_FDCWD, '/proc/self/fd', C.O_RDONLY | C.O_DIRECTORY, 0)), fd => {
      let count = 0;
      for (;;) {
        const length = Number(call('entries', fd, buffer, 32768));
        if (!length) return count;
        const bytes = new Uint8Array(buffer.read(length)), view = new DataView(bytes.buffer);
        for (let offset = 0; offset < length;) {
          const size = view.getUint16(offset + 16, little);
          check(size >= 20 && size <= length - offset, 'Descriptor record');
          count++; offset += size;
        }
      }
    });
  } finally { buffer.close(); }
}
scenario('valid', () => {
  const result = service.readThemeFiles();
  check(result.files.length === 1 && result.files[0].id === 'fixture' &&
    result.files[0].text === '{"theme":"fixture"}' && result.overrides === '{"overrides":"fixture"}',
  'Catalog contract uses actual user-owned definitions and overrides');
  const key = service.loadThemeAsset('fixture', 'nested/bitmap.jpg');
  service.releaseThemeAsset(key);
  rejects(() => service.releaseThemeAsset(key), 'No duplicate release');
  rejects(() => service.releaseThemeAsset(key, 1), 'Exact release argument count');
  for (const id of ['../fixture', 'Fixture', 'a\n', 'a\0', 'a'.repeat(65)])
    rejects(() => service.loadThemeAsset(id, 'bitmap.png'), 'Invalid theme identifier');
  for (const path of ['/bitmap.png', '../bitmap.png', '.hidden/a.png', 'nested//bitmap.jpg',
    'nested/', 'a.svg', 'a\0.png', 'a\n.png', 'a/'.repeat(8) + 'x.png', 'a'.repeat(193) + '.png',
    'asset-link.png', 'directory-link/bitmap.jpg', 'huge.png', 'missing.png'])
    rejects(() => service.loadThemeAsset('fixture', path), 'Reject unsupported or unsafe bitmap path: ' + path);
  rejects(() => service.loadThemeAsset('fixture'), 'Exact load argument count');
  for (const path of ['bitmap.png', 'nested']) {
    const fd = Number(call('open', C.AT_FDCWD, active + '/' + path, C.O_RDONLY | C.O_NOFOLLOW, 0));
    usingFD(fd, opened => {
      const original = status(opened).mode & 0o777;
      call('mode', opened, original | 0o022);
      try {
        rejects(() => service.loadThemeAsset('fixture', path === 'nested' ? 'nested/bitmap.jpg' : path),
          'Asset directories and files use the same ownership policy');
      } finally { call('mode', opened, original); }
    });
  }
  const limitKey = service.loadThemeAsset('fixture', 'limit.png');
  service.releaseThemeAsset(limitKey);
  const keys = Array.from({ length: 8 }, () => service.loadThemeAsset('fixture', 'bitmap.png'));
  rejects(() => service.loadThemeAsset('fixture', 'bitmap.png'), 'Eight live assets is the exact limit');
  for (const key of keys) service.releaseThemeAsset(key);
  const again = service.loadThemeAsset('fixture', 'bitmap.png'); service.releaseThemeAsset(again);
  large = true;
  const first = service.loadThemeAsset('fixture', 'bitmap.png'), second = service.loadThemeAsset('fixture', 'bitmap.png');
  rejects(() => service.loadThemeAsset('fixture', 'bitmap.png'), 'Sixteen Mi pixels is the total limit');
  service.releaseThemeAsset(first);
  const replacement = service.loadThemeAsset('fixture', 'bitmap.png');
  service.releaseThemeAsset(second); service.releaseThemeAsset(replacement);
  large = false; dimension = true;
  const beforeClose = closed;
  rejects(() => service.loadThemeAsset('fixture', 'bitmap.png'), 'Desktop dimension policy stays in JS');
  check(closed === beforeClose + 1, 'Rejected decoded bitmap is immediately released');
  dimension = false;
});
scenario('limit', () => check(service.readThemeFiles().files[0].text.length === 128 * 1024, 'Exact definition limit'));
scenario('missing', () => check(service.readThemeFiles().files.length === 0, 'Missing definition is optional'));
for (const name of ['oversized', 'empty', 'nul', 'invalid-utf8', 'writable', 'writable-directory',
  'symlink-file', 'fifo', 'directory-link'])
  scenario(name, () => rejects(() => service.readThemeFiles(), 'Reject definition policy: ' + name));
scenario('invalid-name', () => rejects(() => service.readThemeFiles(), 'Invalid catalog directory name'), themes + '/Fixture');
move(themes, home + '/empty-themes');
try {
  for (const [name, count] of [['total', 4], ['count', 64]]) scenario(name, () => {
    const extra = themes + '/theme-' + count;
    move(extra, home + '/extra');
    try { check(service.readThemeFiles().files.length === count, 'Exact catalog limit: ' + name); }
    finally { move(home + '/extra', extra); }
    rejects(() => service.readThemeFiles(), 'Over-limit catalog: ' + name);
  }, themes);
} finally { move(home + '/empty-themes', themes); }
const uid = call('euid');
usingFD(Number(call('open', C.AT_FDCWD, '/', C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW, 0)), fd => {
  const info = status(fd);
  check(info.uid !== uid, 'Actual foreign-owned descriptor metadata');
  rejects(() => checkThemeOwner(info, uid), 'Production ownership check rejects actual foreign UID');
});
const override = home + '/config/pollyui/theme-overrides.json';
const descriptor = Number(call('open', C.AT_FDCWD, override, C.O_RDONLY | C.O_NOFOLLOW, 0));
usingFD(descriptor, fd => {
  call('mode', fd, 0o622);
  try { rejects(() => service.readThemeFiles(), 'Unsafe override ownership policy'); }
  finally { call('mode', fd, 0o600); }
});
move(override, override + '.saved');
try {
  call('symlink', 'theme-overrides.json.saved', C.AT_FDCWD, override);
  try { rejects(() => service.readThemeFiles(), 'Override symlink is rejected'); }
  finally { call('unlink', C.AT_FDCWD, override, 0); }
} finally { move(override + '.saved', override); }
const polly = home + '/data/pollyui';
usingFD(Number(call('open', C.AT_FDCWD, polly, C.O_RDONLY | C.O_DIRECTORY, 0)), fd => {
  call('mode', fd, 0o722);
  try { rejects(() => service.readThemeFiles(), 'PollyUI root must not be writable by others'); }
  finally { call('mode', fd, 0o700); }
});
const before = descriptorCount();
for (let index = 0; index < 20; index++) {
  scenario('valid', () => {
    service.readThemeFiles();
    const key = service.loadThemeAsset('fixture', 'bitmap.png'); service.releaseThemeAsset(key);
    rejects(() => service.loadThemeAsset('fixture', 'directory-link/bitmap.jpg'), 'Cleanup after nested link failure');
  });
  scenario('oversized', () => rejects(() => service.readThemeFiles(), 'Cleanup after size rejection'));
}
check(descriptorCount() === before, 'All success and failure paths release actual SDK descriptors');
authorized = false;
const beforeChecks = checks;
rejects(() => service.readThemeFiles(), 'Read requires current Shell authority');
rejects(() => service.loadThemeAsset('fixture', 'bitmap.png'), 'Load requires current Shell authority');
rejects(() => service.releaseThemeAsset('unknown'), 'Release requires current Shell authority');
check(checks === beforeChecks + 3 && descriptorCount() === before, 'Every unauthorized call checks before opening files');
fs.dispose();
