import { createDesktopShell } from './desktop/shell/shell.mjs';

const shell = createDesktopShell().start();
const onWorkspacesChanged = desktop.onWorkspacesChanged;
desktop.onWorkspacesChanged = () => {
  if (typeof onWorkspacesChanged === 'function') onWorkspacesChanged();
  const active = desktop.workspaces().find(workspace => workspace.active);
  if (active) desktop.spawnApplication(['/usr/bin/logger', '-t', 'polly-live',
    'POLLY_LIVE_WORKSPACE=' + active.id], '', 'live workspace status');
};
const guide = window.create({ title: 'Welcome to PollyDesktop Live', width: 700, height: 360 });
const body = guide.document.body;
Object.assign(body.style, { padding: 24, gap: 16, backgroundColor: '#f0f2f6' });
for (const [text, size] of [
  ['PollyDesktop Live', 28],
  ['Independent Wayland desktop: PollyWM + PollyShell + PollyUI', 17],
  ['Temporary, unprivileged live user. All changes are lost at shutdown.', 15],
  ['No disk installer. No secure lock screen. Do not use this image for sensitive work.', 15],
  ['Use Appearance for JSON themes and settings; Polly for applications.', 15],
  ['Ctrl+Super+Left/Right switches manual workspaces. Alt+Escape ends the desktop.', 14],
]) {
  const label = guide.document.createElement('view');
  label.textContent = text;
  Object.assign(label.style, { fontSize: size, color: '#20304a', flexShrink: 0 });
  body.appendChild(label);
}
const power = guide.document.createElement('view');
power.textContent = 'Power settings';
power.tabIndex = 0;
power.setAttribute('role', 'button');
Object.assign(power.style, { padding: 10, color: '#ffffff', backgroundColor: '#245dc9', fontSize: 14, borderRadius: 6 });
power.addEventListener('click', () => shell.showPower(shell.getState().outputs[0]));
power.addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); shell.showPower(shell.getState().outputs[0]); }
});
body.appendChild(power);
setTimeout(() => {
  if (!shell.getState().outputs.length || shell.getState().error) {
    console.error('Polly Live startup failed: ' + shell.getState().error);
    return;
  }
  desktop.spawnApplication(['/usr/bin/logger', '-t', 'polly-live',
    'POLLY_LIVE_DESKTOP_READY outputs=' + shell.getState().outputs.length], '', 'live readiness');
}, 1000);
