import { alloc } from 'sysrt:ffi';
import { fileConstants as C } from './sysrt/bindings/files.mjs';
import { call, usingFD } from './desktop/shared/native-files.mjs';
import { readPrivateConfigurationFile } from './desktop/shared/configuration-files.mjs';
import { openShellConfiguration } from './desktop/shell/configuration-native.mjs';
import { SHELL_CONFIGURATION_FILE } from './desktop/shell/configuration.mjs';
import { encodeUtf8 } from './sysrt/sdk/js/encoding.mjs';

export function checkDamagedConfiguration() {
  const original = readPrivateConfigurationFile(application.configDir, SHELL_CONFIGURATION_FILE);
  function write(bytes) {
    usingFD(Number(call('open', C.currentDirectory, application.configDir + '/' + SHELL_CONFIGURATION_FILE,
      C.writeOnly | C.noFollow | C.closeOnExec, 0)), fd => {
      call('truncate', fd, 0);
      const buffer = alloc(bytes.length);
      try {
        buffer.write(bytes.buffer);
        if (call('write', fd, buffer, bytes.length) !== BigInt(bytes.length)) throw new Error('Fixture write truncated');
        call('sync', fd);
      } finally { buffer.close(); }
    });
  }
  write(encodeUtf8('{broken'));
  try {
    let rejected = false;
    try { openShellConfiguration().close(); } catch { rejected = true; }
    const observed = readPrivateConfigurationFile(application.configDir, SHELL_CONFIGURATION_FILE);
    if (!rejected || observed.length !== 7) throw new Error('Damaged configuration was silently accepted or overwritten');
    console.log('PASS: damaged JSON configuration rejects startup without reading legacy storage or overwriting data');
  } finally { write(original); }
}
