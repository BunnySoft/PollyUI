import { createDesktopShell } from './desktop/shell/shell.mjs';
import { defaultShellConfiguration } from './desktop/shell/configuration.mjs';
import { memoryConfiguration } from './desktop/tests/configuration-memory.mjs';
import { BUILTIN_THEME_CATALOG, installThemeCatalog } from './desktop/shared/ui/themes.mjs';
import { encodeDecorationLayout } from './desktop/shared/ui/caption-layout.mjs';
import { runtimeBuild } from './desktop/client/settings-contract.mjs';

const [mode] = application.arguments;
if (mode === 'guard-retire') {
  const dock = window.create({ title: 'Backdrop.guard.Dock', layer: 'top', width: 96, height: 64,
    anchors: ['bottom'], exclusiveZone: 64, transparent: true });
  dock.document.body.style.backgroundColor = '#314159';
  for (const name of ['control', 'first', 'second']) {
    const view = window.create({ title: 'Backdrop.guard.' + name, width: 160, height: 80 });
    view.document.body.style.backgroundColor = '#234567';
  }
  const ready = window.create({ title: 'Backdrop.guard.ready', layer: 'overlay', width: 1, height: 1,
    anchors: ['top', 'right'], exclusiveZone: -1 });
  ready.onclose = () => dock.close();
  window.close();
} else if (['modern', 'modern-old', 'modern-standard', 'modern-v8'].includes(mode)) {
  modern().catch(failure => {
    console.error('FAIL: ' + String(failure) + '\n' + failure.stack);
    window.quit();
  });
} else {
const configuration = memoryConfiguration({ ...defaultShellConfiguration(),
  theme: { id: 'bigsur', filesEnabled: false } });
const shell = createDesktopShell({ configuration }).start();
const control = window.create({ title: 'Backdrop.fixture.control', width: 160, height: 64 });
control.document.body.style.backgroundColor = '#314159';
control.document.body.tabIndex = 0;
control.document.body.focus();
let phase = 0;
control.document.body.addEventListener('keydown', event => {
  if (event.key !== ' ' || event.repeat) return;
  event.preventDefault();
  if (phase === 0) {
    const surfaces = shell.getSurfaces(), dock = surfaces.find(surface => surface.kind === 'dock');
    const panel = surfaces.find(surface => surface.kind === 'panel');
    const theme = BUILTIN_THEME_CATALOG.themes.find(theme => theme.id === 'bigsur');
    const material = [2, 1, 16000, 8, 0xe7e7e7, 28];
    for (const during of ['target-getter', 'theme-toJSON']) {
      const candidate = window.create({ title: 'Backdrop.fixture.candidate', layer: 'top', width: 96, height: 64,
        anchors: ['bottom'], exclusiveZone: 0, transparent: true });
      const next = [dock.window, material];
      if (during === 'target-getter') Object.defineProperty(next, 0, {
        get() { candidate.close(); return dock.window; },
      });
      const snapshot = during === 'theme-toJSON' ?
        { ...theme, toJSON() { candidate.close(); return theme; } } : theme;
      let rejected = false;
      try {
        desktop.configureAppearance(snapshot, encodeDecorationLayout(theme),
          during === 'target-getter' ? [[candidate, material], next] : [[candidate, material]]);
      } catch (error) {
        if (error.name !== 'TypeError' || !String(error).includes('Window is closed')) throw error;
        rejected = true;
        console.log('EXPECTED_BACKDROP_LIFETIME_REJECTION ' + during + ': ' + String(error));
      } finally { if (!candidate.closed) candidate.close(); }
      if (!rejected || dock.window.closed)
        throw new Error('Retired candidate must be rejected before marshaling a stale native surface');
    }
    for (const targets of [[[panel.window, material]], [[control, material]],
      [[dock.window, [1, 1, 16000, 8, 0xe7e7e7, 28]]],
      [[dock.window, [2, 1, 64000, 8, 0xe7e7e7, 28]]],
      [[dock.window, [2, 1, 16000, 33, 0xe7e7e7, 28]]],
      [[dock.window, material], [dock.window, material]]]) {
      let rejected = false;
      try { desktop.configureAppearance(theme, encodeDecorationLayout(theme), targets); }
      catch (error) { rejected = true; console.log('EXPECTED_BACKDROP_REJECTION ' + String(error)); }
      if (!rejected || surfaces.some(surface => surface.window.closed))
        throw new Error('Invalid target/material transaction altered committed Shell resources');
    }
    control.document.body.style.backgroundColor = '#112233';
  } else if (phase === 1) {
    const legacy = JSON.parse(JSON.stringify(BUILTIN_THEME_CATALOG));
    delete legacy.themes.find(theme => theme.id === 'bigsur').panel.regionalBackdrop;
    installThemeCatalog(legacy);
    if (!shell.selectTheme('bigsur')) throw new Error(shell.getState().error);
    control.document.body.style.backgroundColor = '#271828';
  } else if (phase === 2) {
    installThemeCatalog(BUILTIN_THEME_CATALOG);
    if (!shell.selectTheme('bigsur')) throw new Error(shell.getState().error);
    control.document.body.style.backgroundColor = '#161803';
  } else {
    shell.stop();
    window.quit();
  }
  phase++;
});
control.onclose = () => { shell.stop(); window.quit(); };
window.close();
}

