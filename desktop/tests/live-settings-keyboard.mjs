import { render } from './gui/sdk/js/reconciler.mjs';
import { settingsView } from './desktop/shell/views.mjs';
import { systemSettingsView } from './desktop/shell/settings.mjs';
import { getDesktopTheme, BUILTIN_THEME_CATALOG } from './desktop/shell/themes.mjs';

const theme = getDesktopTheme('xp');
function check(value, message) { if (!value) throw new Error(message); }
function inspect(count, expected, user = false) {
  render(null, document.body);
  const themes = [...BUILTIN_THEME_CATALOG.themes];
  if (user) themes.push({ ...theme, id: 'alpha-vm', name: 'Alpha VM user theme' });
  const appearance = settingsView(theme, () => {}, () => {}, () => {}, '', false,
    null, null, null, null, { enabled: true, reload: () => {}, restore: () => {} }, null,
    true, '', themes);
  render(systemSettingsView(theme, 'appearance', () => {}, () => {}, appearance), document.body);
  document.body.tabIndex = 0;
  document.body.focus(); document.body.blur();
  host.render();
  for (let index = 0; index < count; index++) host.key('Tab');
  check(document.activeElement?.id === expected,
    'Actual native Settings focus sequence mismatch: ' + count + ' => ' + document.activeElement?.id);
}
inspect(13, 'shell-theme-bigsur');
inspect(14, 'shell-theme-reload');
inspect(14, 'shell-theme-alpha-vm', true);
inspect(9, 'shell-theme-xp', true);
inspect(16, 'shell-theme-restore', true);
let rejected = false;
try { inspect(12, 'shell-theme-bigsur'); } catch (error) {
  rejected = /shell-theme-lion/.test(String(error));
}
check(rejected, 'Original off-by-one keyboard sequence must select Lion and be rejected');
console.log('PASS: actual production Settings DOM/native Tab order includes the unfocused root and loaded user theme');
