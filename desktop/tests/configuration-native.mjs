import { alloc } from 'sysrt:ffi';
import { openShellConfiguration } from './desktop/shell/configuration-native.mjs';
import { readPrivateConfigurationFile } from './desktop/shared/configuration-files.mjs';
import { fileConstants as C } from './sysrt/bindings/files.mjs';
import { call, usingFD } from './desktop/shared/native-files.mjs';
import { decodeUtf8 } from './sysrt/sdk/js/encoding.mjs';

const { paths, mode, expected } = configurationFixture;
function check(value, message) { if (!value) throw new Error(message); console.log('PASS: ' + message); }
function descriptors() {
  return usingFD(Number(call('open', C.currentDirectory, '/proc/self/fd', C.readOnly | C.directory | C.closeOnExec, 0)), fd => {
    const buffer = alloc(32768);
    try {
      let count = 0;
      for (;;) {
        const size = Number(call('entries', fd, buffer, 32768));
        if (!size) return count;
        const bytes = buffer.read(size), view = new DataView(bytes);
        for (let offset = 0; offset < size; offset += view.getUint16(offset + 16, true)) count++;
      }
    } finally { buffer.close(); }
  });
}
const before = descriptors();
if (mode === 'reject') {
  let error = null;
  try { openShellConfiguration(paths).close(); } catch (failure) { error = failure; }
  check(error && !error.committed, 'bad/unsafe configuration fails explicitly before publication');
  if (expected) check(error.code === expected, 'second native process is rejected specifically by the writer lock');
  check(descriptors() === before, 'failed open leaves exact descriptor count unchanged');
} else {
  const configuration = openShellConfiguration(paths);
  if (mode === 'hold') {
    console.log('LOCK_READY');
    await new Promise(resolve => setTimeout(resolve, 2000));
  } else if (mode === 'roundtrip') {
    configuration.update({ theme: { id: 'bigsur', filesEnabled: false },
      workspace: { version: 1, names: ['Code', '\u8d44\u6599\ud83d\udc30'], active: 1 } });
    check(Object.isFrozen(configuration.snapshot.workspace.names), 'snapshots are deeply immutable');
  } else if (mode === 'write-failure' || mode === 'committed') {
    const previous = configuration.snapshot;
    let error = null;
    try { configuration.update({ theme: { id: 'lion', filesEnabled: false } }); } catch (failure) { error = failure; }
    check(error && !!error.committed === (mode === 'committed'), 'publication error has exact committed metadata');
    check(mode === 'committed' ? configuration.snapshot.theme.id === 'lion' : configuration.snapshot === previous,
      'memory follows actual file publication, not the durability error');
    const file = JSON.parse(decodeUtf8(readPrivateConfigurationFile(paths.configDir, 'shell-preferences.json')));
    check(JSON.stringify(file) === JSON.stringify(configuration.snapshot), 'disk and memory agree after injected failure');
  }
  if (expected) check(JSON.stringify(configuration.snapshot) === JSON.stringify(expected), 'all typed fields round trip/restart/migrate exactly');
  configuration.close();
  let closedError = false;
  try { configuration.update({ theme: { id: 'xp', filesEnabled: true } }); } catch { closedError = true; }
  check(closedError, 'retained configuration cannot use closed descriptors');
  check(descriptors() === before, 'configuration lifetime restores exact descriptor count');
}
console.log('PASS: configuration fixture ' + mode);
