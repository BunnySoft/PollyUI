import { createDesktopShell } from './desktop/shell/shell.mjs';
import { defaultShellConfiguration } from './desktop/shell/configuration.mjs';
import { memoryConfiguration } from './desktop/tests/configuration-memory.mjs';
import { runtimeBuild } from './desktop/client/settings-contract.mjs';
import { getDesktopTheme } from './desktop/shell/themes.mjs';
import { windowTasks } from './desktop/shell/window-groups.mjs';

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
async function signal(name) {
  const marker = window.create({ title: 'cascade-' + name, layer: 'overlay', width: 1, height: 1,
    anchors: ['top', 'right'], exclusiveZone: -1 });
  await until(() => marker.closed, name);
}
function rejected(action) {
  let error;
  try { action(); } catch (failure) { error = failure; }
  check(!!error, 'unavailable or unauthorized cascade rejects explicitly');
}
async function run() {
  const build = runtimeBuild();
  check(/^[0-9a-f]{40}$/.test(build.revision) && !build.sourceDirty, 'fresh paired GUI embeds clean actual revision');
  console.log('CASCADE_GUI_BUILD ' + JSON.stringify(build));
  if (mode === 'denied') {
    rejected(() => desktop.cascadeWindows(1, 1));
    const witness = window.create({ title: 'Cascade.public.denied', width: 160, height: 80 });
    window.close();
    await until(() => witness.closed, 'public denial witness');
    window.quit(); return;
  }
  const configuration = memoryConfiguration({ ...defaultShellConfiguration(),
    theme: { id: 'server2003', filesEnabled: false } });
  const created = [];
  const shell = createDesktopShell({ configuration, host: {
    close: () => window.close(), displays: () => window.displays(),
    create(options) {
      const owned = window.create(options);
      created.push(owned); return owned;
    },
  } }).start();
  const keeper = window.create({ title: 'Cascade.fixture.keepalive', layer: 'overlay', width: 1, height: 1,
    anchors: ['top', 'right'], exclusiveZone: -1 });
  const target = () => desktop.windows().find(item => item.appId === 'org.pollywm.test.7');
  await until(() => target()?.placement !== undefined, 'actual paired workspace target');
  await signal('ready');
  const preferences = JSON.stringify(configuration.snapshot);
  const cascadeWindows = desktop.cascadeWindows;
  let admissions = 0;
  desktop.cascadeWindows = (...args) => {
    const result = cascadeWindows(...args);
    check(result?.admitted === true && Object.keys(result).length === 1, 'result is admission only, not count or presentation');
    admissions++; return result;
  };
  async function key(code, shift = false) { await signal('key ' + code + ' ' + Number(shift)); }
  async function tab(menu, shift = false) {
    const body = menu.document.body, original = menu.document.activeElement;
    let down = 0, up = 0, target = null;
    const pressed = event => { if (event.key === 'Tab') { down++; target = event.target; } };
    const released = event => { if (event.key === 'Tab') up++; };
    body.addEventListener('keydown', pressed);
    body.addEventListener('keyup', released);
    try {
      await key(15, shift);
      await until(() => up > 0, 'single actual menu Tab keyup delivery');
    } finally {
      body.removeEventListener('keydown', pressed);
      body.removeEventListener('keyup', released);
    }
    check(down === 1 && up === 1 && target === original, 'one Tab down/up reaches its actual focused target exactly once');
  }
  async function open() {
    const output = window.displays().find(item => item.x < 0) || window.displays()[0];
    const menu = shell.showWindowActions(output.id, target().id);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await signal('menu-ready');
    return menu;
  }
  async function pointer(menu, id) {
    const node = menu.document.getElementById(id);
    node.focus();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rect = node.getBoundingClientRect(), body = menu.document.body.getBoundingClientRect();
    check(rect.width > 0 && rect.height > 0 && rect.y >= body.y && rect.y + rect.height <= body.y + body.height,
      id + ' is pointer-reachable in the actual scroll viewport');
    await signal('click ' + Math.floor(rect.x + rect.width / 2) + ' ' + Math.floor(rect.y + rect.height / 2));
  }
  check(target().cascadeSupported === (mode !== 'old'), 'actual v5/v4 paired capability, not function presence');
  if (mode === 'old') {
    rejected(() => cascadeWindows(target().id, 1));
    const menu = await open();
    check(!menu.document.getElementById('shell-window-cascade'), 'actual old v4 provider hides cascade');
    check(!!menu.document.getElementById('shell-window-tile-left'), 'v4 ordinary placement survives');
    menu.document.getElementById('shell-window-tile-left').focus();
    await key(28);
    await until(() => menu.closed && target()?.placement === 'left' && !target()?.placementPending, 'old v4 half placement');
    check(shell.selectTheme('modern'), 'Modern picker theme enabled on the real old v4 provider');
    check(desktop.layoutPickerCapability() === true, 'actual frozen v4 provider supports the native picker');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const modern = getDesktopTheme('modern'), panelHeight = modern.panel.height;
    const taskId = windowTasks([target()], modern.panel.taskGrouping).find(item => !item.launcher).id;
    await until(() => {
      const panels = shell.getSurfaces().filter(item => item.kind === 'panel');
      return panels.length === window.displays().length && panels.every(item =>
        item.window.document.body.offsetHeight === panelHeight &&
        item.window.document.getElementById('shell-panel')?.offsetHeight === panelHeight &&
        item.window.document.getElementById('shell-window-' + taskId)?.offsetWidth > 0);
    }, 'actual Modern panel layout and task foreground after retheme');
    await signal('modern-ready ' + panelHeight);
    await signal('hover');
    await until(() => created.some(item => !item.closed && item.document.getElementById('shell-layout-picker')), 'old v4 Maxhover picker');
    const picker = created.findLast(item => !item.closed && item.document.getElementById('shell-layout-picker'));
    check(!picker.document.getElementById('shell-window-cascade'), 'old v4 picker remains layout-only');
    await key(1);
    await until(() => picker.closed, 'old v4 picker Escape');
  } else {
    rejected(() => cascadeWindows(target().id, 1));
    const menu = await open();
    await pointer(menu, 'shell-window-cascade');
    await until(() => menu.closed, 'real pointer cascade closes its ordinary menu');
    await signal('check');
    check(admissions === 1, 'one real pointer gesture admits exactly one cascade');
    await signal('small');
    await until(() => {
      const output = window.displays().find(item => item.x < 0 && item.width === 401 && item.height === 241);
      return output && shell.getSurfaces().find(item => item.output === output.id && item.kind === 'wallpaper')
        ?.window.document.body.offsetHeight === 241;
    }, 'short output processed by GUI and actual Shell surfaces');
    const short = await open(), visited = new Set();
    short.document.body.focus();
    for (let i = 0; i < 26; i++) {
      await tab(short);
      visited.add(short.document.activeElement?.id);
    }
    for (const action of ['activate', 'minimize', 'maximize', 'fullscreen', 'tile-left', 'tile-right',
      'restore-floating', 'cascade', 'close', 'menu-close'])
      if (action !== 'restore-floating')
        check(visited.has('shell-window-' + action), 'short-menu Tab reaches ' + action);
    check(Number(short.document.getElementById('shell-window-actions-viewport-scrollbar').style.opacity) > 0,
      'short menu uses the existing shared scrollbar');
    const focus = short.document.activeElement;
    await tab(short, true);
    check(short.document.activeElement !== focus, 'real Shift+Tab reverses navigation');
    await pointer(short, 'shell-window-cascade');
    await until(() => short.closed, 'short output pointer cascade');
    await signal('wrapped');
    const keyboard = await open();
    keyboard.document.getElementById('shell-window-cascade').focus();
    await key(28);
    await until(() => keyboard.closed, 'real Enter cascade');
    await signal('wrapped');
    check(admissions === 3, 'pointer, short pointer and Enter each admit once');
  }
  check(JSON.stringify(configuration.snapshot) === preferences || mode === 'old',
    'cascade does not change configuration or theme preferences');
  check(!shell.getState().error, 'cascade leaves no management error');
  await signal('success');
  shell.stop(); keeper.close(); window.quit();
}
run().catch(error => { console.error(String(error) + '\n' + String(error.stack || '')); window.quit(1); });
