import { createDesktopShell } from './desktop/shell/shell.mjs';
import { openShellConfiguration } from './desktop/shell/configuration-native.mjs';
import { createTextInput } from './gui/sdk/js/textinput.mjs';

const product = application.arguments[0] ?? 'micro';
if (!['mini', 'micro'].includes(product)) throw new Error('Unknown Alpine Shell product: ' + product);
const brand = product === 'mini' ? 'Polly Mini' : 'Polly Micro';
const shell = createDesktopShell({ configuration: openShellConfiguration() }).start();
const welcome = window.create({ title: brand + ' Shell', width: 680, height: 450 });
const body = welcome.document.body;
Object.assign(body.style, { padding: 24, gap: 18, backgroundColor: '#f0f2f6', overflow: 'scroll' });
body.addEventListener('mousedown', () => console.log('MICRO_POINTER_INPUT'));
for (const [text, size] of [
  [brand, 30],
  ['Alpine + PollyWM + PollyUI Shell', 20],
  ['CPU rendering. No Chinese fonts or input method.', 16],
  ['Temporary user session. No login or installation.', 16],
  ['Use the taskbar or the buttons below to open applications.', 16],
  ['Drag the title bar to move; use its buttons to minimize or close.', 15],
]) {
  const label = welcome.document.createElement('view');
  label.textContent = text;
  Object.assign(label.style, { fontSize: size, color: '#20304a', flexShrink: 0 });
  body.appendChild(label);
}
const actions = welcome.document.createElement('view');
Object.assign(actions.style, { flexDirection: 'row', gap: 10, flexShrink: 0 });
for (const [label, id] of [
  ['Files', 'polly-files.desktop'], ['Settings', 'polly-settings.desktop'],
  ['Processes', 'polly-processes.desktop'], ['Foot', 'foot.desktop'],
]) {
  const button = welcome.document.createElement('view');
  button.textContent = label;
  button.id = 'micro-launch-' + label.toLowerCase();
  button.tabIndex = 0;
  button.setAttribute('role', 'button');
  Object.assign(button.style, { padding: 10, fontSize: 16, color: '#ffffff',
    backgroundColor: '#245dc9', borderRadius: 5 });
  const launch = () => {
    console.log('MICRO_LAUNCH_REQUEST=' + label);
    shell.launchApplication(id);
  };
  button.addEventListener('click', launch);
  button.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); launch(); }
  });
  actions.appendChild(button);
}
body.appendChild(actions);
const input = createTextInput({ document: welcome.document, width: 600, fontSize: 18 });
input.root.setAttribute('aria-label', 'Micro keyboard check');
body.appendChild(input.root);
input.root.focus();
input.root.addEventListener('textinput', () => console.log('MICRO_TEXT_INPUT=' + input.value));
console.log('MICRO_SHELL_STARTED');
let previous = '';
const caretPhases = new Set();
setInterval(() => {
  if (!welcome.closed && welcome.document.activeElement === input.root) {
    const phase = input.root.childNodes[2].style.backgroundColor === 'transparent' ? 'hidden' : 'visible';
    if (!caretPhases.has(phase)) {
      caretPhases.add(phase);
      console.log('MICRO_CARET_PHASE=' + phase);
    }
  }
  const windows = desktop.windows();
  const panels = shell.getSurfaces().filter(surface => surface.kind === 'panel').map(surface => ({
    output: surface.output, ...surface.window.state,
    launcher: surface.window.document.getElementById('shell-menu')?.getBoundingClientRect() ?? null,
  }));
  const state = { displays: window.displays(), panels, windows,
    services: desktop.sessionServices(), welcome: welcome.closed ? null : welcome.state,
    controls: welcome.closed ? [] : Array.from(actions.childNodes).map(button => ({
      id: button.id, ...button.getBoundingClientRect(),
    })), settings: shell.getSettingsState(), error: shell.getState().error };
  const signature = JSON.stringify({ panels: panels.map(panel => [panel.output, panel.width, panel.height, panel.launcher]),
    windows: windows.map(item => [item.id, item.title, item.maximized, item.minimized]),
    welcome: state.welcome, controls: state.controls, services: state.services,
    settings: state.settings, error: state.error });
  if (signature !== previous) {
    previous = signature;
    console.log('MICRO_DESKTOP_STATE=' + JSON.stringify(state));
  }
}, 500);
