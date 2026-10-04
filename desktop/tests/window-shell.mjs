import { createDesktopShell } from './desktop/shell/shell.mjs';

const [mode, executable, script] = application.arguments;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(value, message) {
  if (!value) throw new Error(message);
  console.log('PASS: ' + message);
}
function rejects(action, message) {
  let error = null;
  try { action(); } catch (failure) { error = failure; }
  check(error !== null, message);
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
function bar() {
  const kind = shell.getState().themeId === 'xp' ? 'panel' : 'dock';
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
  check(shell.selectTheme('xp'), 'taskbar theme selected');
  if (mode === 'initial') {
    desktop.spawnApplication(['foot', '--app-id=org.pollyui.window-fixture', '--title=Initial title',
      '/bin/sh', '-c', "sleep 0.4; printf '\\033]2;Updated title\\007'; sleep 300"], '', 'window-fixture');
  }
  await until(() => find()?.active, 'live independent application');
  const id = find().id;
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
    check(shell.selectTheme('bigsur'), 'Big Sur Dock selected');
    await click(bar(), 'shell-window-' + id);
    await until(() => find()?.minimized, 'real Dock button minimizes');
    await click(bar(), 'shell-window-' + id);
    await until(() => find()?.active, 'real Dock button activates');
    const child = desktop.spawnApplication([executable, '--desktop', script, 'denied'], '', 'public-check');
    await until(() => exitCodes.has(child), 'public-client rejection check');
    check(exitCodes.get(child) === 0, 'public window-management requests are rejected without crashing');
    desktop.activateWindow(id);
    await until(() => find()?.active, 'restore application focus after public check');
  } else {
    check(find().title === 'Updated title', 'new Shell connection enumerates the surviving application');
    await menuAction(id, 'close');
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
