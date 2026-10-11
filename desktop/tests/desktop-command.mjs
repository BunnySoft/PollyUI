import { render } from './gui/sdk/js/reconciler.mjs';
import { desktopCommand } from './desktop/shell/presentation.mjs';
import { settingsView } from './desktop/shell/views.mjs';
import { systemSettingsView } from './desktop/shell/settings.mjs';
import { getDesktopTheme, DEFAULT_DESKTOP_THEME } from './desktop/shell/themes.mjs';
import { DESKTOP_THEMES } from './desktop/shell/themes.mjs';

const theme = { colors: { accent: '#2563eb', border: '#cbd5e1', selection: '#dbeafe',
  surface: '#ffffff', focus: '#2563eb', text: '#0f172a' } };
let actions = 0, events = [];
function check(name, value) {
  if (!value) throw new Error('FAIL: ' + name);
  console.log('PASS: ' + name);
}
render(desktopCommand('native-command', 'Activate', theme, () => actions++), document.body);
host.render();
const node = document.getElementById('native-command');
node.addEventListener('keydown', event => events.push({ type: event.type, key: event.key,
  button: event.button, prevented: event.defaultPrevented }));
node.focus();
host.key('Enter', 'keydown', { text: false });
check('native Enter activates a desktop command once', actions === 1);
host.key(' ', 'keydown', { code: 'Space', text: false });
check('native Space activates a desktop command once', actions === 2);
check('native keyboard events do not carry a mouse button',
  events.length === 2 && events.every(event => event.button === undefined && event.prevented));
host.key('ArrowDown', 'keydown', { text: false });
check('non-activation keys do not invoke the command', actions === 2);
const rect = node.getBoundingClientRect(), x = rect.x + 8, y = rect.y + 8;
host.mouse('mousedown', x, y, { button: 2 });
host.mouse('mouseup', x, y, { button: 2 });
host.mouse('contextmenu', x, y, { button: 2 });
check('secondary pointer release does not activate a command', actions === 2);
host.click(x, y);
check('primary pointer click preserves command activation', actions === 3);
console.log('PASS: native desktop command keyboard/pointer contract');

const desktopTheme = getDesktopTheme(DEFAULT_DESKTOP_THEME);
let selected = null;
document.body.tabIndex = 0;
render(systemSettingsView(desktopTheme, 'appearance', () => {}, () => {},
  settingsView(desktopTheme, id => { selected = id; }, () => {}, () => {},
    '', false, null, null, null, null, { enabled: false, reload() {}, restore() {} },
    null, true)), document.body);
host.render();
document.activeElement?.blur();
const focus = [];
for (let i = 0; i < 12; i++) {
  host.key('Tab', 'keydown', { text: false });
  focus.push(document.activeElement?.id || 'body');
}
check('actual native Settings focus sequence reaches Big Sur after twelve Tabs from blur',
  document.activeElement?.id === 'shell-theme-bigsur');
host.key('Enter', 'keydown', { text: false });
check('native keyboard activates the actual Big Sur card', selected === 'bigsur');
console.log('NATIVE_SETTINGS_FOCUS=' + JSON.stringify(focus));

function focusFromBody(steps, id) {
  document.body.focus();
  for (let i = 0; i < steps; i++) host.key('Tab', 'keydown', { text: false });
  check('native body-focused navigation reaches ' + id, document.activeElement?.id === id);
}
focusFromBody(11, 'shell-theme-bigsur');
focusFromBody(7, 'shell-theme-xp');
focusFromBody(13, 'shell-theme-reload');
const userThemes = [...DESKTOP_THEMES, { ...desktopTheme, id: 'alpha-vm', name: 'Private test theme' }];
render(systemSettingsView(desktopTheme, 'appearance', () => {}, () => {},
  settingsView(desktopTheme, id => { selected = id; }, () => {}, () => {},
    '', false, null, null, null, null, { enabled: true, reload() {}, restore() {} },
    null, true, '', userThemes)), document.body);
host.render();
focusFromBody(13, 'shell-theme-alpha-vm');
host.key('Enter', 'keydown', { text: false });
check('native keyboard activates the appended theme card', selected === 'alpha-vm');
focusFromBody(15, 'shell-theme-restore');
