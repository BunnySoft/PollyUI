import { DEFAULT_DESKTOP_THEME, DESKTOP_THEMES, getDesktopTheme } from './desktop/shell/themes.mjs';
import { createAppearancePreview } from './desktop/shell/appearance.mjs';

let passed = 0;
function check(name, condition) {
  if (!condition) throw new Error('FAIL: ' + name);
  passed++;
  console.log('PASS: ' + name);
}
function throws(name, callback) {
  let thrown = false;
  try { callback(); } catch (error) { thrown = error instanceof Error; }
  check(name, thrown);
}
function get(id) {
  const element = document.getElementById(id);
  check(id + ' exists', !!element);
  return element;
}
function click(id) {
  const element = get(id);
  const x = element.offsetLeft + element.offsetWidth / 2;
  const y = element.offsetTop + element.offsetHeight / 2;
  check(id + ' has a visible hit target', element.offsetWidth > 0 && element.offsetHeight > 0 &&
    x >= 0 && y >= 0 && x < host.width && y < host.height);
  host.click(x, y);
  host.render();
}
function inside(element, parent, name) {
  check(name, element.offsetLeft >= parent.offsetLeft - 1 && element.offsetTop >= parent.offsetTop - 1 &&
    element.offsetLeft + element.offsetWidth <= parent.offsetLeft + parent.offsetWidth + 1 &&
    element.offsetTop + element.offsetHeight <= parent.offsetTop + parent.offsetHeight + 1);
}

