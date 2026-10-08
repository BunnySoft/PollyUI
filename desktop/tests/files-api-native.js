const fs = desktop.fileSystem;
function check(value, message) { if (!value) throw new Error(message); }
function rejects(action, code) {
  try { action(); } catch (error) {
    if (code) check(error.code === code, 'Expected ' + code + ', got ' + error.code);
    return;
  }
  throw new Error('Expected refusal');
}
check(fs.version === 1 && fs.implementation === 'posix-ordinary-v1' && fs.overwrite === true && fs.textObservation === 'sha256-v1',
  'Fresh native API/capability is required, not an old engine or stub');
const home = fs.locations().home;
let snapshot = fs.listDirectory(home, null);
check(snapshot.complete && snapshot.entries.length === 0, 'Real empty private HOME');
rejects(() => fs.listDirectory(home), null);
rejects(() => fs.stat(home, 1), null);
rejects(() => fs.stat(home + '\0ignored', false), null);
rejects(() => fs.listDirectory(home + '/missing', null), 'ENOENT');
const folder = fs.createDirectory(home, 'Documents', snapshot.identity);
check(folder.type === 'directory' && folder.permissions === '0700', 'Real new directory');
snapshot = fs.listDirectory(home, null);
let entry = fs.writeText(home, '中文 literal %u.txt', 'First\n', snapshot.identity);
check(fs.readText(entry.path, entry.identity).text === 'First\n', 'Actual native text read');
snapshot = fs.listDirectory(home, null);
rejects(() => fs.writeText(home, entry.name, 'must not clobber', snapshot.identity), 'EEXIST');
rejects(() => fs.replaceText(entry.path, 'metadata cannot authorize', entry.identity, fs.stat(home, false).identity), 'EINVAL');
const old = fs.observeText(entry.path);
check(old.identity.startsWith('sha256:' + old.metadataIdentity + ':'), 'Strong native content observation');
entry = fs.replaceText(entry.path, 'Confirmed replacement\n', old.identity, fs.stat(home, false).identity);
check(fs.readText(entry.path, entry.identity).text === 'Confirmed replacement\n', 'Explicit actual replacement');
rejects(() => fs.replaceText(entry.path, 'stale', old.identity, fs.stat(home, false).identity), 'ESTALE');
rejects(() => fs.readText(entry.path, old.identity), 'ESTALE');
const current = fs.observeText(entry.path);
check(fs.readText(entry.path, current.identity).identity === current.identity, 'Strong reads validate and preserve content identity');
entry = fs.rename(entry.path, 'Renamed file.txt', entry.identity, fs.stat(home, false).identity);
check(entry.name === 'Renamed file.txt', 'Actual renamed entry');
check(fs.stat(entry.path, false).identity === entry.identity, 'Exact opaque identity');
rejects(() => fs.observeText(folder.path), 'EINVAL');
rejects(() => fs.readText(folder.path, folder.identity), 'EINVAL');
rejects(() => fs.createDirectory(home, '../escape', fs.stat(home, false).identity), 'EINVAL');
rejects(() => fs.writeText(home, 'invalid.txt', 'x\0y', fs.stat(home, false).identity), null);
snapshot = fs.listDirectory(home, null);
check(snapshot.entries.some(item => item.name === entry.name && item.permissions === '0600'), 'Actual listed file metadata');
