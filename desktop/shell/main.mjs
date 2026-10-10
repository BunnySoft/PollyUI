import { createDesktopShell } from './desktop/shell/shell.mjs';
import { openShellConfiguration } from './desktop/shell/configuration-native.mjs';

const configuration = openShellConfiguration();
try { createDesktopShell({ configuration }).start(); }
catch (error) { configuration.close(); throw error; }