async function modern() {
  const standard = mode === 'modern-standard', oldV8 = mode === 'modern-v8';
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const check = (value, message) => {
    if (!value) throw new Error(message);
    console.log('PASS: ' + message);
  };
  async function until(predicate, message) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await delay(10);
    }
    throw new Error('Timed out: ' + message);
  }
  const created = [];
  if (standard || oldV8) {
    const build = runtimeBuild();
    check(/^[0-9a-f]{40}$/.test(build.revision) && build.sourceDirty === false,
      'fresh GUI embeds a clean actual source revision');
    console.log('STANDARD_START_GUI ' + JSON.stringify(build));
  }
  const host = {
    close: () => window.close(), displays: () => window.displays(),
    create(options) {
      const surface = window.create(options);
      created.push({ window: surface, options });
      return surface;
    },
  };
  const configuration = memoryConfiguration({ ...defaultShellConfiguration(),
    theme: { id: mode === 'modern-old' ? 'xp' : 'modern', filesEnabled: false } });
  const shell = createDesktopShell({ configuration, host }).start();
  const outputs = window.displays();
  if (standard) {
    outputs.sort((a, b) => a.height - b.height);
    check(outputs.length === 2 && outputs[0].width === 1280 && outputs[0].height === 720 &&
      outputs[1].width === 1280 && outputs[1].height === 800, 'two real output identities are exactly 1280x720 and 1280x800');
  }
  const currentMenu = () => created.findLast(surface =>
    surface.options.title.startsWith('PollyShell.menu.') && !surface.window.closed);
  async function signal(name) {
    const marker = window.create({ title: name, layer: 'overlay', width: 1, height: 1,
      anchors: ['top', 'right'], exclusiveZone: -1 });
    await until(() => marker.closed, name);
  }
  async function click(surface, id) {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const node = surface.window.document.getElementById(id), rect = node?.getBoundingClientRect();
    check(rect?.width > 0 && rect.height > 0, id + ' has actual native geometry');
    await signal('backdrop-click ' + Math.floor(rect.x + rect.width / 2) + ' ' +
      Math.floor(rect.y + rect.height / 2) + ' ' + surface.options.title);
  }
  const panel = output => {
    const surface = shell.getSurfaces().find(surface => surface.kind === 'panel' && surface.output === output.id);
    return { window: surface.window, options: { title: 'PollyShell.panel.' + output.id } };
  };
  const root = menu => menu.window.document.getElementById('shell-applications');
  async function open(output, expected = 'regional') {
    const began = Date.now();
    const before = created.filter(surface => surface.options.title.startsWith('PollyShell.menu.')).length;
    await click(panel(output), 'shell-menu');
    await until(() => currentMenu() && root(currentMenu())?.offsetWidth > 0, 'production Start mapped');
    if (expected === 'regional')
      await until(() => root(currentMenu())?.style.backgroundColor === 'transparent', 'regional transaction completed');
    else if (expected === 'extent')
      await until(() => shell.getState().materialError.includes('4096x512'), 'actual extent rejection');
    else if (expected === 'budget')
      await until(() => shell.getState().materialError.includes('peak budget rejected'), 'actual budget rejection');
    check(created.filter(surface => surface.options.title.startsWith('PollyShell.menu.')).length === before + 1,
      'one real taskbar pointer activation opens exactly one Start');
    if (standard) {
      const actual = currentMenu().window.state;
      check(actual.width === 640 && actual.height === (output.height === 720 ? 640 : 660),
        'unchanged production Start actual extent is 640x' + actual.height + ' on ' + output.width + 'x' + output.height);
      console.log('STANDARD_START_OPEN_OBSERVATION ' + JSON.stringify({
        output: [output.width, output.height], actual: [actual.width, actual.height],
        elapsedMs: Date.now() - began, expected,
        work: 'taskbar geometry frames, actual pointer roundtrip, solid map/layout/paint, two presentation frames, native prepare/commit and JS background repaint; not output ACK or a frame-time qualification',
      }));
    }
    return currentMenu();
  }
  if (mode === 'modern-old') {
    const originals = shell.getSurfaces().map(surface => surface.window);
    check(desktop.shellBackdropCapability() === false, 'actual old v7 provider explicitly lacks Shell recipient capability');
    check(!shell.selectTheme('modern') && shell.getState().themeId === 'xp' &&
      configuration.snapshot.theme.id === 'xp' && originals.every(surface => !surface.closed),
    'actual old v7 provider rejects opt-in before surface/theme/persistence mutation');
    const success = window.create({ title: 'fixture-success', layer: 'overlay', width: 1, height: 1,
      anchors: ['top', 'right'], exclusiveZone: -1 });
    await until(() => success.closed, 'old-provider acknowledgement');
    shell.stop(); window.quit(); return;
  }
  check(desktop.shellBackdropCapability() === true, 'paired v8 capability reports implemented real renderer support');
  if (oldV8) {
    check(desktop.startBackdropCapability() === false, 'actual old v8 provider explicitly lacks the new v9 capability');
    const originals = shell.getSurfaces().map(surface => surface.window);
    let menu = await open(outputs[0], 'default');
    check(root(menu).style.backgroundColor === '#f3f3f3', 'old v8 provider retains packaged solid Start');
    const saved = JSON.stringify(configuration.snapshot), count = created.length;
    const focus = menu.window.document.activeElement;
    const optional = JSON.parse(JSON.stringify(BUILTIN_THEME_CATALOG));
    const theme = optional.themes.find(theme => theme.id === 'modern');
    theme.panel.startBackdrop = { sigma: 16, tint: '#f3f3f3', opacityPercent: 72, standardHeight: true };
    installThemeCatalog(optional);
    check(!shell.selectTheme('modern') && shell.getState().error.includes('appearance v9') &&
      JSON.stringify(configuration.snapshot) === saved && created.length === count &&
      !menu.window.closed && menu.window.document.activeElement === focus && originals.every(surface => !surface.closed),
      'old v8 explicitly rejects new opt-in before resources, preferences, appearance or foreground mutation');
    let rejected = false;
    try {
      const panels = outputs.map(output => shell.getSurfaces().find(surface => surface.kind === 'panel' && surface.output === output.id));
      desktop.configureAppearance(theme, encodeDecorationLayout(theme),
        [...panels.map(surface => [surface.window, [3, 2, 0, 8, 0xf3f3f3, 72], surface.window]),
          [menu.window, [4, 3, 8000, 16, 0xf3f3f3, 72], panels[0].window]]);
    } catch (failure) {
      rejected = String(failure).includes('appearance v9');
      console.log('EXPECTED_OLD_V8_NATIVE_REJECTION ' + failure);
    }
    check(rejected && !menu.window.closed && originals.every(surface => !surface.closed),
      'native bridge independently refuses schema4 on actual v8 without a theme transaction');
    theme.panel.startBackdrop = { sigma: 12, tint: '#f3f3f3', opacityPercent: 72 };
    installThemeCatalog(optional);
    check(shell.selectTheme('modern'), 'old v8 still selects the original bounded Start opt-in');
    menu = await open(outputs[0]);
    check(menu.window.state.height === 460 && root(menu).style.backgroundColor === 'transparent',
      'old v8 still runs original schema3 production bounded Start at actual460');
    await signal('backdrop-check old-v8');
    menu.window.close();
    shell.stop();
    await signal('backdrop-check stopped');
    window.quit(); return;
  }
  if (standard) check(desktop.startBackdropCapability() === true, 'independent v9 standard-Start capability is implemented');
  await signal('backdrop-check taskbars');
  let menu = await open(outputs[0], 'default');
  check(root(menu).style.backgroundColor === '#f3f3f3' && shell.getState().materialError === '',
    'packaged standard-height Start remains solid without a known-failing default opt-in');
  menu.window.close();
  const optional = JSON.parse(JSON.stringify(BUILTIN_THEME_CATALOG));
  optional.themes.find(theme => theme.id === 'modern').panel.startBackdrop =
    { sigma: standard ? 16 : 12, tint: '#f3f3f3', opacityPercent: 72, ...(standard ? { standardHeight: true } : {}) };
  installThemeCatalog(optional);
  check(shell.selectTheme('modern'), 'explicit optional Start material uses the same original menu geometry');
  if (!standard) {
    menu = await open(outputs[0], 'extent');
    check(menu.window.state.height > 512 && root(menu).style.backgroundColor === '#f3f3f3' &&
      shell.getState().materialError.includes('4096x512'), 'actual standard Start extent is accurately rejected and stays solid');
    await signal('backdrop-check extent');
    await until(() => menu.window.closed, 'real output reconfiguration retires the oversized menu');
  }
  menu = await open(outputs[0]);
  check(standard ? menu.window.state.height === 640 : menu.window.state.height <= 512,
    standard ? 'full actual640 Start uses the new request without shrinking geometry' :
      'unchanged menu sizing naturally fits only on the smaller actual output');
  check(root(menu).style.backgroundColor === 'transparent', 'Start clears only background after native transaction success');
  await signal('backdrop-check start');
  const theme = optional.themes.find(theme => theme.id === 'modern');
  const panels = outputs.map(output => shell.getSurfaces().find(surface => surface.kind === 'panel' && surface.output === output.id));
  const material = [standard ? 4 : 3, 3, 8000, standard ? 16 : 12, 0xf3f3f3, 72];
  const panelTargets = panels.map(surface => [surface.window, [3, 2, 0, 8, 0xf3f3f3, 72], surface.window]);
  for (const targets of [
    [[panels[0].window, [2, 1, 0, 8, 0xf3f3f3, 72]]],
    [...panelTargets, [menu.window, material, panels[1].window]],
    [[menu.window, material, panels[0].window]],
    [...panelTargets, [menu.window, [3, 2, 8000, 12, 0xf3f3f3, 72], panels[0].window]],
    [...panelTargets, [menu.window, material, panels[0].window], [menu.window, material, panels[0].window]],
    ...(standard ? [
      [...panelTargets, [menu.window, [3, 3, 8000, 16, 0xf3f3f3, 72], panels[0].window]],
      [[panels[0].window, [4, 2, 0, 8, 0xf3f3f3, 72], panels[0].window]],
      [...panelTargets, [panels[0].window, material, panels[0].window]],
    ] : []),
  ]) {
    let rejected = false;
    try { desktop.configureAppearance(theme, encodeDecorationLayout(theme), targets); }
    catch (failure) { rejected = true; console.log('EXPECTED_SHELL_BACKDROP_REJECTION ' + failure); }
    check(rejected && !menu.window.closed && panels.every(surface => !surface.window.closed),
      'invalid role/pair/duplicate/missing peer transaction retains production recipients');
  }
  for (const during of ['peer-getter', 'theme-toJSON']) {
    const candidate = window.create({ title: 'Backdrop.peer.candidate', layer: 'top', width: 0, height: 48,
      anchors: ['bottom', 'left', 'right'], exclusiveZone: 0, transparent: true });
    const next = [menu.window, material, candidate];
    if (during === 'peer-getter') Object.defineProperty(next, 2, { get() { candidate.close(); return candidate; } });
    const snapshot = during === 'theme-toJSON' ? { ...theme, toJSON() { candidate.close(); return theme; } } : theme;
    let rejected = false;
    try { desktop.configureAppearance(snapshot, encodeDecorationLayout(theme), [...panelTargets, next]); }
    catch (failure) {
      rejected = failure.name === 'TypeError' && String(failure).includes('Window is closed');
      console.log('EXPECTED_SHELL_PEER_LIFETIME_REJECTION ' + during + ' ' + failure);
    } finally { if (!candidate.closed) candidate.close(); }
    check(rejected, 'retired actual peer is revalidated after ' + during);
  }
  if (standard) {
    for (const during of ['target-getter', 'theme-toJSON', 'ordinary-target']) {
      const candidate = window.create(during === 'ordinary-target' ?
        { title: 'Backdrop.standard.ordinary', width: 640, height: 660 } :
        { title: 'Backdrop.standard.candidate', layer: 'overlay', width: 640, height: 660,
          anchors: ['bottom'], margins: { bottom: 48 }, exclusiveZone: -1, keyboard: 'none', transparent: true });
      const target = [candidate, material, panels[0].window];
      if (during === 'target-getter') Object.defineProperty(target, 1, {
        get() { candidate.close(); return material; },
      });
      const snapshot = during === 'theme-toJSON' ?
        { ...theme, toJSON() { candidate.close(); return theme; } } : theme;
      let rejected = false;
      try { desktop.configureAppearance(snapshot, encodeDecorationLayout(theme), [...panelTargets, target]); }
      catch (failure) {
        rejected = failure.name === 'TypeError';
        console.log('EXPECTED_STANDARD_START_LIFETIME_REJECTION ' + during + ' ' + failure);
      } finally { if (!candidate.closed) candidate.close(); }
      check(rejected && !menu.window.closed && panels.every(surface => !surface.window.closed),
        'new standard request rejects ' + during + ' without replacing committed recipients');
    }
  }
  await signal('backdrop-check retained');
  if (standard) {
    const sameWindow = menu.window;
    const search = menu.window.document.getElementById('shell-app-search');
    search.focus();
    await signal('backdrop-key 30');
    await until(() => search.textContent === 'a', 'real native text edits the existing production Start search');
    await signal('backdrop-key 14');
    await until(() => search.textContent === '', 'real Backspace edits the same existing search input');
    check(menu.window === sameWindow && !menu.window.closed && root(menu).style.backgroundColor === 'transparent',
      'search edit keeps the same actual full-height Start and opaque foreground');
  }
  menu.window.document.getElementById('shell-app-refresh').focus();
  const menuBody = menu.window.document.body;
  let tabDown = 0, tabUp = 0, tabTarget = '';
  const tabPressed = event => {
    if (event.key === 'Tab') { tabDown++; tabTarget = event.target.id; }
  };
  const tabReleased = event => { if (event.key === 'Tab') tabUp++; };
  menuBody.addEventListener('keydown', tabPressed);
  menuBody.addEventListener('keyup', tabReleased);
  try {
    await signal('backdrop-key 15');
    // Marker closure acknowledges injection, not delivery through the GUI event queue.
    await until(() => tabUp > 0, 'single native Tab delivery to the production menu');
  } finally {
    menuBody.removeEventListener('keydown', tabPressed);
    menuBody.removeEventListener('keyup', tabReleased);
  }
  check(tabDown === 1 && tabUp === 1 && tabTarget === 'shell-app-refresh',
    'one native Tab press/release reaches the focused Refresh control exactly once');
  check(menu.window.document.activeElement?.id === 'shell-app-close', 'real Tab reaches Close menu from Refresh');
  if (standard) {
    await signal('backdrop-key 15 shift');
    await until(() => menu.window.document.activeElement?.id === 'shell-app-refresh', 'native Shift+Tab reverses focus');
    await signal('backdrop-key 15');
    await until(() => menu.window.document.activeElement?.id === 'shell-app-close', 'native Tab returns to Close');
  }
  await signal('backdrop-key 28');
  await until(() => menu.window.closed, 'one Enter closes production Start');
  await signal('backdrop-check closed');
  menu = await open(outputs[1]);
  await signal('backdrop-check start');
  await signal('backdrop-check stale');
  await delay(50);
  check(root(menu).style.backgroundColor === 'transparent' && outputs.every(output =>
    panel(output).window.document.getElementById('shell-panel').style.backgroundColor === 'transparent'),
  'late actual old-serial retirement affects neither new Start nor either current taskbar');
  check(shell.selectTheme('xp') && menu.window.closed, 'retheme closes Start and retires paired effects');
  await signal('backdrop-check legacy');
  check(shell.selectTheme('modern'), 'modern taskbar can be restored');
  await signal('backdrop-pressure on');
  menu = await open(outputs[0], 'budget');
  check(root(menu).style.backgroundColor === '#f3f3f3' && shell.getState().materialError.includes('solid retained'),
    'actual peak-budget rejection keeps Start solid and exposes independent material error');
  await signal('backdrop-check budget');
  await signal('backdrop-pressure off');
  menu.window.close();
  menu = await open(outputs[0]);
  if (standard) {
    await signal('backdrop-key 1');
    await until(() => menu.window.closed, 'one native Escape closes the same production Start');
    menu = await open(outputs[0]);
    await click(menu, 'shell-app-close');
    await until(() => menu.window.closed, 'one native Close pointer closes the same production Start');
    menu = await open(outputs[0]);
  }
  await signal('backdrop-check privacy');
  menu.window.close();
  menu = await open(outputs[0]);
  let rejected = false;
  try {
    const currentPanels = shell.getSurfaces().filter(surface => surface.kind === 'panel');
    desktop.configureAppearance(theme, encodeDecorationLayout(theme),
      currentPanels.map(surface => [surface.window, [3, 2, 0, 33, 0xf3f3f3, 72], surface.window]));
  } catch (failure) { rejected = true; }
  check(rejected, 'a failed pending transaction does not erase the applied retirement identity');
  await signal('backdrop-check unpair');
  await until(() => root(menu).style.backgroundColor === '#f3f3f3', 'paired taskbar retirement repaints Start solid');
  check(panel(outputs[1]).window.document.getElementById('shell-panel').style.backgroundColor === 'transparent',
    'current-serial exact-target retirement leaves the other output taskbar material active');
  menu.window.close();
  shell.refresh(true);
  menu = await open(outputs[1]);
  await signal('backdrop-check output');
  await until(() => menu.window.closed, 'removed actual output closes Start');
  check(!shell.getState().materialError.startsWith('Could not retire Start material'),
    'output retirement submits only current live taskbars, never a closed peer');
  shell.stop();
  await signal('backdrop-check stopped');
  window.quit();
}
