import { createDesktopShell } from './desktop/tests/configured-shell.mjs';
import { BUILTIN_THEME_CATALOG, getDesktopTheme, installThemeCatalog } from './desktop/shell/themes.mjs';
import { encodeDecorationLayout } from './desktop/shared/ui/caption-layout.mjs';
import { applicationMenuPlacement } from './desktop/shared/ui/theme-layout.mjs';
import { readPrivateConfigurationFile } from './desktop/shared/configuration-files.mjs';
import { SHELL_CONFIGURATION_FILE } from './desktop/shell/configuration.mjs';
import { windowTasks, taskLabel } from './desktop/shell/window-groups.mjs';

const [mode, executable, script] = application.arguments;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(value, message) {
  if (!value) throw new Error(message);
  console.log('PASS: ' + message);
}
async function placementMenu(id) {
  const native = shell.showWindowActions(outputs()[0].id, id);
  await until(() => native.document.getElementById('shell-window-tile-left')?.offsetWidth > 0, 'window menu layout');
  const ready = marker('fixture-placement-menu-ready');
  await until(() => ready.closed, 'actual menu presentation and native keyboard focus');
  return native;
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
  const owner = surface.window.document, deadline = Date.now() + 30000;
  let previous, rect;
  for (;;) {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const node = owner.getElementById(id), bounds = owner.body.getBoundingClientRect();
    rect = node?.getBoundingClientRect();
    if (!surface.window.closed && node?.ownerDocument === owner && rect?.width > 0 && rect.height > 0 &&
        previous?.node === node && ['x', 'y', 'width', 'height'].every(key => rect[key] === previous.rect[key]) &&
        rect.x + rect.width / 2 >= bounds.x && rect.x + rect.width / 2 < bounds.x + bounds.width &&
        rect.y + rect.height / 2 >= bounds.y && rect.y + rect.height / 2 < bounds.y + bounds.height) break;
    if (Date.now() > deadline) throw new Error('Timed out: stable native control geometry ' + id);
    previous = { node, rect };
  }
  const signal = marker(`fixture-click ${++serial} ${Math.floor(rect.x + rect.width / 2)} ` +
    `${Math.floor(rect.y + rect.height / 2)} ${button} ${surface.title}`);
  await until(() => signal.closed, 'compositor pointer injection');
}
async function captionPointer(command, exclusive = 0) {
  const signal = marker(`fixture-caption-pointer ${command} ${Number(exclusive)}`);
  await until(() => signal.closed, 'actual caption pointer injection');
}
async function menuKey(code) {
  for (const down of [1, 0]) {
    const signal = marker(`fixture-key ${code} ${down}`);
    await until(() => signal.closed, 'real menu keyboard input');
  }
}
async function classicApplications() {
  const applications = shell.showApplications(outputs()[0].id);
  await until(() => applications.document.getElementById('shell-app-search')?.offsetWidth > 0, 'Classic native menu search layout');
  const signal = marker('fixture-classic-menu-placement');
  await until(() => signal.closed, 'native committed menu uses full output with four-pixel bar overlap');
  return applications;
}
function bar() {
  const kind = getDesktopTheme(shell.getState().themeId).panel.kind === 'dock' ? 'dock' : 'panel';
  const surface = shell.getSurfaces().find(item => item.kind === kind);
  return { window: surface.window, title: `PollyShell.${kind}.${surface.output}` };
}
async function menuAction(id, action) {
  await click(bar(), 'shell-window-' + id, 2);
  await until(() => created.some(item => item.title.startsWith('PollyShell.menu.') && !item.window.closed),
    'real context menu');
  const menu = created.find(item => item.title.startsWith('PollyShell.menu.') && !item.window.closed);
  await click(menu, 'shell-window-' + action);
}
async function snapKey(code) {
  const down = marker('fixture-key 125 1');
  await until(() => down.closed, 'Super down');
  await menuKey(code);
  const up = marker('fixture-key 125 0');
  await until(() => up.closed, 'Super up');
}
async function placementMark(command, slot, mode) {
  const signal = marker(`fixture-placement-${command} ${slot} ${mode}`);
  await until(() => signal.closed, 'native placement ' + command + ' ' + slot);
}
const find = () => desktop.windows().find(item => item.appId === 'org.pollyui.window-fixture');
const exitCodes = new Map();
async function run() {
  if (mode === 'pointer-client') {
    const receiver = window.create({ title: 'Menu pointer receiver', width: 240, height: 120 });
    const target = receiver.document.createElement('view');
    Object.assign(target.style, { width: '100%', height: '100%', backgroundColor: '#202020' });
    let clicks = 0;
    target.addEventListener('click', () => {
      clicks++;
      target.style.backgroundColor = clicks === 1 ? '#00ff00' : '#ff0000';
      console.log('MENU_PUBLIC_CLIENT_CLICKS ' + clicks);
    });
    receiver.document.body.addEventListener('mousedown', event =>
      console.log('MENU_PUBLIC_CLIENT_DOWN ' + JSON.stringify({ x: event.clientX, y: event.clientY, target: event.target === target })));
    receiver.document.body.addEventListener('mouseup', event =>
      console.log('MENU_PUBLIC_CLIENT_UP ' + JSON.stringify({ x: event.clientX, y: event.clientY, target: event.target === target })));
    receiver.document.body.appendChild(target);
    setTimeout(() => console.log('MENU_PUBLIC_CLIENT_BOUNDS ' + JSON.stringify({
      body: receiver.document.body.getBoundingClientRect(), target: target.getBoundingClientRect(),
    })), 100);
    receiver.onclose = () => window.quit();
    window.close();
    return;
  }
  if (mode === 'denied') {
    window.create({ title: 'Public window-management rejection', width: 160, height: 100 });
    rejects(() => desktop.windows(), 'public connection cannot enumerate or control foreign windows');
    rejects(() => desktop.activateWindow(1), 'public connection cannot activate a guessed handle');
    rejects(() => desktop.tileWindow(1, 'left', 1), 'public connection cannot place another application using guessed IDs or epochs');
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
  check(typeof desktop.decorationRequests === 'undefined' && typeof desktop.submitDecorationFrame === 'undefined',
    'Shell cannot consume the independent renderer queue or submit decoration frames');
  check(shell.selectTheme('xp'), 'taskbar theme selected');
  if (['initial', 'placement', 'placement-old'].includes(mode)) {
    desktop.spawnApplication(['foot', '--app-id=org.pollyui.window-fixture', '--title=Initial title',
      '/bin/sh', '-c', "sleep 0.4; printf '\\033]2;Updated title\\007'; sleep 300"], '', 'window-fixture');
  }
  await until(() => find()?.active, 'live independent application');
  const id = find().id;
  if (mode === 'placement-old') {
    check(typeof desktop.tileWindow === 'function' && find().placement === undefined,
      'old compositor does not invent placement capability from new API function presence');
    const current = shell.showWindowActions(outputs()[0].id, id);
    await until(() => current.document.getElementById('shell-window-close')?.offsetWidth > 0, 'old-provider production menu');
    check(['tile-left', 'tile-right', 'restore-floating'].every(action =>
      !current.document.getElementById('shell-window-' + action)), 'old-provider menu hides all unavailable placement commands');
    current.document.getElementById('shell-window-menu-close').focus();
    await menuKey(28);
    await until(() => current.closed, 'old-provider Close menu remains functional');
    const success = marker('fixture-success');
    await until(() => success.closed, 'old-provider suite acknowledgement');
    shell.stop(); window.quit(); return;
  }
  if (mode === 'placement') {
    check(typeof desktop.tileWindow === 'function' && typeof desktop.restoreFloatingWindow === 'function' &&
      ['floating', 'left', 'right'].includes(find().placement), 'real paired native placement API and readonly state');
    const tileWindow = desktop.tileWindow, restoreFloatingWindow = desktop.restoreFloatingWindow;
    let admissions = 0;
    desktop.tileWindow = (...args) => { const result = tileWindow(...args); if (result.admitted) admissions++; return result; };
    desktop.restoreFloatingWindow = (...args) => {
      const result = restoreFloatingWindow(...args); if (result.admitted) admissions++; return result;
    };
    await until(() => !find()?.placementPending && (find()?.placementCapabilities & 3) === 3, 'settled native placement capability');
    await placementMark('save', 0, 0);
    await snapKey(105);
    await until(() => find()?.placement === 'left' && !find()?.placementPending, 'keyboard half-left presented');
    await placementMark('save', 1, 3);
    await snapKey(106);
    await until(() => find()?.placement === 'right' && !find()?.placementPending, 'keyboard half-right presented');
    await placementMark('save', 2, 4);
    await snapKey(108);
    await until(() => find()?.placement === 'floating' && !find()?.placementPending, 'keyboard restore presented');
    await placementMark('check', 0, 0);
    const preferences = () => JSON.stringify(Array.from(readPrivateConfigurationFile(application.configDir, SHELL_CONFIGURATION_FILE)));
    const pointerPreferences = preferences();
    for (const [action, state, slot, nativeMode] of [
      ['tile-left', 'left', 1, 3], ['tile-right', 'right', 2, 4], ['restore-floating', 'floating', 0, 0],
    ]) {
      const count = admissions;
      await menuAction(id, action);
      await until(() => find()?.placement === state && !find()?.placementPending, action + ' actual client/frame presentation');
      await placementMark('check', slot, nativeMode);
      check(admissions === count + 1, 'real pointer admits exactly one ' + action);
    }
    check(preferences() === pointerPreferences && shell.configuration.snapshot.version === 5,
      'native pointer placement preserves exact v4 preference bytes');
    check(shell.selectTheme('server2003'), 'Classic uses the same native window placement commands');
    const keyboardPreferences = preferences();
    for (const [action, state] of [['tile-left', 'left'], ['tile-right', 'right'], ['restore-floating', 'floating']]) {
      const count = admissions;
      const current = await placementMenu(id);
      const node = current.document.getElementById('shell-window-' + action);
      node.focus();
      await menuKey(28);
      await until(() => current.closed && find()?.placement === state && !find()?.placementPending,
        'real Enter admits one Classic ' + action);
      check(admissions === count + 1, 'real Enter admits exactly one ' + action);
    }
    check(preferences() === keyboardPreferences, 'native Enter placement preserves exact preference bytes');
    const deniedMenu = await placementMenu(id);
    const before = find().placement;
    await snapKey(105);
    check(find().placement === before, 'original keyboard path still rejects a focused menu layer');
    deniedMenu.document.getElementById('shell-window-menu-close').focus();
    await menuKey(28);
    await until(() => deniedMenu.closed, 'real Enter closes the placement menu');
    const resize = marker('fixture-placement-output-height 360');
    await until(() => resize.closed && outputs()[0].height === 360 &&
      shell.getSurfaces().find(item => item.kind === 'wallpaper' && item.output === outputs()[0].id)
        ?.window.document.body.offsetHeight === 360, 'real short output and production Shell surfaces');
    await menuAction(id, 'tile-left');
    await until(() => find()?.placement === 'left' && !find()?.placementPending, 'short-output half presented');
    const short = await placementMenu(id), visited = new Set();
    short.document.body.focus();
    for (let index = 0; index < 24; index++) {
      await menuKey(15);
      visited.add(short.document.activeElement?.id);
    }
    for (const command of ['activate', 'minimize', 'maximize', 'fullscreen', 'tile-left', 'tile-right',
      'restore-floating', 'close', 'menu-close'])
      check(visited.has('shell-window-' + command), 'real short-menu Tab reaches ' + command);
    check([...visited].some(id => id?.startsWith('shell-window-workspace-')), 'short-menu Tab reaches Move workspace');
    const beforeBack = short.document.activeElement;
    const shift = marker('fixture-key 42 1');
    await until(() => shift.closed, 'Shift down');
    await menuKey(15);
    const shiftUp = marker('fixture-key 42 0');
    await until(() => shiftUp.closed, 'Shift up');
    check(short.document.activeElement !== beforeBack, 'real Shift+Tab reverses window menu navigation');
    check(Number(short.document.getElementById('shell-window-actions-viewport-scrollbar').style.opacity) > 0,
      'long short-output menu retains the shared interactive scrollbar');
    await menuKey(1);
    await until(() => short.closed, 'short menu Escape');
    const restoreOutput = marker('fixture-placement-output-height 720');
    await until(() => restoreOutput.closed && outputs()[0].height === 720, 'restore fixture output only');
    check(!shell.getState().error, 'placement menu has no management error');
    desktop.tileWindow = tileWindow; desktop.restoreFloatingWindow = restoreFloatingWindow;
    const success = marker('fixture-success');
    await until(() => success.closed, 'placement suite acknowledgement');
    shell.stop(); window.quit(); return;
  }
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
  await until(() => {
    const panels = shell.getSurfaces().filter(item => item.kind === 'panel');
    return outputs().length === 2 && panels.length === 2 &&
      outputs().every(output => panels.filter(panel => panel.output === output.id).length === 1) &&
      panels.every(panel => panel.window.document.getElementById('shell-window-' + id)?.offsetWidth > 0);
  }, 'window buttons on both outputs');
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
    const prompt = window.create({ title: 'Fixture.exclusive.prompt', layer: 'overlay',
      output: outputs()[0].id, width: 200, height: 100, anchors: ['top', 'right'],
      keyboard: 'exclusive', exclusiveZone: -1 });
    const promptReady = marker('fixture-exclusive-prompt-ready');
    await until(() => promptReady.closed, 'non-menu exclusive prompt has native focus');
    const promptMaximized = find().maximized;
    await captionPointer(1, 2);
    check(!prompt.closed && find()?.maximized === promptMaximized,
      'non-menu exclusive prompt is not dismissed and still blocks caption actions');
    prompt.close();
    const applications = await classicApplications();
    const search = applications.document.getElementById('shell-app-search');
    check(applications.document.activeElement === search, 'native Classic menu focuses its real search field');
    await menuKey(20);
    await until(() => search.textContent === 't' &&
      applications.document.getElementById('shell-app-search-hint')?.style.display === 'none' &&
      applications.document.getElementById('shell-app-org.pollyui.settings')?.getAttribute('aria-disabled') === 'false',
    'real native menu search accepts keyboard text and keeps matching Settings enabled');
    await menuKey(44);
    await until(() => search.textContent === 'tz' &&
      !applications.document.getElementById('shell-app-org.pollyui.settings') &&
      applications.document.getElementById('shell-start-apps')?.textContent === 'No matching applications',
    'real typing filters application rows, not only the search label');
    await menuKey(14);
    await until(() => search.textContent === 't' &&
      applications.document.getElementById('shell-app-org.pollyui.settings')?.getAttribute('aria-disabled') === 'false',
    'native Backspace restores the matching application');
    await menuKey(105);
    await menuKey(18);
    await until(() => search.textContent === 'et', 'native caret navigation survives menu reconciliation');
    for (const [code, down] of [[29, 1], [30, 1], [30, 0], [29, 0]]) {
      const selection = marker(`fixture-key ${code} ${down}`);
      await until(() => selection.closed, 'native search selection');
    }
    await menuKey(20);
    await until(() => search.textContent === 't', 'native selection replacement survives filtering');
    check(applications.document.activeElement === search &&
      applications.document.getElementById('shell-app-search') === search,
    'real search retains its DOM identity and focus after filtering');
    await menuKey(1);
    await until(() => applications.closed, 'real Escape closes the native application menu');
    const toggleMenu = await classicApplications();
    await click(bar(), 'shell-menu');
    await until(() => toggleMenu.closed, 'owned launcher closes Start rather than reopening it');
    await click(bar(), 'shell-menu');
    await until(() => created.some(item => item.title.startsWith('PollyShell.menu.') && !item.window.closed),
      'owned launcher opens Start exactly once');
    const toggleOpened = created.find(item => item.title.startsWith('PollyShell.menu.') && !item.window.closed);
    const toggleReady = marker('fixture-classic-menu-placement');
    await until(() => toggleReady.closed, 'launcher-opened menu has committed native geometry and focus');
    await menuKey(1);
    await until(() => toggleOpened.window.closed, 'Escape closes launcher-opened Start');
    const cancelMenu = await classicApplications();
    const cancelPress = marker('fixture-menu-caption-cancel');
    await until(() => cancelPress.closed && cancelMenu.closed, 'outside caption press dismisses menu before cancellation');
    check(find()?.id === id && !find()?.minimized, 'dragging off close before release cancels the action');
    const maximizeMenu = await classicApplications();
    await captionPointer(1, 1);
    await until(() => maximizeMenu.closed && find()?.maximized,
      'one outside caption press dismisses Start and maximizes exactly once');
    await captionPointer(1);
    await until(() => !find()?.maximized, 'caption restore after outside-menu maximize');
    const minimizeMenu = await classicApplications();
    await captionPointer(2, 1);
    await until(() => minimizeMenu.closed && find()?.minimized,
      'one outside caption press dismisses Start and minimizes');
    await click(bar(), 'shell-window-' + id);
    await until(() => find()?.active && !find()?.minimized, 'restore after outside-menu minimize');
    // Test WM delivery with a client that opts into handling its activation click.
    const pointerPid = desktop.spawnApplication(['env', 'SDL_MOUSE_FOCUS_CLICKTHROUGH=1', 'WAYLAND_DEBUG=client', executable, '--desktop', '--app-id',
      'org.pollyui.menu-pointer-fixture', script, 'pointer-client'], '', 'pointer-receiver');
    const pointerWindow = () => desktop.windows().find(item => item.appId === 'org.pollyui.menu-pointer-fixture');
    await until(() => pointerWindow()?.active, 'independent pointer receiver is mapped and active');
    const clientMenu = await classicApplications();
    const clientPress = marker('fixture-menu-client-click');
    await until(() => clientPress.closed && clientMenu.closed,
      'outside press dismisses menu and reaches the real foreign client once');
    desktop.closeWindow(pointerWindow().id);
    await until(() => exitCodes.has(pointerPid), 'ordinary pointer receiver cleanup');
    check(exitCodes.get(pointerPid) === 0, 'ordinary pointer receiver exits cleanly');
    desktop.activateWindow(id);
    await until(() => find()?.active, 'restore target after foreign-client outside click');
    const dockPlacement = applicationMenuPlacement(getDesktopTheme('bigsur'), 1280);
    check(dockPlacement.width === 340 && dockPlacement.anchors.join(',') === 'top,left' &&
      dockPlacement.margins.left === 8 && dockPlacement.margins.top === 28,
    'top-Dock full-output placement values are unchanged');
    check(shell.selectTheme('bigsur'), 'Big Sur Dock selected');
    const bigSurFrame = marker('fixture-frame-theme bigsur');
    await until(() => bigSurFrame.closed, 'live Big Sur application frame geometry');
    check(shell.configuration.snapshot.launchers.applications.length === 0, 'Dock fixture has no catalog pins');
    const dockTask = () => windowTasks(desktop.windows().filter(item =>
      item.workspaceId === desktop.workspaces().find(workspace => workspace.active)?.id),
      getDesktopTheme(shell.getState().themeId).panel.taskGrouping)
      .find(task => task.grouped && task.windows.some(item => item.id === id));
    const dockButtons = minimized => {
      const task = dockTask(), surfaces = shell.getSurfaces().filter(item => item.kind === 'dock');
      return task?.appId === find()?.appId && task.count === 1 && task.windows[0].id === id &&
        task.minimized === minimized && outputs().length === 2 && surfaces.length === 2 &&
        outputs().every(output => surfaces.filter(surface => surface.output === output.id).length === 1) &&
        surfaces.every(surface => {
          const node = surface.window.document.getElementById('shell-window-' + task.id);
          return node?.offsetWidth > 0 && node.getAttribute('aria-label') === taskLabel(task);
        });
    };
    await until(() => dockButtons(false), 'both real Docks expose the exact-appId single-window group');
    const activateWindow = desktop.activateWindow;
    let dockActivations = 0;
    desktop.activateWindow = (...args) => {
      const result = activateWindow(...args);
      if (args[0] === id) dockActivations++;
      return result;
    };
    await click(bar(), 'shell-window-' + dockTask().id);
    await until(() => dockActivations === 1 && find()?.active && !find()?.minimized && dockButtons(false),
      'real single-window Dock click activates without minimizing');
    desktop.minimizeWindow(id);
    await until(() => find()?.minimized && !find()?.active && dockButtons(true),
      'native minimize updates the real Dock group on both outputs');
    await click(bar(), 'shell-window-' + dockTask().id);
    await until(() => dockActivations === 2 && find()?.active && !find()?.minimized && dockButtons(false),
      'real Dock group restores and activates the minimized application');
    desktop.activateWindow = activateWindow;
    const custom = JSON.parse(JSON.stringify(getDesktopTheme('bigsur')));
    custom.id = 'external-config';
    custom.name = 'External configuration';
    Object.assign(custom.window, { titleHeight: 52, borderWidth: 2, texture: 'none',
      titleFrom: '#6e3ba7', titleTo: '#6e3ba7' });
    installThemeCatalog({ ...BUILTIN_THEME_CATALOG, themes: [...BUILTIN_THEME_CATALOG.themes, custom] });
    check(shell.selectTheme(custom.id), 'custom theme does not require a compiled appearance ID');
    let configured = marker('fixture-frame-style 2 52 6e3ba7');
    await until(() => configured.closed, 'runtime configuration changes real decoration metrics and pixels');
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
    const closeMenu = await classicApplications();
    await captionPointer(0, 1);
    await until(() => closeMenu.closed, 'outside close-button press dismisses Start');
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
