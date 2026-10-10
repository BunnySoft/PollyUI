import { createDesktopShell } from './desktop/tests/configured-shell.mjs';
import { displayProfile } from './desktop/shell/display-profiles.mjs';
import { openShellConfiguration } from './desktop/shell/configuration-native.mjs';
import { checkDamagedConfiguration } from './desktop/tests/configuration-damage.mjs';
const stage = application.arguments[0];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let shell, serial = 0;
const created = [];
function check(value, message) { if (!value) throw new Error(message); console.log('PASS: ' + message); }
async function until(predicate, message, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out: ' + message); await delay(20); }
}
async function signal(title) {
  const marker = window.create({ title, layer: 'overlay', width: 1, height: 1, anchors: ['top', 'right'], exclusiveZone: -1 });
  await until(() => marker.closed, title);
}
function start() {
  return createDesktopShell({ host: {
    close: () => window.close(), displays: () => window.displays(),
    create(options) { const surface = window.create(options); created.push({ title: options.title, window: surface }); return surface; },
  } }).start();
}
async function keep() {
  await until(() => created.some(item => item.title.startsWith('PollyShell.display-confirmation.') && !item.window.closed),
    'visible startup confirmation');
  const surface = created.find(item => item.title.startsWith('PollyShell.display-confirmation.') && !item.window.closed);
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const button = surface.window.document.getElementById('shell-output-keep');
  const rect = button.getBoundingClientRect();
  await signal(`fixture-click ${++serial} ${Math.floor(rect.x + rect.width / 2)} ${Math.floor(rect.y + rect.height / 2)} 0 ${surface.title}`);
  await until(() => !desktop.outputConfiguration().pendingToken, 'confirmation applied');
}
async function run() {
  if (stage === 'damaged') {
    checkDamagedConfiguration();
    console.log('PASS: display persistence ' + stage);
    await signal('fixture-success'); window.quit(); return;
  }
  const preferences = openShellConfiguration();
  if (stage === 'mismatch') {
    const saved = JSON.parse(JSON.stringify(preferences.snapshot.display));
    saved.heads[0].serialNumber = 'different-monitor';
    preferences.update({ display: saved });
  }
  const original = JSON.stringify(preferences.snapshot.display);
  preferences.close();
  shell = start();
  const configuration = desktop.outputConfiguration();
  check(configuration.heads.every(head => head.make === 'Polly fixture' &&
    head.model === 'Virtual display' && head.serialNumber === (stage === 'unknown' ? '' : head.name)),
    'native snapshots expose the actual fixture identities, including absent serial numbers');
  if (stage === 'save') {
    const target = configuration.heads[0].id;
    desktop.applyOutputConfiguration({ ...configuration, heads: configuration.heads.map(head =>
      head.id === target ? { ...head, width: 1000, height: 700, refresh: 60000, scale: 1.25, transform: 1, x: 40 } : head) });
    check(shell.configuration.snapshot.display === null, 'provisional configuration is never persisted');
    await keep();
    const saved = shell.configuration.snapshot.display;
    check(saved.heads.some(head => head.width === 1000) && saved.heads.every(head => !('id' in head)),
      'Keep saves confirmed geometry and hardware identity, not runtime handles');
  } else if (stage === 'timeout' || stage === 'keep') {
    check(configuration.pendingToken && configuration.heads.some(head => head.width === 1000 && head.scale === 1.25),
      'fresh session auto-applies matching saved configuration provisionally');
    check(JSON.stringify(shell.configuration.snapshot.display) === original, 'startup restore does not rewrite preferences before confirmation');
    if (stage === 'timeout') {
      await until(() => !desktop.outputConfiguration().pendingToken, 'startup watchdog automatic rollback', 23000);
      check(desktop.outputConfiguration().heads.every(head => head.width === 1280 && head.scale === 1),
        'unconfirmed startup changes revert to safe defaults');
    } else await keep();
    const live = JSON.stringify(displayProfile(desktop.outputConfiguration()));
    shell.stop(); shell = start();
    check(!desktop.outputConfiguration().pendingToken &&
      JSON.stringify(displayProfile(desktop.outputConfiguration())) === live, 'Shell reconnect never retries startup restoration');
  } else {
    check(!configuration.pendingToken && configuration.heads.every(head => head.width === 1280 && head.scale === 1),
      'mismatched or damaged profile keeps safe display layout');
    check(JSON.stringify(shell.configuration.snapshot.display) === original, 'unusable saved profile remains untouched');
  }
  console.log('PASS: display persistence ' + stage);
  await signal('fixture-success');
  shell.stop(); window.quit();
}
run().catch(error => { console.error('FAIL: ' + String(error)); shell?.stop(); window.quit(); });
