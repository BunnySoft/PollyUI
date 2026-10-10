import { createDesktopShell } from './desktop/shell/shell.mjs';
import { openShellConfiguration } from './desktop/shell/configuration-native.mjs';

const shell = createDesktopShell({ configuration: openShellConfiguration() }).start();
const guide = window.create({ title: 'PollyDesktop installed development system', width: 720, height: 420 });
Object.assign(guide.document.body.style, { padding: 24, gap: 16, backgroundColor: '#f0f2f6' });
for (const [text, size] of [
  ['PollyDesktop', 28],
  ['Installed Debian development system with separate user data.', 17],
  ['Settings, managed applications, AppData and documents survive reboot.', 15],
  ['Each system slot owns its package database and system configuration.', 15],
  ['Password login is enabled. Screen locking and encryption are not yet integrated.', 15],
  ['Wi-Fi credentials stay in RAM. System updates are not implemented.', 15],
  ['Appearance opens settings; Polly opens applications.', 15],
  ['Ctrl+Super+Left/Right switches workspaces. Alt+Escape asks to log out.', 14],
]) {
  const label = guide.document.createElement('view');
  label.textContent = text;
  Object.assign(label.style, { fontSize: size, color: '#20304a', flexShrink: 0 });
  guide.document.body.appendChild(label);
}
setTimeout(() => {
  const state = shell.getState();
  if (!state.outputs.length || state.error) {
    console.error('Installed desktop startup failed: ' + state.error);
    return;
  }
  desktop.spawnApplication(['/usr/bin/logger', '-t', 'polly-installed',
    'POLLY_INSTALLED_DESKTOP_READY outputs=' + state.outputs.length + ' theme=' + state.themeId],
    '', 'installed desktop readiness');
}, 1000);
