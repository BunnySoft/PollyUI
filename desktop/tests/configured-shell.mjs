import { createDesktopShell as createShell } from './desktop/shell/shell.mjs';
import { openShellConfiguration } from './desktop/shell/configuration-native.mjs';

export function createDesktopShell(options = {}) {
  const configuration = options.configuration ?? openShellConfiguration();
  const shell = createShell({ ...options, configuration });
  const fixture = { ...shell, configuration,
    start() { shell.start(); return fixture; },
    stop() { try { shell.stop(); } finally { if (!options.configuration) configuration.close(); } } };
  return fixture;
}
