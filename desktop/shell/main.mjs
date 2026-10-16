import { createDesktopShell } from './desktop/shell/shell.mjs';
import { openShellConfiguration } from './desktop/shell/configuration-native.mjs';
import { readNativeUserProfile } from './desktop/shell/user-profile-native.mjs';

const configuration = openShellConfiguration();
try {
  const displayProfile = readNativeUserProfile();
  createDesktopShell({ configuration, displayProfile }).start();
}
catch (error) { configuration.close(); throw error; }
