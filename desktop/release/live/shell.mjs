import { createDesktopShell } from './desktop/shell/shell.mjs';
import { createTextInput } from './gui/sdk/js/textinput.mjs';

const shell = createDesktopShell().start();
const onWorkspacesChanged = desktop.onWorkspacesChanged;
desktop.onWorkspacesChanged = () => {
  if (typeof onWorkspacesChanged === 'function') onWorkspacesChanged();
  const active = desktop.workspaces().find(workspace => workspace.active);
  if (active) desktop.spawnApplication(['/usr/bin/logger', '-t', 'polly-live',
    'POLLY_LIVE_WORKSPACE=' + active.id], '', 'live workspace status');
};
const guide = window.create({ title: 'Welcome to PollyDesktop Live', width: 700, height: 640 });
const body = guide.document.body;
Object.assign(body.style, { padding: 24, gap: 16, backgroundColor: '#f0f2f6', overflow: 'scroll' });
for (const [text, size] of [
  ['PollyDesktop Live', 28],
  ['Independent Wayland desktop: PollyWM + PollyShell + PollyUI', 17],
  ['Temporary, unprivileged live user. All changes are lost at shutdown.', 15],
  ['No disk installer. No secure lock screen. Do not use this image for sensitive work.', 15],
  ['Use Appearance for JSON themes and settings; Polly for applications.', 15],
  ['Ctrl+Super+Left/Right switches manual workspaces. Alt+Escape asks to log out.', 14],
  ['Hardware preview: wired DHCP; Wi-Fi and audio via Appearance settings.', 14],
  ['Diagnostics stay in your temporary home. Review them before sharing.', 14],
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
for (const [title, action] of [
  ['Wi-Fi settings', () => shell.showNetwork(shell.getState().outputs[0])],
  ['Audio settings', () => shell.showAudio(shell.getState().outputs[0])],
  ['Collect local hardware diagnostics', () => desktop.spawnApplication(
    ['/usr/bin/foot', '--title=Polly Live diagnostics', '/bin/sh', '-c',
      'polly-live-diagnostics; printf "\\nPress Enter to close."; read answer'], '', 'local hardware diagnostics')],
]) {
  const button = guide.document.createElement('view');
  button.textContent = title;
  button.tabIndex = 0; button.setAttribute('role', 'button');
  Object.assign(button.style, { padding: 10, color: '#ffffff', backgroundColor: '#245dc9', fontSize: 14,
    borderRadius: 6, flexShrink: 0 });
  button.addEventListener('click', action);
  button.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); action(); }
  });
  body.appendChild(button);
}
const inputLabel = guide.document.createElement('view');
inputLabel.textContent = 'Input check: type nihao, choose a candidate, then try copy/paste.';
Object.assign(inputLabel.style, { fontSize: 14, color: '#20304a', flexShrink: 0 });
body.appendChild(inputLabel);
const input = createTextInput({ document: guide.document, width: 620, fontSize: 16 });
input.root.setAttribute('aria-label', 'Live text and clipboard check');
input.root.style.flexShrink = '0';
body.appendChild(input.root);
input.root.focus();
let inputMarker = '';
function checkInput() {
  const value = input.value;
  if (value !== inputMarker && (value === '\u4f60\u597d' || value === '\u4f60\u597d\u4f60\u597d')) {
    inputMarker = value;
    desktop.spawnApplication(['/usr/bin/logger', '-t', 'polly-live',
      value.length === 2 ? 'POLLY_LIVE_IME_COMMIT' : 'POLLY_LIVE_CLIPBOARD_PASTE'], '', 'live input check');
  }
}
input.root.addEventListener('textinput', checkInput);
input.root.addEventListener('keydown', checkInput);
setTimeout(() => {
  if (!shell.getState().outputs.length || shell.getState().error) {
    console.error('Polly Live startup failed: ' + shell.getState().error);
    return;
  }
  desktop.spawnApplication(['/usr/bin/logger', '-t', 'polly-live',
    'POLLY_LIVE_DESKTOP_READY outputs=' + shell.getState().outputs.length], '', 'live readiness');
}, 1000);
