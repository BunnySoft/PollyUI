import { createDesktopShell } from './desktop/shell/shell.mjs';
import { defaultShellConfiguration } from './desktop/shell/configuration.mjs';
import { memoryConfiguration } from './desktop/tests/configuration-memory.mjs';
import { runtimeBuild } from './desktop/client/settings-contract.mjs';
import { BUILTIN_THEME_CATALOG, installThemeCatalog, getDesktopTheme } from './desktop/shared/ui/themes.mjs';
import { encodeDecorationLayout } from './desktop/shared/ui/caption-layout.mjs';

const [mode] = application.arguments;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(value, message) {
  if (!value) throw new Error(message);
  console.log('PASS: ' + message);
}
async function until(predicate, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error('Timed out: ' + message);
}
async function run() {
  if (mode === 'public') {
    for (const action of [() => desktop.systemMenuCapability(), () => desktop.enableSystemMenuRequests(true),
      () => desktop.takeSystemMenuRequest()]) {
      let failure;
      try { action(); } catch (error) { failure = error; }
      check(!!failure, 'public connection cannot read or enable native menu input');
    }
    const client = window.create({ title: 'SystemMenu.client.body', width: 220, height: 120 });
    client.setFrameless(true);
    const target = client.document.createElement('view');
    Object.assign(target.style, { width: '100%', height: '100%', backgroundColor: '#234567' });
    client.document.body.appendChild(target);
    let downs = 0, ups = 0, contexts = 0;
    const entered = () => {
      if (ups === 0) target.style.backgroundColor = '#456789';
      const rect = target.getBoundingClientRect();
      check(rect.x <= 20 && rect.y <= 20 && rect.right > 20 && rect.bottom > 20,
        'plain SDK target actual layout contains the requested local point');
      console.log('SYSTEM_MENU_CLIENT_READY ' + JSON.stringify(rect));
    };
    const down = event => {
      console.log('SYSTEM_MENU_CLIENT_DOWN ' + JSON.stringify({ button: event.button,
        x: event.clientX, y: event.clientY, target: event.target === target }));
      check(event.target === target, 'actual right down targets the plain SDK client node');
      if (event.button === 2) {
        check(event.clientX === 20 && event.clientY === 20, 'SDK right down retains the actual source-local point');
        downs++;
      }
    };
    const up = event => {
      console.log('SYSTEM_MENU_CLIENT_UP ' + JSON.stringify({ button: event.button,
        x: event.clientX, y: event.clientY, target: event.target === target }));
      check(event.target === target, 'actual right up targets the same SDK client node');
      if (event.button !== 2) return;
      check(event.clientX === 20 && event.clientY === 20, 'SDK right up retains the same source-local point');
      ups++;
    };
    const context = event => {
      if (event.button !== 2) return;
      check(event.target === target, 'SDK contextmenu follows the same original target and button pair');
      contexts++;
      const once = downs === 1 && ups === 1 && contexts === 1;
      target.style.backgroundColor = once ? '#33cc66' : '#ff0000';
      console.log('SYSTEM_MENU_CLIENT_INPUT ' + JSON.stringify({ downs, ups, contexts,
        target: event.target === target }));
      const witness = window.create({ title: once ? 'SystemMenu.client.ok' :
        'SystemMenu.client.duplicate', width: 32, height: 32 });
      witness.setFrameless(true);
    };
    target.addEventListener('mouseenter', entered);
    const handlers = { mousedown: down, mouseup: up, contextmenu: context };
    for (const [type, handler] of Object.entries(handlers)) client.document.body.addEventListener(type, handler);
    client.onclose = () => {
      target.removeEventListener('mouseenter', entered);
      for (const [type, handler] of Object.entries(handlers)) client.document.body.removeEventListener(type, handler);
      window.quit();
    };
    window.close();
    return;
  }
  const build = runtimeBuild();
  check(/^[0-9a-f]{40}$/.test(build.revision) && build.sourceDirty === false, 'actual clean source GUI metadata');
  console.log('SYSTEM_MENU_GUI_BUILD ' + JSON.stringify(build));
  const created = [];
  const configuration = memoryConfiguration({ ...defaultShellConfiguration(),
    theme: { id: 'xp', filesEnabled: false } });
  let registrations = 0;
  const open = desktop.openWindowMenu;
  desktop.openWindowMenu = (...args) => { const epoch = open(...args); registrations++; return epoch; };
  const shell = createDesktopShell({ configuration, host: {
    close: () => window.close(), displays: () => window.displays(),
    create(options) {
      const owned = window.create(options);
      created.push({ window: owned, options });
      return owned;
    },
  } }).start();
  async function signal(name) {
    const marker = window.create({ title: 'system-' + name, layer: 'overlay', width: 1, height: 1,
      anchors: ['top', 'right'], exclusiveZone: -1 });
    await until(() => marker.closed, name);
  }
  const current = () => created.findLast(item => !item.window.closed &&
    item.window.document.getElementById('shell-window-actions'));
  const target = slot => desktop.windows().find(item => item.appId === 'org.pollywm.test.' + (slot + 7));
  async function key(code, shift = false) { await signal('key ' + code + ' ' + Number(shift)); }
  async function readyMenu(before) {
    await until(() => current(), 'production ordinary menu from actual input');
    const menu = current();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await signal('menu-ready');
    check(registrations === before + 1, 'one native input registers exactly one ordinary menu epoch');
    check(!menu.window.document.getElementById('shell-layout-picker'), 'native system entry is not a caption layout picker');
    check(!!menu.window.document.getElementById('shell-window-cascade'), 'ordinary menu retains Cascade');
    if (mode !== 'old')
      check(!!menu.window.document.getElementById('shell-window-tile-horizontal') &&
        !!menu.window.document.getElementById('shell-window-tile-vertical'), 'ordinary menu retains both arrangements');
    return menu;
  }
  async function click(menu, id) {
    const rect = menu.window.document.getElementById(id)?.getBoundingClientRect();
    check(rect?.width > 0 && rect.height > 0, id + ' has actual GUI geometry');
    await signal('click ' + Math.floor(rect.x + rect.width / 2) + ' ' + Math.floor(rect.y + rect.height / 2));
  }
  await signal('ready');
  check(desktop.systemMenuCapability() === (mode !== 'old'), 'actual paired v7 capability, not API presence');
  if (mode !== 'old') {
    const observer = desktop.onSystemMenuRequested;
    const before = registrations;
    desktop.onSystemMenuRequested = () => {};
    try {
      await signal('focus 0');
      await signal('alt-space 0');
      await signal('retheme-before');
      const theme = getDesktopTheme('server2003');
      desktop.configureAppearance(theme, encodeDecorationLayout(theme));
      await signal('retheme-after');
    } finally { desktop.onSystemMenuRequested = observer; }
    observer();
    check(!current() && registrations === before, 'real production theme commit retires an unconsumed native request without a fake renderer document');
    check(shell.selectTheme('server2003'), 'Shell adopts the same real committed theme');
  }
  for (const [slot, theme] of ['xp', 'server2003', 'modern'].entries()) {
    check(shell.selectTheme(theme), theme + ' selects normally');
    await signal('focus ' + slot);
    let before = registrations;
    await signal('title-down ' + slot);
    check(!current() && registrations === before, 'title press alone cannot create a popup');
    await signal('title-up ' + slot);
    if (mode === 'old') {
      await delay(30);
      check(!current() && registrations === before, 'actual v6 provider keeps native title behavior without a v7 request');
    } else {
      const menu = await readyMenu(before);
      await key(1);
      await until(() => menu.window.closed, 'real Escape closes title menu');
      desktop.onSystemMenuRequested();
      check(!current(), 'consumed event cannot reopen after Escape');
    }
    await signal('focus ' + slot);
    before = registrations;
    await signal('alt-space ' + slot);
    if (mode === 'old') {
      await delay(30);
      check(!current() && registrations === before, 'actual v6 Alt+Space reaches the application unchanged');
    } else {
      const menu = await readyMenu(before);
      menu.window.document.getElementById('shell-window-menu-close').focus();
      await key(28);
      await until(() => menu.window.closed, 'real Enter closes keyboard menu before any later key release');
    }
  }
  await signal('client');
  await until(() => desktop.windows().some(item => item.appId === 'org.pollyui.system-menu-public' &&
    item.title === 'SystemMenu.client.ok'), 'SDK CSD client received its single right-button down/up');
  check(!current(), 'client-body right click does not create a native menu');
  await signal('client-check');
  if (mode !== 'old') {
    const before = registrations;
    await signal('client-alt-space');
    const clientMenu = await readyMenu(before);
    await key(1);
    await until(() => clientMenu.window.closed, 'focused real SDK CSD window also supports Alt+Space without a native title');
  }
  await signal('client-finish');
  await signal('focus 0');
  let before = registrations;
  if (mode === 'old') {
    shell.showWindowActions(window.displays()[0].id, target(0).id);
  } else {
    await signal('title-down 0'); await signal('title-up 0');
  }
  let menu = await readyMenu(before);
  await click(menu, 'shell-window-tile-left');
  await until(() => menu.window.closed && target(0)?.placement === 'left' && !target(0)?.placementPending,
    'real menu pointer uses existing Half placement');
  await signal('placed');
  before = registrations;
  shell.showWindowActions(menu.options.output, target(0).id);
  menu = await readyMenu(before);
  menu.window.document.getElementById('shell-window-restore-floating').focus();
  await key(28);
  await until(() => menu.window.closed && target(0)?.placement === 'floating' && !target(0)?.placementPending,
    'ordinary taskbar path retains Restore floating');
  before = registrations;
  shell.showWindowActions(menu.options.output, target(0).id);
  menu = await readyMenu(before);
  menu.window.document.getElementById('shell-window-cascade').focus();
  await key(28);
  await until(() => menu.window.closed && !target(0)?.placementPending, 'same ordinary menu retains coupled Cascade');
  await signal('cascade-check');
  if (mode !== 'old') {
    const solid = JSON.parse(JSON.stringify(BUILTIN_THEME_CATALOG));
    delete solid.themes.find(theme => theme.id === 'modern').panel.taskbarBackdrop;
    installThemeCatalog(solid);
    check(shell.selectTheme('modern'), 'short-output fixture keeps optional material separate from input');
    await signal('short');
    await until(() => window.displays().some(head => head.x < 0 && head.height === 241) &&
      shell.getSurfaces().some(surface => surface.kind === 'wallpaper' &&
        surface.window.document.body.offsetHeight === 241), 'actual short negative-origin output and Shell documents');
    await signal('cross');
    before = registrations;
    await signal('title-down 0'); await signal('title-up 0');
    menu = await readyMenu(before);
    const head = window.displays().find(head => head.id === menu.options.output);
    const { width, height, margins } = menu.options;
    check(head.x < 0 && head.height === 241 && width <= head.width && height <= head.height &&
      margins.left >= 0 && margins.top >= 0 && margins.left + width <= head.width &&
      margins.top + height <= head.height, 'actual cross-head title menu bounds clamp to its read-only 241px viewport');
    const visited = new Set();
    for (let i = 0; i < 24; i++) {
      await key(15);
      visited.add(menu.window.document.activeElement?.id);
    }
    check(visited.has('shell-window-menu-close'), 'real short-menu Tab reaches Close through the shared scroll viewport');
    await key(15, true);
    await signal('wheel');
    await key(1);
    await until(() => menu.window.closed, 'short native menu Escape');
  }
  check(!shell.getState().error, 'native input introduces no business or material error');
  shell.stop();
  installThemeCatalog(BUILTIN_THEME_CATALOG);
  await signal('success');
  window.quit();
}
run().catch(failure => {
  console.error('FAIL: ' + String(failure) + '\n' + failure.stack);
  window.quit();
});
