import { createDesktopShell, SHELL_THEME_KEY } from './desktop/shell/shell.mjs';
import { settingsView, panelView, dockView, workspacesView } from './desktop/shell/views.mjs';
import { DESKTOP_THEMES, getDesktopTheme } from './desktop/shell/themes.mjs';
import { h, render } from './gui/sdk/js/reconciler.mjs';
import { saveShortcuts, shortcutFromEvent, shortcutText } from './desktop/shell/shortcuts.mjs';

function check(value, message) {
  if (!value) throw new Error('FAIL: ' + message);
  console.log('PASS: ' + message);
}
render(h('view', { id: 'first-root' }), document.body);
render(h('view', { id: 'replacement-root' }), document.body);
check(document.body.childNodes.length === 1 && document.body.firstChild.id === 'replacement-root',
  'document retains the reconciler mount state between body getter calls');
render(null, document.body);

const liveWindows = Array.from({ length: 12 }, (_, index) => ({
  id: index + 1, title: 'Window ' + (index + 1), appId: 'org.pollyui.test',
  active: index === 0, minimized: index === 1, maximized: false, fullscreen: false,
}));
let toggled = 0, actions = 0;
render(panelView(getDesktopTheme('xp'), '12:00', () => {}, '', () => {},
  liveWindows, id => { toggled = id; }, id => { actions = id; }), document.body);
host.render();
const liveButton = document.getElementById('shell-window-1');
host.click(liveButton.offsetLeft + 5, liveButton.offsetTop + 5);
check(toggled === 1 && liveButton.getAttribute('aria-pressed') === 'true',
  'running-window button dispatches the live ID and exposes active state');
host.mouse('contextmenu', liveButton.offsetLeft + 5, liveButton.offsetTop + 5);
check(actions === 1, 'right click opens window actions rather than toggling it');
liveButton.focus();
actions = 0;
host.key('ContextMenu');
check(actions === 1, 'window actions also support the context-menu key');
const list = document.getElementById('shell-window-list');
host.scroll(list.offsetLeft + 10, list.offsetTop + 10, 10000);
check(list.scrollLeft > 0, 'vertical wheel reaches overflowed window buttons horizontally');
host.scroll(list.offsetLeft + 10, list.offsetTop + 10, -10000);
check(list.scrollLeft === 0, 'window-list scrolling clamps at the start');
render(dockView(getDesktopTheme('bigsur'), () => {}, () => {}, () => {}, liveWindows,
  id => { toggled = id; }, id => { actions = id; }), document.body);
host.render();
const dockButton = document.getElementById('shell-window-1');
check(dockButton.offsetWidth === 64 && dockButton.getAttribute('aria-label') === 'Window 1',
  'Dock uses compact buttons with the full accessible title');
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

saved = 'xp';
let snapshots = liveWindows.map(item => ({ ...item }));
let failWindows = false, notifications = 0;
let failAppearance = false;
const appliedAppearances = [];
const originalWindowsChanged = () => { notifications++; };
const native = {
  windows() { if (failWindows) throw new Error('lost connection'); return snapshots.map(item => ({ ...item })); },
  onWindowsChanged: originalWindowsChanged,
  configureAppearance(theme) { if (failAppearance) throw new Error('appearance unavailable'); appliedAppearances.push(theme.id); },
};
const windowShell = createDesktopShell({ host: fakeHost, storage, native,
  report: message => warnings.push(message) }).start();
check(appliedAppearances.join(',') === 'xp', 'initial Shell appearance is sent to the compositor');
failAppearance = true;
check(!windowShell.selectTheme('bigsur') && saved === 'xp' && windowShell.getState().themeId === 'xp',
  'failed compositor appearance restores persistence and keeps live surfaces');
failAppearance = false;
check(windowShell.selectTheme('bigsur') && appliedAppearances.at(-1) === 'bigsur',
  'successful theme selection updates compositor decorations');
check(windowShell.selectTheme('xp'), 'restore taskbar for window-list checks');
const panelList = () => windowShell.getSurfaces().find(surface => surface.kind === 'panel')
  .window.document.body.firstChild.childNodes.find(node => node.id === 'shell-window-list');
