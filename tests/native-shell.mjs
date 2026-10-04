import { createDesktopShell, SHELL_THEME_KEY } from './desktop/shell/shell.mjs';
import { settingsView } from './desktop/shell/views.mjs';
import { DESKTOP_THEMES, getDesktopTheme } from './desktop/shell/themes.mjs';
import { h, render } from './js/reconciler.mjs';

function check(value, message) {
  if (!value) throw new Error('FAIL: ' + message);
  console.log('PASS: ' + message);
}
render(h('view', { id: 'first-root' }), document.body);
render(h('view', { id: 'replacement-root' }), document.body);
check(document.body.childNodes.length === 1 && document.body.firstChild.id === 'replacement-root',
  'document retains the reconciler mount state between body getter calls');
render(null, document.body);
const created = [];
let displays = [{ id: 1, width: 1280, height: 720 }, { id: 2, width: 800, height: 600 }];
let failCreate = 0;
let saved = 'xp';
let failStorage = false;
const warnings = [];
const fakeHost = {
  close() {},
  displays() { return displays.map(output => ({ ...output })); },
  create(options) {
    if (failCreate && --failCreate === 0) throw new Error('surface creation failed');
    const native = {
      options, closed: false, document: { body: document.createElement('view') },
      close() { if (!this.closed) { this.closed = true; this.onclose?.(); } },
    };
    created.push(native);
    return native;
  },
};
const storage = {
  getItem(key) { check(key === SHELL_THEME_KEY, 'dedicated theme storage key'); return saved; },
  setItem(key, value) {
    if (failStorage) throw new Error('disk full');
    saved = value;
  },
};
const shell = createDesktopShell({ host: fakeHost, storage, report: text => warnings.push(text) }).start();
const backgrounds = shell.getSurfaces().filter(s => s.kind === 'wallpaper').map(s => s.window);
let previousPanel = shell.getSurfaces().find(s => s.kind === 'panel').window;
for (const theme of DESKTOP_THEMES) {
  check(shell.selectTheme(theme.id), theme.id + ' applies to shell');
  check(saved === theme.id && shell.getState().themeId === theme.id, theme.id + ' is persisted');
  const surfaces = shell.getSurfaces();
  check(surfaces.length === (theme.panel.kind === 'dock' ? 6 : 4), theme.id + ' has real surface roles for two outputs');
  check(surfaces.filter(s => s.kind === 'wallpaper').every(s => backgrounds.includes(s.window)),
    'wallpaper handles survive theme changes');
  const panel = surfaces.find(s => s.kind === 'panel').window;
  if (theme.id === 'server2003') check(panel === previousPanel, 'same-geometry panel is reused');
  previousPanel = panel;
  check(panel.options.anchors[0] === (theme.panel.kind === 'dock' ? 'top' : 'bottom'),
    theme.id + ' uses the correct screen edge');
  if (theme.panel.kind === 'dock')
    check(surfaces.filter(s => s.kind === 'dock').every(s => s.window.options.transparent), 'floating docks request alpha');
}
check(shell.selectTheme('xp'), 'reset before failure checks');
const originals = shell.getSurfaces().map(s => s.window);
let mark = created.length;
failStorage = true;
check(!shell.selectTheme('bigsur'), 'storage failure is surfaced');
check(saved === 'xp' && shell.getState().themeId === 'xp', 'failed persistence preserves selection');
check(originals.every(native => !native.closed) && created.slice(mark).every(native => native.closed),
  'failed persistence retires staged surfaces, not live ones');
failStorage = false;
mark = created.length;
failCreate = 2;
check(!shell.selectTheme('bigsur'), 'native creation failure is surfaced');
check(originals.every(native => !native.closed) && created.slice(mark).every(native => native.closed),
  'partial creation is rolled back');
failCreate = 0;
check(shell.selectTheme('bigsur'), 'valid theme can recover after failure');
displays = [displays[0]];
shell.refresh(true);
check(shell.getState().outputs.join(',') === '1', 'removed output is retired');
displays.push({ id: 3, width: 1024, height: 768 });
failCreate = 1;
shell.refresh(true);
check(shell.getState().error.includes('Display setup failed'), 'display failure is visible');
mark = created.length;
shell.refresh();
check(created.length === mark, 'failed display signature is not retried in a tight loop');
shell.refresh(true);
check(shell.getState().outputs.length === 2 && !shell.getState().error, 'explicit retry recovers display setup');
const menu = shell.showSettings(1);
check(menu && !menu.closed, 'settings use an independent overlay');
menu.close();
check(shell.showSettings(1) !== null, 'externally closed settings can reopen');
shell.stop();
check(created.every(native => native.closed), 'all shell-owned surfaces close on stop');
check(warnings.length >= 3, 'failures are logged, not silently ignored');

saved = 'missing-theme';
const recovered = createDesktopShell({ host: fakeHost, storage, report: text => warnings.push(text) });
check(recovered.getState().themeId === 'xp' && recovered.getState().error, 'unknown saved themes recover with a visible warning');

let selected = '', closed = false;
render(settingsView(getDesktopTheme('xp'), id => { selected = id; }, () => { closed = true; }, () => {}), document.body);
host.render();
const choice = document.getElementById('shell-theme-bigsur');
host.click(choice.offsetLeft + choice.offsetWidth / 2, choice.offsetTop + choice.offsetHeight / 2);
check(selected === 'bigsur', 'theme buttons react to native pointer dispatch');
document.getElementById('shell-theme-lion').focus();
host.key('Enter');
check(selected === 'lion', 'theme buttons react to native keyboard dispatch');
const close = document.getElementById('shell-settings-close');
host.click(close.offsetLeft + close.offsetWidth / 2, close.offsetTop + close.offsetHeight / 2);
check(closed, 'settings close button is functional');
render(null, document.body);
