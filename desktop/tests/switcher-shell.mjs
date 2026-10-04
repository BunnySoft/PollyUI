import { createDesktopShell } from './desktop/shell/shell.mjs';
import { SHORTCUTS_KEY } from './desktop/shell/shortcuts.mjs';

const [mode, executable, script] = application.arguments;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(value, message) {
  if (!value) throw new Error(message);
  console.log('PASS: ' + message);
}
function rejects(action, message) {
  let rejected = false;
  try { action(); } catch { rejected = true; }
  check(rejected, message);
}
async function until(predicate, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (predicate()) return; await delay(10); }
  throw new Error('Timed out: ' + message);
}
const created = [], reports = [], exits = new Map();
let shell, serial = 0;
function app(suffix) { return desktop.windows().find(item => item.appId === 'org.pollyui.switch-' + suffix); }
async function signal(title) {
  const marker = window.create({ title, layer: 'overlay', width: 1, height: 1,
    anchors: ['top', 'right'], exclusiveZone: -1 });
  await until(() => marker.closed, title);
}
async function key(code, down) { await signal(`fixture-key ${code} ${down ? 1 : 0}`); }
async function tap(code) { await key(code, true); await key(code, false); }
async function click(surface, id) {
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const node = surface.window.document.getElementById(id);
  check(node && node.offsetWidth > 0, id + ' is laid out');
  const rect = node.getBoundingClientRect();
  await signal(`fixture-click ${++serial} ${Math.floor(rect.x + rect.width / 2)} ` +
    `${Math.floor(rect.y + rect.height / 2)} 0 ${surface.title}`);
}
const ALT = 56, SHIFT = 42, CTRL = 29, TAB = 15, ESC = 1, M = 50;
async function beginSwitch() {
  await key(ALT, true); await tap(TAB);
  await until(() => desktop.windowSwitcher().active, 'visual switcher starts');
}
const selected = () => {
  const snapshot = desktop.windowSwitcher();
  return snapshot.items[snapshot.selected]?.appId;
};

