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
async function click(id) {
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const surface = surfaces.findLast(item => !item.window.closed && item.window.document.getElementById(id));
  const node = surface?.window.document.getElementById(id);
  check(node?.offsetWidth > 0, 'native notification control laid out: ' + id);
  const rect = node.getBoundingClientRect();
  await signal(`fixture-click ${++serial} ${Math.floor(rect.x + rect.width / 2)} ${Math.floor(rect.y + rect.height / 2)} 0 ${surface.title}`);
}
async function run() {
  const [mode, executable, script] = application.arguments;
  if (mode === 'denied') {
    window.create({ title: 'Public notification API denial', width: 100, height: 80 });
    let denied = false;
    try { desktop.startNotifications(); } catch { denied = true; }
    check(denied, 'public Wayland clients cannot claim the notification server through desktop APIs');
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
    check(desktop.notificationsAvailable, 'private notification bus is advertised');
    const helper = executable.slice(0, executable.lastIndexOf('/')) + '/polly-notification-test';
    const publicClient = desktop.spawnApplication([executable, '--desktop', script, 'denied'], '', 'notification-public');
    await until(() => exits.has(publicClient), 'public server probe');
    check(exits.get(publicClient) === 0, 'public application cannot acquire Shell notification privileges');
    const pid = desktop.spawnApplication([helper], '', 'notification-protocol-fixture');
    const notice = summary => desktop.notifications().find(item => item.summary === summary);
    await until(() => notice('Stage one'), 'first notification');
    const original = notice('Stage one');
    check(original.body === '<b>literal text</b> \u4f60', 'notification content remains literal text');
    await until(() => surfaces.some(item => !item.window.closed &&
      item.window.document.getElementById('shell-notification-action-' + original.id + '-0')), 'toast surface');
    const toast = surfaces.findLast(item => !item.window.closed &&
      item.window.document.getElementById('shell-notification-' + original.id));
    check(toast.window.document.getElementById('shell-notification-' + original.id).textContent.includes('<b>literal text</b>'),
      'native toast displays markup literally instead of interpreting it');
    let unknown = false;
    try { desktop.invokeNotificationAction(original.id, original.revision, 'not-offered'); } catch { unknown = true; }
    check(unknown, 'unknown action keys cannot be invoked');
    await click('shell-notification-action-' + original.id + '-0');
    await until(() => notice('Stage two'), 'resident notification replacement');
    const replacement = notice('Stage two');
    check(replacement.id === original.id && replacement.revision !== original.revision, 'replacement preserves ID and advances revision');
    let stale = false;
    try { desktop.dismissNotification(original.id, original.revision); } catch { stale = true; }
    check(stale, 'stale notification UI cannot close a replacement');
    const intruder = desktop.spawnApplication([helper, String(original.id)], '', 'notification-intruder');
    await until(() => exits.has(intruder), 'foreign sender probe');
    check(exits.get(intruder) === 0, 'another sender cannot replace or close this notification');
    await click('shell-notification-action-' + original.id + '-0');
    await until(() => notice('Dismiss'), 'protocol expiry and application-close tests');
    const dismissed = notice('Dismiss');
    await click('shell-notifications');
    await until(() => surfaces.some(item => !item.window.closed &&
      item.window.document.getElementById('shell-notification-center')), 'notification center opens');
    await click('shell-notification-close-' + dismissed.id);
    await until(() => exits.has(pid), 'notification protocol fixture completes');
    check(exits.get(pid) === 0, 'notification protocol and quota checks passed');
    await until(() => notice('Source exited'), 'notification survives sender exit');
    const remaining = notice('Source exited');
    await click('shell-notification-close-' + remaining.id);
    await until(() => desktop.notifications().length === 0, 'all notifications dismissed');
  } else check(desktop.notifications().length === 0, 'new Shell reacquires bus name with no stale notification state');
  check(reports.length === 0, 'notification Shell has no service errors');
  await signal('fixture-success');
  shell.stop(); window.quit();
}
run().catch(error => {
  console.error('FAIL: ' + String(error) + '\n' + (error.stack || ''));
  shell?.stop(); window.quit();
});
