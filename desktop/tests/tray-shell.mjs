import { createDesktopShell } from './desktop/shell/shell.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(value, message) { if (!value) throw new Error(message); console.log('PASS: ' + message); }
async function until(predicate, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (predicate()) return; await delay(10); }
  throw new Error('Timed out: ' + message);
}
let serial = 0, shell;
const surfaces = [], reports = [], exits = new Map();
async function signal(title) {
  const marker = window.create({ title, layer: 'overlay', width: 1, height: 1,
    anchors: ['top', 'right'], exclusiveZone: -1 });
  await until(() => marker.closed, title);
}
async function click(id, button = 0) {
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const surface = surfaces.findLast(item => !item.window.closed && item.window.document.getElementById(id));
  const node = surface?.window.document.getElementById(id);
  check(node?.offsetWidth > 0, 'native tray control is laid out');
  const rect = node.getBoundingClientRect();
  const x = Math.floor(rect.x + rect.width / 2), y = Math.floor(rect.y + rect.height / 2);
  if (!id.startsWith('shell-tray-menu-')) await signal(`fixture-tray-pixel ${x} ${y} ${surface.title}`);
  await signal(`fixture-click ${++serial} ${x} ${y} ${button} ${surface.title}`);
}
async function tap(key) {
  await signal(`fixture-key ${key} 1`); await signal(`fixture-key ${key} 0`);
}
async function run() {
  const [mode, executable, script] = application.arguments;
  if (mode === 'denied') {
    window.create({ title: 'Public tray API denial', width: 100, height: 80 });
    let denied = false;
    try { desktop.startTray(); } catch { denied = true; }
    check(denied, 'public Wayland application cannot acquire Shell tray APIs');
    window.quit(); return;
  }
  desktop.onExit = event => exits.set(event.pid, event.status);
  shell = createDesktopShell({ report: message => { reports.push(message); console.error(message); }, host: {
    close: () => window.close(), displays: () => window.displays(),
    create(options) {
      const native = window.create(options);
      surfaces.push({ title: options.title, window: native });
      return native;
    },
  } }).start();
  if (mode === 'initial') {
    const helper = executable.slice(0, executable.lastIndexOf('/')) + '/polly-tray-test';
    const publicClient = desktop.spawnApplication([executable, '--desktop', script, 'denied'], '', 'tray-public');
    await until(() => exits.has(publicClient), 'public watcher probe');
    check(exits.get(publicClient) === 0, 'tray APIs require the trusted Shell connection');
    const pid = desktop.spawnApplication([helper], '', 'tray-fixture');
    const item = title => desktop.trayItems().find(entry => entry.title === title);
    await until(() => item('Tray fixture')?.icon, 'asynchronous tray discovery');
    const initial = item('Tray fixture');
    check(initial.icon.startsWith('polly-memory:'), 'tray pixels are in-memory assets, not untrusted filesystem paths');
    const foreign = desktop.spawnApplication([helper, 'foreign'], '', 'tray-foreign');
    await until(() => exits.has(foreign), 'foreign registration probe');
    check(exits.get(foreign) === 0, 'tray registration verifies actual sender ownership');
    await click('shell-tray-' + initial.id);
    await until(() => item('Tray activated')?.status === 'Passive', 'activation updates item properties');
    check(!surfaces.some(surface => !surface.window.closed &&
      surface.window.document.getElementById('shell-tray-' + initial.id)), 'passive items are hidden from the native panel');
    let stale = false;
    try { desktop.trayAction(initial.id, initial.revision, 'activate', 0, 0); } catch { stale = true; }
    check(stale, 'stale tray snapshots cannot dispatch actions');
    await until(() => item('Tray activated')?.status === 'Active', 'active status restores the tray representation');
    await click('shell-tray-' + initial.id, 1);
    await until(() => item('Tray secondary'), 'middle-button secondary activation');
    const current = item('Tray secondary');
    desktop.trayScroll(current.id, current.revision, -120, false);
    await until(() => item('Tray scrolled')?.status === 'NeedsAttention', 'scroll and attention status');
    await click('shell-tray-' + initial.id, 2);
    await until(() => exits.has(pid), 'tray provider completes');
    check(exits.get(pid) === 0, 'provider received all native tray actions');
    await until(() => desktop.trayItems().length === 0, 'disconnected provider is unregistered');
    const hung = desktop.spawnApplication([helper, 'hang'], '', 'tray-hung');
    await until(() => desktop.trayItems().some(entry => entry.error.includes('timed out')), 'unresponsive provider produces explicit error');
    await until(() => exits.has(hung) && desktop.trayItems().length === 0, 'unresponsive provider cleanup');
    check(exits.get(hung) === 0, 'hung provider cannot block the desktop event loop');
    const menuPid = desktop.spawnApplication([helper, 'menu'], '', 'tray-menu-fixture');
    await until(() => item('Menu fixture')?.menu, 'exported DBusMenu');
    const menuItem = item('Menu fixture');
    await click('shell-tray-' + menuItem.id);
    await until(() => !desktop.trayMenu().pending && desktop.trayMenu().items.length === 4, 'native menu layout');
    await tap(108);
    const menuWindow = surfaces.findLast(surface => !surface.window.closed && surface.title.startsWith('PollyShell.tray-menu.')).window;
    check(menuWindow.document.activeElement?.id === 'shell-tray-menu-item-1', 'arrow keys navigate enabled native menu entries');
    await tap(1);
    await until(() => desktop.trayMenu().itemId === 0, 'Escape closes the application menu');
    await click('shell-tray-' + menuItem.id);
    await until(() => !desktop.trayMenu().pending && desktop.trayMenu().items.length === 4, 'menu reopens after keyboard dismissal');
    const root = desktop.trayMenu();
    check(!root.items.some(item => item.id === 5) && root.items.find(item => item.id === 4).separator &&
      root.items.find(item => item.id === 1).toggleState === 1, 'hidden entries, separators and toggle states');
    let disabled = false;
    try { desktop.invokeTrayMenu(menuItem.id, root.revision, 2); } catch { disabled = true; }
    check(disabled, 'disabled menu entries cannot be invoked');
    await click('shell-tray-menu-item-3');
    await until(() => desktop.trayMenu().root === 3 && !desktop.trayMenu().pending, 'lazy submenu');
    let oldMenu = false;
    try { desktop.invokeTrayMenu(menuItem.id, root.revision, 1); } catch { oldMenu = true; }
    check(oldMenu, 'stale menus cannot trigger application commands');
    const before = desktop.trayMenu().revision;
    desktop.trayScroll(menuItem.id, menuItem.revision, -120, false);
    await until(() => desktop.trayMenu().revision !== before && desktop.trayMenu().items.some(item => item.label === '_Finish'),
      'live exported menu updates');
    await click('shell-tray-menu-item-6');
    await until(() => exits.has(menuPid) && desktop.trayItems().length === 0, 'menu event delivery and owner cleanup');
    check(exits.get(menuPid) === 0, 'native submenu sends the exact DBusMenu clicked event');
  } else check(desktop.trayItems().length === 0, 'restarted Shell reacquires watcher names');
  check(reports.every(message => message === '[shell] Tray item: Tray item properties request failed or timed out'),
    'only the deliberately unresponsive tray item reports an error');
  await signal('fixture-success');
  shell.stop(); window.quit();
}
run().catch(error => {
  console.error('FAIL: ' + String(error) + '\n' + (error.stack || ''));
  shell?.stop(); window.quit();
});
