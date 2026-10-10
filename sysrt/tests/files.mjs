import { fileSystem as fs } from './sysrt/sdk/js/files.mjs';
import { filesBindings, fileConstants } from './sysrt/bindings/files.mjs';
import { loadBindings } from './sysrt/sdk/js/native.mjs';
import { libc } from 'sysrt:ffi';

function check(value, message) { if (!value) throw new Error(message); }
function refuses(action, code) {
  try { action(); } catch (error) {
    check(!code || error.code === code, 'Expected ' + code + ', got ' + error.code + ': ' + error.message + '\n' + error.stack);
    return error;
  }
  throw new Error('Expected filesystem refusal');
}
const oracle = loadBindings({ library: fixtureLibrary, functions: {
  offset: { symbol: 'sr_statx_offset', result: 'size', parameters: ['i32'] },
  retire: { symbol: 'sr_retire_on_entries', result: 'void', parameters: ['cstring'] },
  failClose: { symbol: 'sr_fail_close', result: 'void', parameters: ['cstring'] },
  uid: { symbol: 'getuid', result: 'u32', parameters: [] },
}});
const configuration = filesBindings[libc];
const fields = Object.values(configuration.layouts.statx.fields);
fields.forEach((field, index) =>
  check(Number(oracle.call('offset', index).value) === field.offset, 'Measured statx field ' + index));
