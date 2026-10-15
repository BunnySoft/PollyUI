import { createDesktopShell } from './desktop/tests/configured-shell.mjs';
import { BUILTIN_THEME_CATALOG, getDesktopTheme, installThemeCatalog } from './desktop/shell/themes.mjs';
import { encodeDecorationLayout } from './desktop/shared/ui/caption-layout.mjs';
import { applicationMenuPlacement } from './desktop/shared/ui/theme-layout.mjs';

const [mode, executable, script] = application.arguments;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(value, message) {
  if (!value) throw new Error(message);
  console.log('PASS: ' + message);
}
function rejects(action, message, reason = null) {
  let error = null;
  try { action(); } catch (failure) { error = failure; }
  const accepted = error !== null && (!reason || reason(error));
  check(accepted, accepted ? message : message + ' (actual rejection: ' + String(error) + ')');
}
async function until(predicate, message) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error('Timed out: ' + message);
}

let shell;
const created = [];
const outputs = () => window.displays();
let serial = 0;
function marker(title) {
  return window.create({ title, layer: 'overlay', width: 1, height: 1,
    anchors: ['top', 'right'], exclusiveZone: -1 });
}
async function click(surface, id, button = 0) {
  await until(() => surface.window.document.getElementById(id)?.offsetWidth > 0, id + ' layout');
  const node = surface.window.document.getElementById(id);
  const signal = marker(`fixture-click ${++serial} ${Math.floor(node.offsetLeft + node.offsetWidth / 2)} ` +
    `${Math.floor(node.offsetTop + node.offsetHeight / 2)} ${button} ${surface.title}`);
  await until(() => signal.closed, 'compositor pointer injection');
}
async function captionPointer(command, exclusive = false) {
  const signal = marker(`fixture-caption-pointer ${command} ${Number(exclusive)}`);
  await until(() => signal.closed, 'actual caption pointer injection');
}
async function menuKey(code) {
  for (const down of [1, 0]) {
    const signal = marker(`fixture-key ${code} ${down}`);
    await until(() => signal.closed, 'real menu keyboard input');
  }
}
function bar() {
  const kind = getDesktopTheme(shell.getState().themeId).panel.kind === 'dock' ? 'dock' : 'panel';
  const surface = shell.getSurfaces().find(item => item.kind === kind);
  return { window: surface.window, title: `PollyShell.${kind}.${surface.output}` };
}
async function menuAction(id, action) {
  await click(bar(), 'shell-window-' + id, 2);
  await until(() => created.some(item => item.title.startsWith('PollyShell.settings.') && !item.window.closed),
    'real context menu');
  const menu = created.find(item => item.title.startsWith('PollyShell.settings.') && !item.window.closed);
  await click(menu, 'shell-window-' + action);
}
const find = () => desktop.windows().find(item => item.appId === 'org.pollyui.window-fixture');
const exitCodes = new Map();
async function run() {
  if (mode === 'denied') {
    window.create({ title: 'Public window-management rejection', width: 160, height: 100 });
    rejects(() => desktop.windows(), 'public connection cannot enumerate or control foreign windows');
    rejects(() => desktop.activateWindow(1), 'public connection cannot activate a guessed handle');
    const theme = getDesktopTheme('xp');
    rejects(() => desktop.configureAppearance(theme, encodeDecorationLayout(theme)),
      'public connection cannot submit decoration data',
      error => /unavailable|unauthorized|trusted|management connection failed/i.test(error.message));
    window.quit();
    return;
  }
  desktop.onExit = event => exitCodes.set(event.pid, event.status);
  shell = createDesktopShell({ host: {
    close: () => window.close(), displays: outputs,
    create(options) {
      const native = window.create(options);
      created.push({ title: options.title, window: native });
      return native;
    },
  } }).start();
  const readFrames = desktop.decorationRequests;
  desktop.decorationRequests = () => {
    const requests = readFrames();
    for (const request of requests)
      if (JSON.parse(request.document).theme.id === 'server2003')
        console.log('CAPTION_NATIVE_REQUEST ' + JSON.stringify({ title: request.title, meta: request.meta }));
    return requests;
  };
  check(shell.selectTheme('xp'), 'taskbar theme selected');
  if (mode === 'initial') {
    desktop.spawnApplication(['foot', '--app-id=org.pollyui.window-fixture', '--title=Initial title',
      '/bin/sh', '-c', "sleep 0.4; printf '\\033]2;Updated title\\007'; sleep 300"], '', 'window-fixture');
  }
  await until(() => find()?.active, 'live independent application');
  const id = find().id;
  rejects(() => shell.selectTheme('missing'), 'unknown catalog appearance is rejected without losing Shell privilege');
  const invalidIdentity = { ...getDesktopTheme('xp'), id: 'xp\0invalid' };
  rejects(() => desktop.configureAppearance(invalidIdentity, encodeDecorationLayout(invalidIdentity)),
    'appearance identifiers cannot contain embedded NUL',
    error => error.name === 'TypeError' && error.message === 'Invalid appearance identity');
  const initialFrame = marker('fixture-frame-theme xp');
  await until(() => initialFrame.closed, 'Shell theme reaches real application decorations');
  if (mode === 'initial') await until(() => find()?.title === 'Updated title', 'metadata update');
  check(Number.isInteger(id) && ['active', 'minimized', 'maximized', 'fullscreen']
    .every(key => typeof find()[key] === 'boolean'), 'window snapshot has typed metadata and flags');
  await until(() => shell.getSurfaces().filter(item => item.kind === 'panel')
    .every(item => item.window.document.getElementById('shell-window-' + id)), 'window buttons on both outputs');
  await click(bar(), 'shell-window-' + id);
  await until(() => find()?.minimized && !find().active, 'taskbar click minimizes active application');
  await click(bar(), 'shell-window-' + id);
  await until(() => find()?.active && !find().minimized, 'taskbar click restores and activates application');
  if (mode === 'initial') {
    await menuAction(id, 'maximize');
    await until(() => find()?.maximized, 'context menu maximizes application');
    await menuAction(id, 'maximize');
    await until(() => !find()?.maximized, 'context menu unmaximizes application');
    await menuAction(id, 'fullscreen');
    await until(() => find()?.fullscreen, 'context menu enters fullscreen');
    desktop.unfullscreenWindow(id);
    await until(() => !find()?.fullscreen, 'native control leaves fullscreen');
    desktop.minimizeWindow(id);
    await until(() => find()?.minimized, 'native minimize');
    desktop.restoreWindow(id);
    await until(() => !find()?.minimized, 'native restore');
    desktop.activateWindow(id);
    await until(() => find()?.active, 'native activate');
    check(shell.selectTheme('server2003'), 'Classic GUI-rendered frame selected');
    const classicFrame = marker('fixture-frame-theme server2003');
    await until(() => classicFrame.closed, 'Classic strips reach real WM geometry and composition');
    await captionPointer(1);
    await until(() => find()?.maximized, 'actual Classic caption pointer maximizes with menu closed');
    await captionPointer(1);
    await until(() => !find()?.maximized, 'actual Classic caption pointer restores with menu closed');
    await captionPointer(2);
    await until(() => find()?.minimized, 'actual Classic caption pointer minimizes with menu closed');
    await click(bar(), 'shell-window-' + id);
    await until(() => find()?.active && !find()?.minimized, 'Classic taskbar restores after caption minimize');
    const applications = shell.showApplications(outputs()[0].id);
    await until(() => applications.document.getElementById('shell-app-search')?.offsetWidth > 0, 'Classic native menu search layout');
    const placement = marker('fixture-classic-menu-placement');
    await until(() => placement.closed, 'native committed menu uses full output with four-pixel bar overlap');
    const search = applications.document.getElementById('shell-app-search');
    check(applications.document.activeElement === search, 'native Classic menu focuses its real search field');
    await menuKey(20);
    await until(() => search.lastChild.firstChild.textContent === 't', 'real native menu search accepts keyboard text');
    check(applications.document.activeElement === search, 'real search retains focus after filtering');
    const maximized = find().maximized;
    await captionPointer(1, true);
    await delay(50);
    check(!applications.closed && find()?.maximized === maximized,
      'open exclusive Start blocks caption pointer rather than a closed-menu caption failure');
    await menuKey(1);
    await until(() => applications.closed, 'real Escape closes the native application menu');
    const dockPlacement = applicationMenuPlacement(getDesktopTheme('bigsur'), 1280);
    check(dockPlacement.width === 340 && dockPlacement.anchors.join(',') === 'top,left' &&
      dockPlacement.margins.left === 8 && dockPlacement.margins.top === 28,
    'top-Dock full-output placement values are unchanged');
    check(shell.selectTheme('bigsur'), 'Big Sur Dock selected');
    const bigSurFrame = marker('fixture-frame-theme bigsur');
    await until(() => bigSurFrame.closed, 'live Big Sur application frame geometry');
    await click(bar(), 'shell-window-' + id);
    await until(() => find()?.minimized, 'real Dock button minimizes');
    await click(bar(), 'shell-window-' + id);
    await until(() => find()?.active, 'real Dock button activates');
    const custom = JSON.parse(JSON.stringify(getDesktopTheme('bigsur')));
    custom.id = 'external-config';
    custom.name = 'External configuration';
    Object.assign(custom.window, { titleHeight: 52, borderWidth: 2, texture: 'none',
      titleFrom: '#6e3ba7', titleTo: '#6e3ba7' });
    const submitFrame = desktop.submitDecorationFrame;
    let frameProbes = 0;
    desktop.submitDecorationFrame = (meta, strips) => {
      if (frameProbes) return submitFrame(meta, strips);
      rejects(() => submitFrame(meta, [{ ...strips[0], width: strips[0].width + 1 }, ...strips.slice(1)]),
        'native bridge rejects an inexact strip before transport');
      const obsolete = [...meta]; obsolete[1]++;
      check(submitFrame(obsolete, strips) === false, 'WM rejects an unknown frame revision without changing presentation');
      const mismatched = [...meta]; mismatched[2]++;
      rejects(() => submitFrame(mismatched, strips), 'WM rejects a complete frame with a mismatched theme generation');
      const accepted = submitFrame(meta, strips);
      if (accepted) {
        check(submitFrame(meta, strips) === false, 'WM rejects duplicate accepted revisions');
        frameProbes++;
      }
      return accepted;
    };
    installThemeCatalog({ ...BUILTIN_THEME_CATALOG, themes: [...BUILTIN_THEME_CATALOG.themes, custom] });
    check(shell.selectTheme(custom.id), 'custom theme does not require a compiled appearance ID');
    let configured = marker('fixture-frame-style 2 52 6e3ba7');
    await until(() => configured.closed, 'runtime configuration changes real decoration metrics and pixels');
    desktop.submitDecorationFrame = submitFrame;
    check(frameProbes === 1, 'real GUI strips passed bounded protocol negative cases before publication');
    const changed = JSON.parse(JSON.stringify(custom));
    Object.assign(changed.window, { titleHeight: 44, borderWidth: 3, titleFrom: '#325788', titleTo: '#325788' });
    installThemeCatalog({ ...BUILTIN_THEME_CATALOG, themes: [...BUILTIN_THEME_CATALOG.themes, changed] });
    check(shell.selectTheme(changed.id), 'same-ID data revision reaches the compositor');
    configured = marker('fixture-frame-style 3 44 325788');
    await until(() => configured.closed, 'updated same-ID appearance is displayed');
    const invalid = JSON.parse(JSON.stringify(changed));
    invalid.window.titleHeight = 10000;
    rejects(() => desktop.configureAppearance(invalid, encodeDecorationLayout(invalid)),
      'native boundary rejects unsafe geometry',
      error => error.name === 'RangeError' && error.message === 'Invalid decoration geometry');
    configured = marker('fixture-frame-style 3 44 325788');
    await until(() => configured.closed, 'rejected configuration preserves committed appearance');
    installThemeCatalog(BUILTIN_THEME_CATALOG);
    check(shell.selectTheme('bigsur'), 'builtin appearance can be restored after runtime configuration');
    const child = desktop.spawnApplication([executable, '--desktop', script, 'denied'], '', 'public-check');
    await until(() => exitCodes.has(child), 'public-client rejection check');
    check(exitCodes.get(child) === 0, 'public window-management requests are rejected without crashing');
    desktop.activateWindow(id);
    await until(() => find()?.active, 'restore application focus after public check');
  } else {
    check(find().title === 'Updated title', 'new Shell connection enumerates the surviving application');
    check(shell.selectTheme('server2003'), 'Classic caption selected for the real close-pointer check');
    const closeFrame = marker('fixture-frame-theme server2003');
    await until(() => closeFrame.closed, 'real Classic close-button geometry is committed');
    await captionPointer(0);
    await until(() => !find(), 'graceful close removes the foreign handle');
    await until(() => shell.getSurfaces().filter(item => item.kind === 'panel')
      .every(item => !item.window.document.getElementById('shell-window-' + id)), 'closed window buttons removed');
    rejects(() => desktop.activateWindow(id), 'stale IDs are rejected');
    const replacement = window.create({ title: 'Replacement lifetime', width: 240, height: 140 });
    await until(() => desktop.windows().some(item => item.title === 'Replacement lifetime'), 'replacement handle');
    check(desktop.windows().find(item => item.title === 'Replacement lifetime').id > id, 'IDs are never reused');
    replacement.close();
  }
  check(!shell.getState().error, 'Shell reports no window-management errors');
  const success = marker('fixture-success');
  await until(() => success.closed, 'suite acknowledgement');
  shell.stop();
  window.quit();
}
run().catch(error => {
  console.error('FAIL: ' + String(error) + '\n' + (error.stack || ''));
  shell?.stop();
  window.quit();
});