check('four stable appearance IDs', DESKTOP_THEMES.map(t => t.id).join(',') === 'xp,server2003,aqua,lion');
check('XP is the initial preview, not an OS preference', DEFAULT_DESKTOP_THEME === 'xp');
throws('unknown theme is rejected', () => getDesktopTheme('not-a-theme'));
throws('invalid initial theme is rejected', () => createAppearancePreview({ themeId: 'not-a-theme' }));
check('theme catalog is immutable', Object.isFrozen(DESKTOP_THEMES));
const shape = JSON.stringify(Object.keys(DESKTOP_THEMES[0]).sort());
for (const theme of DESKTOP_THEMES) {
  check(theme.id + ' has the same token groups', JSON.stringify(Object.keys(theme).sort()) === shape);
  for (const [name, group] of Object.entries(theme)) {
    if (typeof group !== 'object') continue;
    check(theme.id + '.' + name + ' has a complete token shape',
      JSON.stringify(Object.keys(group).sort()) === JSON.stringify(Object.keys(DESKTOP_THEMES[0][name]).sort()));
    check(theme.id + '.' + name + ' is immutable', Object.isFrozen(group));
    for (const [key, value] of Object.entries(group)) {
      if (typeof value === 'string' && value.startsWith('#'))
        check(theme.id + '.' + name + '.' + key + ' is RGB', /^#[0-9a-f]{6}$/.test(value));
      if (typeof value === 'number')
        check(theme.id + '.' + name + '.' + key + ' is finite and nonnegative', Number.isFinite(value) && value >= 0);
    }
  }
}
throws('palette mutation is rejected', () => { DESKTOP_THEMES[0].colors.accent = '#000000'; });

const preview = createAppearancePreview().mount(document.body);
throws('double mount is rejected', () => preview.mount(document.body));
host.render();
const captures = [];
for (const theme of DESKTOP_THEMES) {
  click('appearance-theme-' + theme.id);
  check(theme.id + ' selected by pointer', preview.getState().themeId === theme.id);
  check(theme.id + ' selection is exposed', get('appearance-theme-' + theme.id).getAttribute('aria-pressed') === 'true');
  const stage = get('appearance-desktop');
  const frame = get('appearance-window');
  const normalWidth = frame.offsetWidth;
  inside(frame, stage, theme.id + ' frame stays on the simulated desktop');
  inside(get('appearance-status'), frame, theme.id + ' status stays inside its frame');
  inside(get('appearance-panel'), stage, theme.id + ' panel stays on the simulated desktop');
  const close = get('appearance-close'), max = get('appearance-maximize'), min = get('appearance-minimize');
  check(theme.id + ' control order matches theme',
    theme.window.controls === 'left'
      ? close.offsetLeft < min.offsetLeft && min.offsetLeft < max.offsetLeft
      : min.offsetLeft < max.offsetLeft && max.offsetLeft < close.offsetLeft);
  check(theme.id + ' corner radius is applied', Number(frame.style.borderRadius) === theme.window.radius);
  check(theme.id + ' dock and menu bar agree', !!document.getElementById('appearance-menubar') === (theme.panel.kind === 'dock'));
  const accent = get('appearance-accent');
  check(theme.id + ' accent pixels are real', host.pixel(accent.offsetLeft + 6, accent.offsetTop + 5) === theme.colors.accent.toUpperCase());
  const title = get('appearance-titlebar');
  captures.push(host.pixel(title.offsetLeft + title.offsetWidth * 0.65, title.offsetTop + 4));
  host.mouse('mousemove', 0, 0);
  check(theme.id + ' snapshot saved',
    host.save('build/appearance-' + theme.id + '-' + host.width + 'x' + host.height + '.png'));

  click('appearance-folder-Downloads');
  check('folder selection updates only the preview', preview.getState().folder === 'Downloads');
  click('appearance-action');
  check('sample action runs', preview.getState().clicks === DESKTOP_THEMES.indexOf(theme) + 1);
  click('appearance-maximize');
  check('sample window maximizes', preview.getState().maximized);
  check('maximized preview grows', get('appearance-window').offsetWidth > normalWidth);
  inside(get('appearance-window'), get('appearance-desktop'), 'maximized preview stays inside desktop');
  click('appearance-minimize');
  check('minimized preview is hidden', preview.getState().minimized && !document.getElementById('appearance-window'));
  click('appearance-open');
  check('reopening preserves maximized preview state', !preview.getState().minimized && preview.getState().maximized);
  click('appearance-maximize');
  check('restore returns to normal', !preview.getState().maximized);
  click('appearance-close');
  check('close hides the simulated window, not the host', !preview.getState().open && !!document.getElementById('appearance-root'));
  click('appearance-open');
  check('closed sample can be opened again', preview.getState().open && !preview.getState().maximized);
}
check('four title treatments render distinct pixels', new Set(captures).size === 4);

const state = preview.getState();
throws('invalid theme selection is rejected', () => preview.selectTheme('bad'));
check('invalid theme does not change state', preview.getState().themeId === state.themeId);
state.themeId = 'bad';
check('state snapshots cannot mutate the preview', preview.getState().themeId === 'lion');
click('appearance-launcher');
check('launcher opens the theme menu', !!document.getElementById('appearance-menu'));
click('appearance-menu-aqua');
check('menu changes theme and closes', preview.getState().themeId === 'aqua' && !document.getElementById('appearance-menu'));
get('appearance-theme-server2003').focus();
host.key('Enter');
check('theme selection works with keyboard', preview.getState().themeId === 'server2003');
get('appearance-theme-xp').focus();
host.key(' ');
check('Space activates focused theme', preview.getState().themeId === 'xp');
click('appearance-maximize');
preview.selectTheme('lion');
host.render();
check('theme switch preserves maximized sample state', preview.getState().maximized);
click('appearance-minimize');
preview.selectTheme('server2003');
host.render();
check('theme switch does not reopen a minimized window', preview.getState().minimized &&
  !document.getElementById('appearance-window'));
click('appearance-open');
check('new taskbar restores the same maximized sample', preview.getState().maximized);
click('appearance-close');
preview.selectTheme('aqua');
host.render();
check('theme switch does not reopen a closed window', !preview.getState().open);
click('appearance-info');
check('Info accurately explains the integration boundary',
  preview.getState().message.includes('Not connected to PollyWM yet'));
preview.unmount();
check('unmount removes the preview', !document.getElementById('appearance-root'));
preview.mount(document.body);
host.render();
check('preview can be remounted', !!document.getElementById('appearance-root'));
preview.unmount();
console.log(passed + ' appearance assertions passed');
