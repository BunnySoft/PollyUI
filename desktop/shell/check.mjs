import { createDesktopShell } from './desktop/shell/shell.mjs';
import { waitForSessionReady } from './desktop/shell/health.mjs';
import { openShellConfiguration } from './desktop/shell/configuration-native.mjs';

const configuration = openShellConfiguration();
const shell = createDesktopShell({ configuration });
try {
  shell.start();
  await waitForSessionReady({ shell, native: desktop,
    requireIme: application.arguments.includes('--require-ime'),
    requireAudio: application.arguments.includes('--require-audio') });
  console.log('PASS: installed PollyDesktop session ready');
} finally {
  shell.stop();
  configuration.close();
  window.quit();
}
