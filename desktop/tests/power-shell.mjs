import { createDesktopShell } from './desktop/shell/shell.mjs';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const exits = new Map(), surfaces = [];
let serial = 0, shell;
function check(value, message) { if (!value) throw new Error(message); console.log('PASS: ' + message); }
async function until(predicate, message) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out: ' + message + ' ' + JSON.stringify(desktop.powerState()));
    await delay(10);
  }
}
async function marker(title) {
  const surface = window.create({ title, layer: 'overlay', width: 1, height: 1, anchors: ['top', 'right'], exclusiveZone: -1 });
  await until(() => surface.closed, title);
}
async function click(id) {
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const surface = surfaces.findLast(item => !item.window.closed && item.window.document.getElementById(id));
  const node = surface?.window.document.getElementById(id);
  check(node?.offsetWidth > 0, 'power control laid out: ' + id);
  const rect = node.getBoundingClientRect();
  await marker(`fixture-click ${++serial} ${Math.floor(rect.x + rect.width / 2)} ${Math.floor(rect.y + rect.height / 2)} 0 ${surface.title}`);
}
async function run() {
  const [mode, executable, script] = application.arguments;
  if (mode === 'public') {
    window.create({ title: 'Public power authority denial', width: 100, height: 80 });
    let denied = false;
    try { desktop.startPower(); } catch { denied = true; }
    check(denied, 'public application cannot acquire Shell power authority');
    window.quit(); return;
  }
  desktop.onExit = event => exits.set(event.pid, event.status);
  const helper = executable.slice(0, executable.lastIndexOf('/')) + '/polly-power-test';
  const service = desktop.spawnApplication([helper], '', 'fake-login-service');
  shell = createDesktopShell({ host: { close: () => window.close(), displays: () => window.displays(),
    create(options) { const native = window.create(options); surfaces.push({ title: options.title, window: native }); return native; } } }).start();
  const control = async (action, expected = 0) => {
    const pid = desktop.spawnApplication([helper, action, ...(action === 'count' ? [String(expected)] : [])], '', 'fake-power-' + action);
    await until(() => exits.has(pid), 'fixture command ' + action);
    check(exits.get(pid) === 0, 'fixture command ' + action);
    return exits.get(pid);
  };
  await delay(100);
  shell.showPower(shell.getState().outputs[0]);
  await until(() => desktop.powerState().ready && desktop.powerState().active, 'root-owned local session discovery');
  const state = desktop.powerState();
  let rejected = false;
  try { desktop.requestPower(state.revision, 'suspend'); } catch { rejected = true; }
  check(rejected, 'suspend is not a supported power action');
  await click('shell-power-reboot');
  check(await control('count') === 0, 'opening confirmation does not perform the action');
  await click('shell-power-cancel');
  check(await control('count') === 0, 'cancel leaves the system untouched');
  await click('shell-power-reboot');
  const beforeAction = desktop.powerState().revision;
  await click('shell-power-confirm');
  await until(() => desktop.powerState().revision > beforeAction && !desktop.powerState().operation, 'authorized reboot reply');
  check(await control('count', 1) === 0, 'confirmed action reaches only the isolated login provider');
  await control('inactive');
  desktop.stopPower(); desktop.startPower();
  await until(() => desktop.powerState().ready && !desktop.powerState().active, 'inactive session');
  rejected = false;
  try { desktop.requestPower(desktop.powerState().revision, 'poweroff'); } catch { rejected = true; }
  check(rejected, 'inactive session cannot request poweroff');
  await control('active'); await control('challenge');
  desktop.stopPower(); desktop.startPower();
  await until(() => desktop.powerState().ready && desktop.powerState().reboot === 'challenge', 'challenge permission');
  rejected = false;
  try { desktop.requestPower(desktop.powerState().revision, 'reboot'); } catch { rejected = true; }
  check(rejected, 'challenge authorization is not bypassed or treated as yes');
  const publicClient = desktop.spawnApplication([executable, '--desktop', script, 'public'], '', 'public-power-test');
  await until(() => exits.has(publicClient), 'public authority test');
  check(exits.get(publicClient) === 0, 'public power denial completed');
  await control('quit');
  await until(() => exits.has(service) && !desktop.powerState().ready, 'service loss invalidates authority');
  await marker('fixture-success');
  shell.stop(); window.quit();
}
run().catch(error => { console.error('FAIL: ' + String(error)); shell?.stop(); window.quit(); });
