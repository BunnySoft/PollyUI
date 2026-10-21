import { createDesktopShell } from './desktop/tests/configured-shell.mjs';
import { createSettingsFixtureClient } from './desktop/tests/settings-probe.mjs';

const [mode, executable, script] = application.arguments;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let shell;
function check(value, message) {
  if (!value) throw new Error(message);
  console.log('PASS: ' + message);
}
async function until(predicate, message) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Companion deadline: ' + message);
    await delay(10);
  }
}
if (mode === 'app') {
  check(Object.keys(desktop).length === 1, 'companion underlying app has no privileged connection');
  const source = window.create({ title: 'Companion.Source', width: 400, height: 300 });
  source.document.body.style.backgroundColor = '#345678';
  source.onclose = () => window.quit();
  window.close();
} else run().catch(error => {
  console.error('FAIL: ' + error + '\n' + error.stack);
  shell?.stop(); window.quit();
});

async function run() {
  const reports = [];
  async function signal(title) {
    const marker = window.create({ title, layer: 'overlay', width: 1, height: 1,
      anchors: ['top', 'right'], exclusiveZone: -1 });
    await until(() => marker.closed, title);
  }
  const settings = createSettingsFixtureClient(signal);
  shell = createDesktopShell({ settingsFactory: settings.factory, report: message => {
    reports.push(message); console.error('COMPANION_REPORT: ' + message);
  } }).start();
  const actor = () => shell.getCompanionSurface();
  if (mode === 'initial') {
    check(!actor(), 'default desktop creates no companion overlay or timers');
    await shell.showSystemSettings(shell.getState().outputs[0]);
    await settings.click('settings-companion-on');
    await until(() => actor()?.ready && actor()?.active, 'real Settings control enables the original sprite');
    check((await settings.query({ op: 'state' })).appearance.companion.available,
      'independent Settings displays the real overlay/input capability');
    await settings.click('settings-companion-reduced');
    await until(() => shell.configuration.snapshot.theme.companion.reducedMotion && actor()?.ready && actor()?.active,
      'actual Settings control enables reduced companion motion');
    await settings.click('settings-companion-animate');
    await until(() => !shell.configuration.snapshot.theme.companion.reducedMotion && actor()?.ready && actor()?.active,
      'actual Settings control restores finite companion actions');
    await settings.close();
  } else {
    check(shell.configuration.snapshot.theme.companion.enabled, 'companion preference survives a new Shell PID');
    check(shell.configuration.snapshot.theme.companion.reducedMotion, 'reduced companion motion survives a new Shell PID');
    await settings.close();
    await until(() => actor()?.ready && actor()?.active, 'saved original companion is decoded and active');
  }
  const app = () => desktop.windows().find(item => item.appId === 'org.pollyui.companion-source' && item.title === 'Companion.Source');
  desktop.spawnApplication([executable, '--app-id', 'org.pollyui.companion-source', script, 'app'], '', 'companion-source');
  await until(() => app()?.active, 'ordinary underlying source mapped');
  desktop.fullscreenWindow(app().id);
  await until(() => app()?.fullscreen, 'ordinary app fills the output behind the transparent overlay');
  const focus = app().id;
  const target = () => 'PollyShell.companion.' + actor().output;
  async function pointer(action, x, y) {
    await signal('fixture-desktop-pointer ' + action + ' ' + Math.floor(x) + ' ' + Math.floor(y) + ' ' + target());
  }
  async function pixels() {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await signal('fixture-companion-pixels ' + actor().position.x + ' ' + actor().position.y);
  }
  await pixels();
  await signal('fixture-companion-through ' + (actor().position.x + 2) + ' ' + (actor().position.y + 2));
  check(app().id === focus && app().active, 'transparent companion corner preserves underlying application focus');
  const nativeWindow = actor().window;
  let rejected = false;
  try { desktop.setOverlayInput(nativeWindow, [[0, 0, 99999, 1]]); } catch { rejected = true; }
  check(rejected, 'out-of-bounds input updates fail before changing the valid input mask');
  await pixels();
  if (mode === 'initial') {
    const before = actor().paints;
    await pointer('click', actor().position.x + 60, actor().position.y + 60);
    await until(() => actor()?.talking, 'one actual sprite click opens the tip without keyboard focus');
    await until(() => actor()?.action === 'idle' && !actor().animation.stats.pending, 'finite wave action stops scheduling');
    check(actor().paints > before + 2, 'real sprite atlas frames animated');
    check(app().active, 'visible companion interactions never steal keyboard focus');
    await pointer('right', actor().position.x + 60, actor().position.y + 60);
    await until(() => !actor().talking, 'right click closes the input-bounded tip');
    const original = { ...actor().position };
    await pointer('down', original.x + 60, original.y + 60);
    await pointer('move', original.x - 100, original.y - 100);
    await pointer('up', original.x - 100, original.y - 100);
    check(actor().position.x < original.x && actor().position.y < original.y,
      'actual captured drag moves the sprite within its own output');
    await pixels();
    const cancelled = { ...actor().position };
    await pointer('down', cancelled.x + 60, cancelled.y + 60);
    await until(() => actor().drag !== null, 'second actual drag acquired capture');
    await pointer('move', cancelled.x - 80, cancelled.y - 80);
    console.log('COMPANION_DRAG=' + JSON.stringify({ cancelled, position: actor().position, drag: actor().drag }));
    await signal('fixture-desktop-lock-long');
    await until(() => !actor()?.active && !actor()?.drag && !actor()?.animation.stats.pending,
      'real lock cancels capture, restores the drag origin and stops animation');
    check(actor().position.x === cancelled.x && actor().position.y === cancelled.y, 'cancelled drag restores its position');
    await signal('fixture-desktop-unlocked');
    await until(() => actor()?.active, 'explicit unlock restores activity without replaying the old gesture');
    check(shell.setCompanion({ enabled: true, reducedMotion: true }), 'reduced motion is saved');
    await until(() => actor()?.ready && actor()?.active, 'reduced-motion sprite recreated');
    const still = actor().paints;
    await delay(200);
    check(actor().paints === still && !actor().animation.stats.pending, 'idle reduced-motion sprite has no recurring paint');
    desktop.closeWindow(app().id);
    await until(() => !app(), 'underlying source closes before output removal');
    const previous = actor();
    await signal('fixture-companion-remove-output');
    await until(() => actor()?.ready && actor()?.active && actor() !== previous,
      'output removal recreates the original sprite on the surviving output');
    check(previous.window.closed && previous.animation.stats.disposed && previous.watch === null,
      'retired-output companion releases its window, watch and animation');
    check(actor().position.x >= 0 && actor().position.x + 96 <= actor().window.state.width &&
      actor().position.y >= 0 && actor().position.y + 96 <= actor().window.state.height,
    'surviving-output placement is bounded to its actual logical geometry');
    await until(() => !shell.getState().materialError &&
      shell.getSurfaces().filter(surface => surface.kind === 'panel').every(surface => surface.backdropActive),
    'existing taskbar material recovers after output recreation');
    await pixels();
  } else {
    const held = actor(), still = held.paints;
    await pointer('click', held.position.x + 60, held.position.y + 60);
    await until(() => actor().talking, 'still companion remains interactive');
    await delay(200);
    check(!actor().animation.stats.pending && actor().paints === still, 'reduced-motion click does not start an animation');
    const button = held.window.document.getElementById('shell-companion-hide').getBoundingClientRect();
    await pointer('click', button.x + button.width / 2, button.y + button.height / 2);
    await until(() => !actor() && shell.configuration.snapshot.theme.companion.enabled === false,
      'real Hide control persists disabled preference');
    check(held.animation.stats.disposed && !held.animation.stats.pending &&
      held.canvas.width === 0 && held.watch === null, 'hiding releases sprite pixels, native watch and timers');
    await signal('fixture-companion-closed');
  }
  if (app()) desktop.closeWindow(app().id);
  await until(() => !app(), 'ordinary underlying source closes independently');
  const unexpected = reports.filter(message => !message.startsWith('[shell] Application exited: companion-source'));
  check(unexpected.length <= (mode === 'initial' ? 1 : 0) &&
    unexpected.every(message => message === '[shell] Shell taskbar backdrop retired; solid material required'),
    'companion has no unexpected Shell diagnostics');
  console.log('PASS: native desktop companion ' + mode + ' complete');
  await signal('fixture-success'); shell.stop(); window.quit();
}