panelList().scrollLeft = 500;
snapshots[0].title = 'Renamed application';
native.onWindowsChanged();
check(panelList().scrollLeft === 500, 'metadata updates preserve taskbar scroll position');
const windowMenu = windowShell.showWindowActions(1, 1);
check(windowMenu && !windowMenu.closed, 'window action menu opens for a live ID');
snapshots = [];
native.onWindowsChanged();
check(windowMenu.closed && panelList().scrollLeft === 0,
  'removing windows closes stale menus and resets overflow scrolling');
failWindows = true;
native.onWindowsChanged();
check(windowShell.getState().error.includes('lost connection'), 'window-list failures are visible');
failWindows = false;
native.onWindowsChanged();
check(!windowShell.getState().error && notifications === 4, 'window-list recovery chains the previous callback');
windowShell.stop();
check(native.onWindowsChanged === originalWindowsChanged, 'stopping the shell restores the previous subscription');

let workspaceActivated = 0, workspaceRemoved = 0, workspaceCreated = 0;
const manualWorkspaces = [
  { id: 7, name: 'Workspace 7', active: true, canRemove: true },
  { id: 9, name: 'Workspace 9', active: false, canRemove: true },
];
render(workspacesView(getDesktopTheme('xp'), manualWorkspaces,
  id => { workspaceActivated = id; }, id => { workspaceRemoved = id; },
  () => { workspaceCreated++; }, () => {}), document.body);
host.render();
let target = document.getElementById('shell-workspace-9');
host.click(target.offsetLeft + 10, target.offsetTop + 10);
check(workspaceActivated === 9, 'workspace selection uses stable IDs rather than display indices');
target = document.getElementById('shell-workspace-remove-7');
host.click(target.offsetLeft + 10, target.offsetTop + 10);
check(workspaceRemoved === 7, 'workspace removal does not activate another row');
target = document.getElementById('shell-workspace-add');
host.click(target.offsetLeft + 10, target.offsetTop + 10);
check(workspaceCreated === 1, 'workspace creation is explicit');
render(workspacesView(getDesktopTheme('xp'), [{ ...manualWorkspaces[0], canRemove: false }],
  () => {}, () => {}, () => {}, () => {}), document.body);
check(!document.getElementById('shell-workspace-remove-7'), 'last-workspace removal is not offered');
render(null, document.body);

check(shortcutText({ modifiers: 10, key: 'Left' }) === 'Ctrl+Super+Left', 'shortcut labels describe the canonical chord');
check(shortcutFromEvent({ key: 'Shift' }) === null, 'recording ignores modifier-only keys');
check(shortcutFromEvent({ key: 'ArrowLeft', ctrlKey: true, metaKey: true }).key === 'Left',
  'recording normalizes DOM arrow names');
let currentShortcuts = [{ action: 'minimize-window', modifiers: 4, key: 'F9' }];
const shortcutBackend = {
  shortcuts() { return currentShortcuts.map(item => ({ ...item })); },
  setShortcuts(items) { currentShortcuts = items.map(item => ({ ...item })); },
};
let failedSave = false;
try {
  saveShortcuts(shortcutBackend, { setItem() { throw new Error('disk full'); } },
    [{ action: 'minimize-window', modifiers: 2, key: 'm' }]);
} catch (error) { failedSave = String(error).includes('disk full'); }
check(failedSave && currentShortcuts[0].key === 'F9', 'failed shortcut persistence restores the previous compositor bindings');

let service = 'ready';
const serviceWarnings = [];
const serviceShell = createDesktopShell({ host: fakeHost, storage, native: {
  sessionServices: () => ({inputMethod:service}),
}, report: message => serviceWarnings.push(message) }).start();
serviceShell.refresh(true);
check(!serviceShell.getState().error && serviceShell.getState().services.inputMethod === 'ready',
  'running Shell observes actual service readiness separately from settings');
service = 'failed';
serviceShell.refresh(true);
check(serviceShell.getState().error.includes('input method failed') && serviceShell.getState().running,
  'input-method failure is visible without stopping the Shell');
const warningCount = serviceWarnings.length;
serviceShell.refresh(true);
check(serviceWarnings.length === warningCount, 'Shell service warnings are not repeatedly logged');
service = 'ready';
serviceShell.refresh(true);
check(!serviceShell.getState().error, 'service recovery clears its warning');
serviceShell.stop();
