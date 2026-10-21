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
    if (Date.now() > deadline) throw new Error('3D preview deadline: ' + message);
    await delay(10);
  }
}
if (mode === 'app') {
  check(Object.keys(desktop).length === 1 && desktop.fileSystem, '3D source app has no management authority');
  const suffix = executable;
  const source = window.create({ title: 'Projection.Source.' + suffix, width: 240, height: 160 });
  source.document.body.style.backgroundColor = { a: '#ff0000', b: '#00ff00', c: '#0000ff' }[suffix];
  let phase = 0;
  const timer = suffix === 'a' ? setInterval(() => {
    source.document.body.style.backgroundColor = ++phase % 2 ? '#ff00ff' : '#ff0000';
  }, 500) : null;
  source.onclose = () => { if (timer !== null) clearInterval(timer); window.quit(); };
  window.close();
} else {
  run().catch(error => {
    console.error('FAIL: ' + error + '\n' + error.stack);
    shell?.stop(); window.quit();
  });
}

async function run() {
  const created = [], reports = [];
  const settings = createSettingsFixtureClient(signal);
  let settingsClosed = false;
  shell = createDesktopShell({ report: message => { reports.push(message); console.error('PROJECTION_REPORT: ' + message); },
    settingsFactory: settings.factory,
    host: { close: () => window.close(), displays: () => window.displays(), create(options) {
      const owner = window.create(options);
      created.push({ title: options.title, window: owner });
      return owner;
    } },
  }).start();
  check(desktop.windowProjectionCapability() === true, 'paired GLES session advertises real native 3D projection');
  if (mode === 'initial') {
    await shell.showSystemSettings(shell.getState().outputs[0]);
    await settings.click('settings-switcher-flip3d');
    await until(() => shell.configuration.snapshot.theme.switcherStyle === 'flip3d',
      'actual Settings control saves Flip 3D');
    check((await settings.query({ op: 'state' })).appearance.switcher.projectionAvailable,
      'independent Settings reports the actual GLES projection capability');
    await settings.click('settings-switcher-still');
    await until(() => shell.configuration.snapshot.theme.switcherMotion === false, 'actual Settings control saves still 3D poses');
    await settings.click('settings-switcher-animate');
    await until(() => shell.configuration.snapshot.theme.switcherMotion === true, 'actual Settings control restores bounded 3D transitions');
    await settings.close(); settingsClosed = true;
  } else {
    check(shell.configuration.snapshot.theme.switcherStyle === 'flip3d', '3D style survives a new Shell PID');
    check(shell.configuration.snapshot.theme.switcherMotion === false, 'still 3D policy survives a new Shell PID');
  }
  async function signal(title) {
    const marker = window.create({ title, layer: 'overlay', width: 1, height: 1,
      anchors: ['top', 'right'], exclusiveZone: -1 });
    await until(() => marker.closed, title);
  }
  async function key(code, down) { await signal('fixture-key ' + code + ' ' + (down ? 1 : 0)); }
  async function tap(code) { await key(code, true); await key(code, false); }
  const view = suffix => desktop.windows().find(item =>
    item.appId === 'org.pollyui.projection-' + suffix && item.title === 'Projection.Source.' + suffix);
  const selector = () => created.findLast(item => item.title.startsWith('PollyShell.switcher.') && !item.window.closed);
  const ready = () => desktop.windowSwitcher().active && desktop.windowSwitcher().previewConfigured &&
    desktop.windowSwitcher().previewProjection && desktop.windowSwitcher().previewMask === 1;
  async function begin() { await key(56, true); await tap(15); await until(ready, 'native 3D viewport acknowledged'); }
  async function clickFront() {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const current = selector();
    const node = current.window.document.getElementById('shell-switcher-3d-viewport');
    const box = node.getBoundingClientRect(), snapshot = desktop.windowSwitcher();
    const x = Math.floor(box.width / 2), y = Math.floor(box.height / 2);
    check(desktop.pickWindowProjection(snapshot.serial, x, y) === snapshot.selected,
      'native depth hit test identifies the visible front window, not a rectangular guess');
    await signal('fixture-click 999 ' + Math.floor(box.x + x) + ' ' + Math.floor(box.y + y) + ' 0 ' + current.title);
  }
  for (const suffix of mode === 'initial' ? ['a', 'b', 'c'] : ['b']) {
    console.log('PROJECTION_SPAWN=' + JSON.stringify({ executable, script, suffix }));
    desktop.spawnApplication([executable, '--app-id', 'org.pollyui.projection-' + suffix, script, 'app', suffix], '', 'projection-' + suffix);
    await until(() => view(suffix)?.active && desktop.windows().filter(item =>
      item.appId === 'org.pollyui.projection-' + suffix).length === 1, 'exact source ' + suffix + ' mapped');
  }
  const original = desktop.windows().find(item => item.active)?.id;
  await begin();
  if (mode === 'initial') {
    await signal('fixture-projection-ready 00ff00');
    await signal('fixture-projection-stack');
    const forward = desktop.windowSwitcher().selected;
    await key(42, true); await tap(15); await key(42, false);
    await until(() => ready() && desktop.windowSwitcher().selected === (forward + 2) % 3,
      'Shift reverses the native 3D selection without releasing Alt');
    await signal('fixture-projection-ready 0000ff');
    await tap(15);
    await until(() => ready() && desktop.windowSwitcher().selected === forward,
      'forward 3D cycling returns to the original selected card');
    await signal('fixture-projection-ready 00ff00');
    const initial = desktop.windowSwitcher(), owner = selector().window;
    for (const viewport of [[0, 0, 4096, 768], [0, 0, 0, 1]]) {
      const before = desktop.windowSwitcher();
      let rejected = false;
      try { desktop.configureWindowProjection(before.serial, owner, viewport, 0xf3f3f3, true); }
      catch { rejected = true; }
      check(rejected && desktop.windowSwitcher().previewRequest === before.previewRequest,
        'invalid 3D viewport preserves the committed native stack');
    }
    const selected = desktop.windowSwitcher().selected;
    await tap(15);
    await until(() => ready() && desktop.windowSwitcher().selected === (selected + 1) % 3, 'native cycling advances selection');
    await signal('fixture-projection-ready ff0000');
    await signal('fixture-projection-ready ff00ff');
    check(desktop.windows().find(item => item.active)?.id === original, '3D browsing leaves original application focus unchanged');
    await tap(1); await key(56, false);
    await until(() => !desktop.windowSwitcher().active, 'Escape closes native 3D resources');
    await signal('fixture-previews-closed');
    check(desktop.windows().find(item => item.active)?.id === original, '3D cancellation preserves original focus');
    let stale = false;
    try { desktop.pickWindowProjection(initial.serial, 10, 10); } catch { stale = true; }
    check(stale, 'retired 3D selectors cannot replay hit-test authority');
    desktop.minimizeWindow(view('b').id);
    await until(() => view('b')?.minimized, 'source minimized before 3D selection');
    await begin();
    await signal('fixture-projection-ready 00ff00');
    const serial = desktop.windowSwitcher().serial;
    desktop.closeWindow(view('a').id);
    await until(() => ready() && desktop.windowSwitcher().serial !== serial &&
      desktop.windowSwitcher().items.length === 2, 'source closure rebuilds the native 3D candidate set');
    await delay(250);
    await signal('fixture-projection-idle');
    await signal('fixture-projection-transition');
    await until(ready, 'bounded native transition completed');
    await signal('fixture-projection-idle');
    await tap(15);
    await until(() => ready() && desktop.windowSwitcher().items[desktop.windowSwitcher().selected].appId ===
      'org.pollyui.projection-b', 'minimized target becomes the front card again');
    await signal('fixture-projection-ready 00ff00');
    await clickFront(); await key(56, false);
    await until(() => !desktop.windowSwitcher().active && view('b')?.active && !view('b')?.minimized,
      'one native 3D card click restores and activates the minimized source');
    await signal('fixture-previews-closed');
    await begin();
    await signal('fixture-desktop-lock-long');
    await until(() => !desktop.windowSwitcher().active, 'real session lock cancels the 3D selector');
    await signal('fixture-previews-closed');
    await key(56, false);
    await signal('fixture-desktop-unlocked');
    check(shell.setSwitcherMotion(false), 'still 3D poses are saved');
  } else {
    await signal('fixture-projection-ready 00ff00');
    await clickFront(); await key(56, false);
    await until(() => !desktop.windowSwitcher().active && view('b')?.active, 'native 3D pointer acceptance after Shell restart');
    await signal('fixture-previews-closed');
  }
  for (const item of desktop.windows().filter(item => item.appId.startsWith('org.pollyui.projection-')))
    desktop.closeWindow(item.id);
  await until(() => !desktop.windows().some(item => item.appId.startsWith('org.pollyui.projection-')), '3D source apps close');
  check(reports.every(message => message.startsWith('[shell] Application exited: projection-')),
    'native 3D lifecycle has no unexpected diagnostics');
  if (!settingsClosed) await settings.close();
  console.log('PASS: native Flip 3D ' + mode + ' complete');
  await signal('fixture-success'); shell.stop(); window.quit();
}
