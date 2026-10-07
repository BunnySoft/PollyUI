import { createDesktopShell } from './desktop/shell/shell.mjs';
import { waitForSessionReady } from './desktop/shell/health.mjs';

const shell = createDesktopShell().start();
try {
  await waitForSessionReady({ shell, native: desktop,
    requireIme: application.arguments.includes('--require-ime'),
    requireAudio: application.arguments.includes('--require-audio') });
  console.log('PASS: installed PollyDesktop session ready');
} finally {
  shell.stop();
  window.quit();
}
