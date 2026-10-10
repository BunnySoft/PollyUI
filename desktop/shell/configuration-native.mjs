import { openConfigurationFiles, readPrivateConfigurationFile } from './desktop/shared/configuration-files.mjs';
import { createShellConfiguration, SHELL_CONFIGURATION_FILE } from './desktop/shell/configuration.mjs';

export function openShellConfiguration(paths = application) {
  return createShellConfiguration(openConfigurationFiles(paths.configDir, SHELL_CONFIGURATION_FILE),
    () => readPrivateConfigurationFile(paths.dataDir, 'localstorage.dat'));
}