check(Number(oracle.call('offset', fields.length).value) === configuration.layouts.statx.byteLength, 'Measured statx size');
Object.values(fileConstants).forEach((value, index) => {
  const expected = BigInt(value) + (value < 0 ? 18446744073709551616n : 0n);
  const actual = oracle.call('offset', fields.length + 1 + index).value;
  check(expected === actual, 'Measured Linux constant ' + index + ': expected ' + expected + ', actual ' + actual);
});
check(fs.implementation === 'linux-ffi-v1' && fs.maxEntries === 1024 && fs.maxTextBytes === 1048576, 'New SDK contract');
if (oracle.call('uid').value === 0) {
  for (const action of [
    () => fs.locations(), () => fs.stat('/', false), () => fs.listDirectory('/', null),
    () => fs.readText('/file', 'token'), () => fs.observeText('/file'),
    () => fs.writeText('/', 'file', '', 'token'), () => fs.replaceText('/file', '', 'token', 'parent'),
    () => fs.createDirectory('/', 'folder', 'token'), () => fs.rename('/file', 'new', 'token', 'parent'),
  ]) refuses(action, 'EPERM');
} else {
  // Only this test binding replaces enumeration to retire a real opened directory.
  configuration.library = fixtureLibrary;
  configuration.functions.entries.symbol = libc === 'musl' ? 'sr_checked_getdents' : 'sr_checked_getdents64';
  configuration.functions.close.symbol = 'sr_checked_close';
  const home = fs.locations().home, root = home + '/run-' + fixtureRun;
  check(home.startsWith('/tmp/polly-files-sdk-'), 'Explicit private fixture HOME');
  check(fs.locations().documents === home + '/Documents', 'Environment pointer copied through libc');
  const inspect = path => fs.stat(path, false), parent = () => inspect(root).identity;
  const initial = fs.listDirectory(root, null);
  check(initial.complete && initial.entries.some(entry => entry.name === 'hello.txt'), 'Real directory enumeration');
  check(inspect('/').name === '/', 'Root metadata');
  refuses(() => fs.listDirectory(root), null);
  refuses(() => fs.stat(root, 1), null);
  refuses(() => fs.stat(root + '\0ignored', false), 'EINVAL');
  for (const path of [root + '/..', root + '/', 'relative', '/' + 'x'.repeat(4095)])
    refuses(() => fs.stat(path, false), 'EINVAL');
  refuses(() => fs.listDirectory(root + '/missing', null), 'ENOENT');
  refuses(() => fs.createDirectory(root, '../escape', parent()), 'EINVAL');
  refuses(() => fs.createDirectory(root, 'no-token', null), null);
  const before = parent();
  const folder = fs.createDirectory(root, 'Documents', before);
  check(folder.type === 'directory' && folder.permissions === '0700', 'Owned private directory');
  refuses(() => fs.createDirectory(root, 'stale', before), 'ESTALE');
  refuses(() => fs.createDirectory(root, 'Documents', parent()), 'EEXIST');
  let entry = fs.writeText(root, 'literal %u; \u4e2d.txt', 'hello\n', parent());
  check(entry.permissions === '0600' && fs.readText(entry.path, entry.identity).text === 'hello\n', 'Actual native text read/write');
  const known = fs.observeText(entry.path);
  check(known.identity.endsWith(':5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03'), 'Independent SHA256 vector');
  check(fs.readText(entry.path, known.identity).identity === known.identity, 'Strong reads preserve content identity');
  refuses(() => fs.writeText(root, entry.name, 'wrong', parent()), 'EEXIST');
  refuses(() => fs.replaceText(entry.path, 'weak', entry.identity, parent()), 'EINVAL');
  entry = fs.replaceText(entry.path, 'replacement', known.identity, parent());
  check(fs.readText(entry.path, entry.identity).text === 'replacement', 'Confirmed replacement');
  refuses(() => fs.replaceText(entry.path, 'stale', known.identity, parent()), 'ESTALE');
  refuses(() => fs.readText(entry.path, known.identity), 'ESTALE');
  const current = fs.observeText(entry.path);
  const wrongDigest = current.identity.slice(0, -64) + '0'.repeat(64);
  refuses(() => fs.readText(entry.path, wrongDigest), 'ESTALE');
  refuses(() => fs.replaceText(entry.path, 'bad hash', wrongDigest, parent()), 'ESTALE');
  entry = fs.rename(entry.path, '\u6587\u4ef6 renamed.txt', entry.identity, parent());
  check(entry.name === '\u6587\u4ef6 renamed.txt', 'Unicode rename');
  refuses(() => fs.rename(entry.path, 'hello.txt', entry.identity, parent()), 'EEXIST');
  refuses(() => fs.rename(entry.path, 'wrong', 'wrong identity', parent()), 'ESTALE');
  check(fs.readText(entry.path, entry.identity).text === 'replacement', 'Collision leaves original content');
  const linked = inspect(root + '/folder-link');
  check(linked.type === 'symlink' && linked.targetType === 'directory' && linked.linkTarget === 'target', 'Symbolic-link observation');
  const followed = fs.stat(linked.path, true);
  check(followed.path === root + '/target' && followed.type === 'directory', 'Explicit link following is canonical');
  check(fs.listDirectory(linked.path, followed.identity).path === followed.path, 'Directory link follows to descriptor-owned path');
  check(inspect(root + '/broken-link').targetError === 'ENOENT', 'Broken link is explicit');
  check(inspect(root + '/loop-link').targetError === 'ELOOP', 'Link loop is explicit');
  refuses(() => fs.stat(root + '/loop-link', true), 'ELOOP');
  refuses(() => fs.readText(root + '/file-link', inspect(root + '/file-link').identity), 'EINVAL');
  refuses(() => fs.replaceText(root + '/file-link', 'bad', known.identity, parent()), 'ESTALE');
  refuses(() => fs.listDirectory(root + '/denied', null), 'EACCES');
  check(!inspect(root + '/denied').readable && !inspect(root + '/denied').writable, 'Effective permissions');
  refuses(() => fs.readText(root + '/fifo', inspect(root + '/fifo').identity), 'EINVAL');
  for (const name of ['invalid-utf8', 'nul-text']) refuses(() => fs.readText(root + '/' + name, inspect(root + '/' + name).identity), 'EILSEQ');
  refuses(() => fs.writeText(root, 'nul', 'x\0y', parent()), 'EILSEQ');
  refuses(() => fs.writeText(root, 'surrogate', '\ud800', parent()), 'EILSEQ');
  refuses(() => fs.writeText(root, 'large', 'x'.repeat(1048577), parent()), 'EFBIG');
  const maximum = fs.writeText(root, 'maximum.txt', 'x'.repeat(1048576), parent());
  check(fs.readText(maximum.path, maximum.identity).text.length === 1048576, 'Exact text byte bound');
  oracle.call('failClose', root);
  check(refuses(() => fs.writeText(root, 'published.txt', 'Published', parent()), 'EIO').committed === true,
    'Cleanup failure after publication reports its committed outcome');
  const published = inspect(root + '/published.txt');
  check(fs.readText(published.path, published.identity).text === 'Published', 'Published outcome is real, not inferred success');
  refuses(() => fs.readText(root + '/oversized', inspect(root + '/oversized').identity), 'EFBIG');
  const hard = fs.observeText(root + '/hard-original');
  fs.replaceText(hard.path, 'independent', hard.identity, parent());
  check(fs.readText(root + '/hard-other', inspect(root + '/hard-other').identity).text === 'shared', 'Replacement does not truncate other hard links');
  const many = fs.listDirectory(root + '/many', null);
  check(many.entries.length === 1024 && !many.complete, 'Directory bound reports incomplete');
  refuses(() => fs.listDirectory(root + '/invalid-name', null), 'EILSEQ');
  oracle.call('retire', root + '/retiring');
  check(['ESTALE', 'ENOENT'].includes(refuses(() => fs.listDirectory(root + '/retiring', null)).code),
    'Actual directory retirement after open cannot return empty success');
  check(!fs.listDirectory(root, null).entries.some(item => item.name.startsWith('.polly-save-')), 'Staged files are cleaned on every publication path');
  const handles = () => fs.listDirectory('/proc/self/fd', null).entries.length;
  const baseline = handles();
  for (let i = 0; i < 64; i++) {
    refuses(() => fs.readText(entry.path, 'stale'), 'ESTALE');
    refuses(() => fs.replaceText(entry.path, 'stale', known.identity, parent()), 'ESTALE');
  }
  check(handles() === baseline, 'Failure paths release native descriptors');
}
oracle.close();
