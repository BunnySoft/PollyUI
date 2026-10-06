import { createDesktopShell } from './desktop/shell/shell.mjs';
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
async function until(predicate, message, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (predicate()) return; await delay(20); }
  throw new Error('Timed out: ' + message);
}
async function signal(title) {
  const marker = window.create({ title, layer: 'overlay', width: 1, height: 1,
    anchors: ['top', 'right'], exclusiveZone: -1 });
  await until(() => marker.closed, title);
}
const created = [];
let clickSerial = 0;
let shell;
function startShell() { return createDesktopShell({ host: {
  close: () => window.close(), displays: () => window.displays(),
  create(options) {
    const native = window.create(options);
    created.push({ title: options.title, window: native });
    return native;
  },
} }).start(); }
async function click(surface, id) {
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const node = surface.window.document.getElementById(id);
  check(node && node.offsetWidth > 0, id + ' is laid out');
  const rect = node.getBoundingClientRect();
  await signal(`fixture-click ${++clickSerial} ${Math.floor(rect.x + rect.width / 2)} ` +
    `${Math.floor(rect.y + rect.height / 2)} 0 ${surface.title}`);
}
async function confirmation() {
  await until(() => created.some(item => item.title.startsWith('PollyShell.display-confirmation.') && !item.window.closed),
    'native display confirmation');
  return created.find(item => item.title.startsWith('PollyShell.display-confirmation.') && !item.window.closed);
}
async function run() {
  if (mode === 'denied') {
    window.create({ title: 'Public display rejection', width: 100, height: 100 });
    rejects(() => desktop.outputConfiguration(), 'public clients cannot enumerate managed outputs');
    rejects(() => desktop.claimOutputStartup(), 'public clients cannot claim display startup restoration');
    rejects(() => desktop.applyOutputConfiguration({ serial: 0, heads: [] }), 'public clients cannot configure outputs');
    rejects(() => desktop.confirmOutputConfiguration(1), 'public clients cannot confirm display changes');
    window.quit(); return;
  }
  shell = startShell();
  await until(() => desktop.outputConfiguration().heads.length === 2, 'output discovery');
  const initial = desktop.outputConfiguration();
  check(initial.heads.every(head => head.enabled && head.width > 0 && head.height > 0 && head.scale > 0),
    'actual output state and modes are available');
  if (mode === 'reload') {
    await until(() => !desktop.outputConfiguration().pendingToken, 'rollback after Shell loss');
    check(desktop.outputConfiguration().heads.every(head => head.width === 1280 && head.height === 720 && head.scale === 1),
      'compositor restores displays after the applying Shell crashes');
    const config = desktop.outputConfiguration(), removed = config.heads[0];
    desktop.applyOutputConfiguration({ ...config, heads: config.heads.map(head =>
      head.id === removed.id ? { ...head, scale: 1.25 } : head) });
    await signal('fixture-output-remove ' + removed.name);
    await until(() => desktop.outputConfiguration().heads.length === 1 && !desktop.outputConfiguration().pendingToken,
      'output disconnection aborts and rolls back a provisional configuration');
    check(window.displays().length === 1 && desktop.outputConfiguration().heads[0].enabled,
      'rollback retains an enabled surviving display');
  } else {
    const target = initial.heads[0].id;
    const changed = { ...initial, heads: initial.heads.map(head => head.id === target ?
      { ...head, width: 800, height: 600, refresh: 60000, scale: 1.25, transform: 1, x: 30, y: 20 } : head) };
    check(desktop.testOutputConfiguration(changed), 'backend accepts supported configuration without applying');
    check(desktop.outputConfiguration().heads.find(head => head.id === target).width === 1280, 'test does not change the display');
    const token = desktop.applyOutputConfiguration(changed);
    check(token > 0 && desktop.outputConfiguration().pendingToken === token, 'applied output change requires confirmation');
    await until(() => window.displays().some(display => display.width === 480 && display.height === 640 &&
      display.x === 30 && display.y === 20),
      'SDL sees real mode, scale and rotation changes');
    rejects(() => desktop.applyOutputConfiguration(desktop.outputConfiguration()), 'another provisional change is rejected');
    desktop.revertOutputConfiguration(token);
    await until(() => desktop.outputConfiguration().heads.find(head => head.id === target).width === 1280,
      'explicit revert restores the previous mode');
    desktop.applyOutputConfiguration({ ...desktop.outputConfiguration(), heads: changed.heads });
    (await confirmation()).window.close();
    await until(() => !desktop.outputConfiguration().pendingToken, 'closing the confirmation surface reverts immediately');
    const menuWindow = shell.showDisplays(shell.getState().outputs[0]);
    const menu = created.find(item => item.window === menuWindow);
    await click(menu, 'shell-output-' + target + '-width');
    for (const code of [107, 14, 14, 14, 14, 2, 11, 3, 5]) {
      await signal('fixture-key ' + code + ' 1');
      await signal('fixture-key ' + code + ' 0');
    }
    await click(menu, 'shell-output-' + target + '-scale-up');
    await click(menu, 'shell-output-apply');
    await until(() => desktop.outputConfiguration().pendingToken > 0, 'native settings apply');
    await until(() => desktop.outputConfiguration().heads.find(head => head.id === target).width === 1024,
      'numeric display fields edit the actual output mode');
    await click(await confirmation(), 'shell-output-revert');
    await until(() => !desktop.outputConfiguration().pendingToken, 'native confirmation reverts changes');
    let config = desktop.outputConfiguration();
    const keep = desktop.applyOutputConfiguration({ ...config, heads: config.heads.map(head => head.id === target ?
      { ...head, x: 64, y: 32 } : head) });
    check(keep > 0, 'layout change has a confirmation token');
    await click(await confirmation(), 'shell-output-keep');
    await until(() => !desktop.outputConfiguration().pendingToken, 'confirmed layout has no rollback deadline');
    await until(() => desktop.outputConfiguration().heads.find(head => head.id === target).x === 64, 'confirmed position');
    rejects(() => desktop.applyOutputConfiguration(initial), 'stale output snapshots are rejected');
    config = desktop.outputConfiguration();
    rejects(() => desktop.applyOutputConfiguration({ ...config, heads: config.heads.map(head => ({ ...head, enabled: false })) }),
      'disabling the last display is rejected');
    config = desktop.outputConfiguration();
    const timeoutToken = desktop.applyOutputConfiguration({ ...config, heads: config.heads.map(head => head.id === target ?
      { ...head, width: 1024, height: 768, refresh: 60000 } : head) });
    check(timeoutToken > 0, 'unconfirmed mode change starts watchdog');
    await until(() => !desktop.outputConfiguration().pendingToken, 'compositor watchdog reverts unconfirmed settings', 22000);
    check(desktop.outputConfiguration().heads.find(head => head.id === target).width === 1280, 'watchdog restores previous resolution');
    config = desktop.outputConfiguration();
    const disable = desktop.applyOutputConfiguration({ ...config, heads: config.heads.map(head =>
      head.id === target ? { ...head, enabled: false } : head) });
    await until(() => window.displays().length === 1, 'disabled display is removed from the live session');
    desktop.revertOutputConfiguration(disable);
    await until(() => window.displays().length === 2, 'reverted display becomes available again');
    let probeExit = null;
    desktop.onExit = event => { if (event.id === 'display-public') probeExit = event.status; };
    desktop.spawnApplication([executable, '--desktop', script, 'denied'], '', 'display-public');
    await until(() => probeExit !== null, 'public display probe');
    check(probeExit === 0, 'managed outputs are private to the Shell connection');
    config = desktop.outputConfiguration();
    desktop.applyOutputConfiguration({ ...config, heads: config.heads.map(head => head.id === target ?
      { ...head, width: 800, height: 600, refresh: 60000, scale: 1 } : head) });
    await signal('fixture-output-crash');
    throw new Error('Crash injection did not terminate the fixture');
  }
  await signal('fixture-success');
  shell.stop(); window.quit();
}
run().catch(error => {
  console.error('FAIL: ' + String(error) + '\n' + (error.stack || ''));
  shell?.stop(); window.quit();
});