async function run() {
  if (mode === 'denied') {
    window.create({ title: 'Public shortcut rejection', width: 100, height: 100 });
    rejects(() => desktop.shortcuts(), 'public shortcut access is rejected');
    rejects(() => desktop.enableWindowSwitcher(true), 'public switcher presenter is rejected');
    rejects(() => desktop.captureShortcuts(true), 'public shortcut capture is rejected');
    window.quit();
    return;
  }
  desktop.onExit = event => exits.set(event.pid, event.status);
  shell = createDesktopShell({ report: message => { reports.push(message); console.error(message); }, host: {
    close: () => window.close(), displays: () => window.displays(),
    create(options) {
      const native = window.create(options);
      created.push({ title: options.title, window: native });
      return native;
    },
  } }).start();
  if (mode === 'initial') {
    for (const suffix of ['a', 'b', 'c']) {
      desktop.spawnApplication(['foot', '--app-id=org.pollyui.switch-' + suffix, '--title=Window ' + suffix,
        '/bin/sh', '-c', 'sleep 300'], '', 'switch-' + suffix);
      await until(() => app(suffix)?.active, 'window ' + suffix + ' maps');
    }
    await beginSwitch();
    check(selected() === app('b').appId && app('c').active, 'MRU preview does not activate until release');
    await until(() => created.some(item => item.title.startsWith('PollyShell.switcher.') &&
      !item.window.closed && item.window.document.getElementById('shell-window-switcher')?.offsetWidth > 0),
    'actual native switcher surface');
    const visual = created.find(item => item.title.startsWith('PollyShell.switcher.') && !item.window.closed);
    check(visual.window.document.getElementById('shell-switcher-item-1').getAttribute('aria-pressed') === 'true',
      'native overlay highlights the selected window');
    await tap(TAB);
    await until(() => selected() === app('a').appId, 'forward cycling');
    await key(SHIFT, true); await tap(TAB); await key(SHIFT, false);
    await until(() => selected() === app('b').appId, 'reverse cycling');
    await tap(ESC); await key(ALT, false);
    check(!desktop.windowSwitcher().active && app('c').active, 'Escape cancels without exiting the session');
    await beginSwitch(); await key(ALT, false);
    await until(() => app('b').active && !desktop.windowSwitcher().active, 'modifier release activates selection');
    desktop.minimizeWindow(app('a').id);
    await until(() => app('a').minimized, 'minimized candidate');
    await beginSwitch();
    const snapshot = desktop.windowSwitcher();
    const index = snapshot.items.findIndex(item => item.appId === app('a').appId);
    await until(() => created.some(item => item.title.startsWith('PollyShell.switcher.') && !item.window.closed),
      'picker for pointer selection');
    await click(created.find(item => item.title.startsWith('PollyShell.switcher.') && !item.window.closed),
      'shell-switcher-item-' + index);
    await key(ALT, false);
    await until(() => app('a').active && !app('a').minimized, 'pointer acceptance restores minimized window');
    await beginSwitch();
    const old = desktop.windowSwitcher();
    const closingId = old.items[old.selected].appId;
    desktop.closeWindow(desktop.windows().find(item => item.appId === closingId).id);
    await until(() => desktop.windowSwitcher().items.length === 2, 'closing a candidate updates the picker');
    rejects(() => desktop.acceptWindowSwitch(old.serial, old.selected), 'stale picker clicks are rejected');
    await tap(ESC); await key(ALT, false);
    const other = desktop.windows().find(item => item.appId.startsWith('org.pollyui.switch-') && item.appId !== app('a').appId);
    await beginSwitch();
    desktop.moveWindowToWorkspace(other.id, desktop.workspaces().find(item => !item.active).id);
    await until(() => !desktop.windowSwitcher().active, 'workspace moves cancel an active picker');
    await key(ALT, false);
    await beginSwitch();
    check(desktop.windowSwitcher().items.length === 1, 'picker excludes other workspaces');
    await key(ALT, false);
    const output = shell.getState().outputs[0];
    const menuWindow = shell.showShortcuts(output);
    const menu = created.find(item => item.window === menuWindow);
    await click(menu, 'shell-shortcut-minimize-window');
    await key(CTRL, true); await tap(M); await key(CTRL, false);
    await until(() => desktop.shortcuts().find(item => item.action === 'minimize-window').key === 'm',
      'recorded shortcut is applied');
    check(JSON.parse(localStorage.getItem(SHORTCUTS_KEY)).some(item =>
      item.action === 'minimize-window' && item.key === 'm' && item.modifiers === 2), 'shortcut is persisted');
    await click(menu, 'shell-shortcuts-close');
    desktop.activateWindow(app('a').id);
    await until(() => app('a').active, 'focus before configured shortcut');
    await key(CTRL, true); await tap(M); await key(CTRL, false);
    await until(() => app('a').minimized, 'configured global shortcut operates on a real window');
    const bindings = desktop.shortcuts();
    rejects(() => desktop.setShortcuts(bindings.map(item => item.action === 'close-window' ?
      { ...item, key: 'm', modifiers: 2 } : item)), 'conflicts reject the entire map');
    rejects(() => desktop.setShortcuts(bindings.map(item => item.action === 'close-window' ?
      { ...item, key: 'Escape', modifiers: 4 } : item)), 'reserved session exit cannot be reassigned');
    rejects(() => desktop.setShortcuts([null, ...bindings.slice(1)]), 'malformed entries are rejected');
    const malformed = [...bindings];
    malformed[0] = { get action() { throw new Error('getter probe'); } };
    rejects(() => desktop.setShortcuts(malformed), 'throwing property access is surfaced');
    const probe = desktop.spawnApplication([executable, '--desktop', script, 'denied'], '', 'shortcut-public');
    await until(() => exits.has(probe), 'public shortcut probe');
    check(exits.get(probe) === 0, 'shortcut controls are private to the Shell');
    desktop.activateWindow(app('a').id);
    await until(() => app('a').active, 'restore application');
    desktop.setShortcuts(bindings.map(item => item.action === 'switch-window' ?
      { ...item, key: 'grave', modifiers: 8 } : item));
    await key(125, true); await tap(41);
    await until(() => desktop.windowSwitcher().active, 'custom switcher trigger');
    await key(125, false);
    await until(() => !desktop.windowSwitcher().active, 'custom trigger modifier release');
    desktop.setShortcuts(bindings.map(item => item.action === 'minimize-window' ?
      { ...item, key: '', modifiers: 0 } : item));
    await key(CTRL, true); await tap(M); await key(CTRL, false);
    check(!app('a').minimized, 'disabled shortcut no longer performs the action');
    desktop.setShortcuts(desktop.shortcutDefaults());
    check(localStorage.getItem(SHORTCUTS_KEY).includes('"m"'), 'resetting compositor state does not erase saved preferences');
  } else {
    check(desktop.shortcuts().some(item => item.action === 'minimize-window' && item.key === 'm' && item.modifiers === 2),
      'new Shell reapplies saved shortcuts over compositor defaults');
    for (const item of desktop.windows().filter(item => item.appId.startsWith('org.pollyui.switch-'))) desktop.closeWindow(item.id);
    await until(() => !desktop.windows().some(item => item.appId.startsWith('org.pollyui.switch-')), 'fixture windows close');
  }
  check(reports.every(message => message.startsWith('[shell] Application exited: switch-')),
    'shortcut controller reports no failures other than intentional fixture exits');
  await signal('fixture-success');
  shell.stop(); window.quit();
}
run().catch(error => {
  console.error('FAIL: ' + String(error) + '\n' + (error.stack || ''));
  shell?.stop(); window.quit();
});
