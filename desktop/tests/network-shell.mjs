import { createDesktopShell } from './desktop/shell/shell.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(value, message) { if (!value) throw new Error(message); console.log('PASS: ' + message); }
async function until(predicate, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (predicate()) return; await delay(10); }
  throw new Error('Timed out: ' + message);
}
let shell, serial = 0;
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
  check(node?.offsetWidth > 0, 'native Wi-Fi control laid out: ' + id);
  const rect = node.getBoundingClientRect();
  await signal(`fixture-click ${++serial} ${Math.floor(rect.x + rect.width / 2)} ${Math.floor(rect.y + rect.height / 2)} 0 ${surface.title}`);
}
async function tap(code) { await signal(`fixture-key ${code} 1`); await signal(`fixture-key ${code} 0`); }
const state = () => desktop.networkState();
async function idle() { await until(() => state().ready && !state().operation && !state().refreshing, 'network operation completion'); }
async function run() {
  const [mode, executable, script] = application.arguments;
  if (mode === 'denied') {
    window.create({ title: 'Public network API denial', width: 100, height: 80 });
    let denied = false;
    try { desktop.startNetwork(); } catch { denied = true; }
    check(denied, 'public Wayland clients cannot register a Wi-Fi agent through Shell APIs');
    window.quit(); return;
  }
  desktop.onExit = event => exits.set(event.pid, event.status);
  shell = createDesktopShell({ report: value => { reports.push(value); console.error(value); }, host: {
    close: () => window.close(), displays: () => window.displays(),
    create(options) {
      const result = window.create(options);
      surfaces.push({ title: options.title, window: result }); return result;
    },
  } }).start();
  if (mode === 'initial') {
    const helper = executable.slice(0, executable.lastIndexOf('/')) + '/polly-iwd-test';
    const provider = desktop.spawnApplication([helper], '', 'iwd-fixture');
    shell.showNetwork(shell.getState().outputs[0]);
    await until(() => state().ready && state().registered && state().networks[0]?.signal === -45, 'iwd model and RSSI');
    check(state().networkConfiguration === true && state().devices[0].name === 'wlan-test', 'iwd built-in IP configuration and device state');
    let unrelated = false;
    try { desktop.networkAction(state().revision, '/not/an/iwd/device', 'scan'); } catch { unrelated = true; }
    check(unrelated, 'network commands cannot target arbitrary D-Bus object paths');
    const old = state();
    const denied = desktop.spawnApplication([executable, '--desktop', script, 'denied'], '', 'network-public');
    await until(() => exits.has(denied), 'public API rejection');
    check(exits.get(denied) === 0, 'network operations require the private Shell connection');
    const spoof = desktop.spawnApplication([helper, 'spoof'], '', 'network-agent-spoof');
    await until(() => exits.has(spoof), 'forged authentication request');
    check(exits.get(spoof) === 0, 'only the verified iwd owner can request credentials');
    await click('shell-network-scan-0'); await idle();
    await until(() => state().revision !== old.revision, 'scan refresh');
    let stale = false;
    try { desktop.networkAction(old.revision, old.devices[0].id, 'scan'); } catch { stale = true; }
    check(stale, 'stale device snapshots cannot mutate Wi-Fi state');
    await click('shell-network-connect-0-0');
    await click('shell-network-confirm');
    await until(() => state().authentication, 'first authentication prompt');
    const firstPrompt = state().authentication.id;
    await click('shell-network-auth-cancel'); await idle();
    await until(() => !state().authentication && !state().networks[0].connected, 'cancelled connection state');
    check(!state().networks[0].connected && !state().error, 'cancelling credentials aborts without connecting');
    await click('shell-network-connect-0-0'); await click('shell-network-confirm');
    await until(() => state().authentication, 'connection cancellation prompt');
    await click('shell-network-connect-cancel'); await idle();
    await until(() => !state().authentication && !state().networks[0].connected, 'explicit connection cancellation state');
    check(!state().networks[0].connected && !state().authentication, 'cancel connection requests disconnect and clears credential state');
    await click('shell-network-connect-0-0'); await click('shell-network-confirm');
    await until(() => state().authentication && state().authentication.id !== firstPrompt, 'new authentication token');
    let oldPrompt = false;
    try { desktop.replyNetworkAuthentication(firstPrompt, '', 'never-submitted'); } catch { oldPrompt = true; }
    check(oldPrompt, 'old authentication prompts cannot submit credentials');
    let invalidPassword = false;
    try { desktop.replyNetworkAuthentication(state().authentication.id, '', 'short'); } catch { invalidPassword = true; }
    check(invalidPassword && state().authentication !== null, 'invalid PSK input preserves the current authentication prompt');
    await click('shell-network-password');
    for (const key of [20, 18, 31, 20, 25, 30, 31, 31]) await tap(key);
    const networkWindow = surfaces.findLast(item => !item.window.closed && item.title.startsWith('PollyShell.network.')).window;
    check(networkWindow.document.getElementById('shell-network-password').textContent === '\u2022'.repeat(8),
      'Wi-Fi passphrase is masked in the actual native field');
    check(!JSON.stringify(state()).includes('testpass'), 'network snapshots never contain entered credentials');
    await click('shell-network-auth-submit');
    await until(() => state().ready && !state().operation && state().devices[0].state === 'connected', 'authenticated connection');
    check(state().networks[0].known && !state().authentication, 'successful iwd connection becomes known and clears prompt');
    await click('shell-network-disconnect-0'); await idle();
    await until(() => state().devices[0].state === 'disconnected', 'station disconnect');
    await click('shell-network-forget-0-0');
    await until(() => networkWindow.document.getElementById('shell-network-confirm'), 'forget confirmation dialog');
    check(state().networks[0].known, 'forgetting requires explicit confirmation before removing the profile');
    await click('shell-network-confirm'); await idle();
    await until(() => !state().networks[0].known, 'forget saved network');
    await click('shell-network-power-0'); await idle();
    await until(() => !state().devices[0].powered, 'radio power off');
    await click('shell-network-power-0'); await idle();
    await until(() => state().devices[0].powered, 'radio power on');
    const beforeLoss = state();
    const quit = desktop.spawnApplication([helper, 'quit'], '', 'iwd-fixture-stop');
    await until(() => exits.has(quit) && exits.has(provider), 'isolated iwd exits');
    check(exits.get(quit) === 0 && exits.get(provider) === 0, 'all iwd operations reached the isolated service');
    await until(() => !state().ready && state().error.includes('unavailable'), 'service disappearance invalidates network state');
    check(state().devices.length === 0 && !state().authentication, 'lost service clears devices and credential requests');
    const restarted = desktop.spawnApplication([helper, 'restart'], '', 'iwd-fixture-restart');
    await until(() => state().ready && state().registered && state().devices[0]?.name === 'wlan-test', 'new iwd owner is reverified');
    let staleOwner = false;
    try { desktop.networkAction(beforeLoss.revision, beforeLoss.devices[0].id, 'scan'); } catch { staleOwner = true; }
    check(staleOwner, 'restarted service cannot inherit an old network action');
    const stopAgain = desktop.spawnApplication([helper, 'quit'], '', 'iwd-fixture-stop-again');
    await until(() => exits.has(stopAgain) && exits.has(restarted), 'restarted service cleanup');
    check(exits.get(stopAgain) === 0 && exits.get(restarted) === 0, 'iwd reconnection does not leak service ownership');
  }
  check(reports.length === 0, 'Wi-Fi UI had no unexpected implementation errors');
  await signal('fixture-success');
  shell.stop(); window.quit();
}
run().catch(error => {
  console.error('FAIL: ' + String(error) + '\n' + (error.stack || ''));
  shell?.stop(); window.quit();
});
