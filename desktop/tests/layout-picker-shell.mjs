import { createDesktopShell } from './desktop/shell/shell.mjs';
import { defaultShellConfiguration } from './desktop/shell/configuration.mjs';
import { memoryConfiguration } from './desktop/tests/configuration-memory.mjs';
import { runtimeBuild } from './desktop/client/settings-contract.mjs';

const [mode] = application.arguments;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(value, message) {
  if (!value) throw new Error(message);
  console.log('PASS: ' + message);
}
async function until(predicate, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error('Timed out: ' + message);
}
function denied(action) {
  let error;
  try { action(); } catch (failure) { error = failure; }
  check(!!error, 'public connection cannot access native caption grants');
}
async function run() {
  const build = runtimeBuild();
  check(/^[0-9a-f]{40}$/.test(build.revision) && build.sourceDirty === false, 'fresh GUI embeds a clean actual source revision');
  console.log('PICKER_GUI_BUILD ' + JSON.stringify(build));
  if (mode === 'denied') {
    denied(() => desktop.layoutPickerCapability());
    denied(() => desktop.enableLayoutPicker(true));
    denied(() => desktop.openLayoutPicker(1, window));
    const witness = window.create({ title: 'Picker.public.denied', width: 160, height: 80 });
    window.close();
    await until(() => witness.closed, 'public denial witness acknowledged');
    window.quit();
    return;
  }
  const created = [];
  const configuration = memoryConfiguration({ ...defaultShellConfiguration(),
    theme: { id: 'modern', filesEnabled: false } });
  const shell = createDesktopShell({ configuration, host: {
    close: () => window.close(), displays: () => window.displays(),
    create(options) {
      const owned = window.create(options);
      created.push({ window: owned, options });
      return owned;
    },
  } }).start();
  const current = () => created.findLast(item => !item.window.closed &&
    item.window.document.getElementById('shell-layout-picker'));
  const target = () => desktop.windows().find(item => item.appId === 'org.pollywm.test.7');
  async function signal(name) {
    const marker = window.create({ title: name, layer: 'overlay', width: 1, height: 1,
      anchors: ['top', 'right'], exclusiveZone: -1 });
    await until(() => marker.closed, name);
  }
  async function key(code, shift = false) {
    await signal('picker-key ' + code + ' ' + Number(shift));
  }
  async function hover() {
    await signal('picker-hover');
    await until(() => current(), 'production Shell native maximize hover menu');
    const menu = current();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return menu;
  }
  async function click(menu, id) {
    const node = menu.window.document.getElementById(id);
    const rect = node?.getBoundingClientRect();
    check(rect?.width > 0 && rect.height > 0, id + ' has real GUI control geometry');
    await signal('picker-click ' + Math.floor(rect.x + rect.width / 2) + ' ' +
      Math.floor(rect.y + rect.height / 2));
  }
  async function presented(placement, nativeMode) {
    await until(() => target()?.placement === placement && !target()?.placementPending, placement + ' presented');
    await signal('picker-check ' + nativeMode);
  }
  await signal('picker-ready');
  check(desktop.layoutPickerCapability() === (mode !== 'old'), 'actual paired provider capability');
  await signal('picker-original');
  await delay(550);
  check(!current() && !target()?.maximized, 'native maximize clicks and title double-click retain once-only toggles without a picker');
  if (mode === 'old') {
    await signal('picker-hover');
    await delay(600);
    check(!current(), 'actual v3 provider never receives unsupported picker requests');
    const menu = shell.showWindowActions(window.displays()[0].id, target().id);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    check(!!menu.document.getElementById('shell-window-tile-left'), 'v3 placement menu is still available');
    await key(1);
    await until(() => menu.closed, 'old provider menu Escape');
  } else {
    await signal('picker-cancel-before');
    await delay(600);
    check(!current(), 'leaving native Max before the single hover delay cancels without a popup');
    let menu = await hover();
    check(menu.window.document.getElementById('shell-window-restore-floating').getAttribute('aria-disabled') === 'true',
      'floating target has no invented saved-floating Restore');
    await key(15);
    await until(() => menu.window.document.activeElement?.id === 'shell-window-tile-left', 'real Tab reaches left half');
    await key(15, true);
    await key(1);
    await until(() => menu.window.closed, 'real Escape closes picker');
    menu = await hover();
    await click(menu, 'shell-window-tile-left');
    await until(() => menu.window.closed, 'pointer left admission closes picker');
    await presented('left', 3);
    menu = await hover();
    await key(15); await key(15); await key(28);
    await until(() => menu.window.closed, 'real Enter right admission closes picker');
    await presented('right', 4);
    menu = await hover();
    await click(menu, 'shell-window-restore-floating');
    await until(() => menu.window.closed, 'pointer Restore closes picker');
    await presented('floating', 0);
    for (const guard of ['keyboard', 'pointer', 'recording', 'lock', 'fullscreen', 'minimized', 'modal', 'workspace']) {
      menu = await hover();
      if (guard === 'recording') desktop.captureShortcuts(true);
      await signal('picker-guard ' + guard);
      await until(() => menu.window.closed, guard + ' revokes actual picker input/epoch');
      if (guard === 'recording') desktop.captureShortcuts(false);
      await signal('picker-unguard ' + guard);
    }
    menu = await hover();
    check(shell.selectTheme('xp'), 'retaining ordinary theme switch');
    await until(() => menu.window.closed, 'retheme revokes picker');
    check(shell.selectTheme('modern'), 'restore Modern opt-in');
    await signal('picker-small');
    menu = await hover();
    const { width, height, margins } = menu.options;
    check(width <= 640 && height <= 180 && margins.left >= 0 && margins.top >= 0 &&
      margins.left + width <= 640 && margins.top + height <= 180, 'small negative-origin output clamps logical picker bounds');
    const visited = new Set();
    for (let i = 0; i < 12; i++) {
      await key(15);
      visited.add(menu.window.document.activeElement?.id);
    }
    check(visited.has('shell-window-menu-close'), 'small viewport real Tab reaches Close through the shared scroll viewport');
    await key(1);
    await until(() => menu.window.closed, 'small picker Escape');
    await signal('picker-normal');
    menu = await hover();
    await signal('picker-retire');
    await until(() => menu.window.closed, 'actual target unmap revokes picker');
    await signal('picker-remap');
    menu = await hover();
    shell.stop();
    await until(() => menu.window.closed, 'Shell stop revokes and closes owned picker');
    await signal('picker-stopped');
    await delay(550);
    check(!current(), 'stopped Shell never resurrects a queued hover');
  }
  check(!shell.getState().error, 'no picker business error replaced independent material status');
  shell.stop();
  await signal('picker-success');
  window.quit();
}
run().catch(failure => {
  console.error('FAIL: ' + String(failure) + '\n' + failure.stack);
  window.quit();
});
