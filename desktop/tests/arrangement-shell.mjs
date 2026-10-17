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
function rejected(action, pattern) {
  let error;
  try { action(); } catch (failure) { error = failure; }
  check(!!error && (!pattern || pattern.test(String(error))), 'unavailable/unauthorized arrangement rejects explicitly: ' + error);
}
async function run() {
  const build = runtimeBuild();
  check(/^[0-9a-f]{40}$/.test(build.revision) && !build.sourceDirty, 'fresh paired GUI embeds clean actual revision');
  console.log('ARRANGEMENT_GUI_BUILD ' + JSON.stringify(build));
  if (mode === 'denied') {
    rejected(() => desktop.arrangeWindows(1, 'horizontal', 1));
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
  const keeper = window.create({ title: 'Arrangement.fixture.keepalive', layer: 'overlay', width: 1, height: 1,
    anchors: ['top', 'right'], exclusiveZone: -1 });
  const target = () => desktop.windows().find(item => item.appId === 'org.pollywm.test.7');
  await until(() => target()?.placement !== undefined, 'actual paired workspace target');
  await signal('ready');
  const preferences = JSON.stringify(configuration.snapshot);
  const arrangeWindows = desktop.arrangeWindows;
  let admissions = 0;
  desktop.arrangeWindows = (...args) => {
    const result = arrangeWindows(...args);
    check(result?.admitted === true && Object.keys(result).length === 1, 'arrangement result is admission only');
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
      await until(() => up > 0, 'single actual Tab keyup');
    } finally {
      body.removeEventListener('keydown', pressed);
      body.removeEventListener('keyup', released);
    }
    check(down === 1 && up === 1 && target === original, 'one actual Tab down/up reaches the original focused target');
  }
  async function open() {
    const output = window.displays().find(item => item.x < 0);
    check(!!output, 'menu targets the actual negative-origin output');
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
      id + ' is pointer-reachable in the shared scroll viewport');
    await signal('click ' + Math.floor(rect.x + rect.width / 2) + ' ' + Math.floor(rect.y + rect.height / 2));
  }
  check(target().arrangementSupported === (mode !== 'old'), 'explicit paired v6 capability, not API function presence');
  check(target().cascadeSupported === true, 'v5 Cascade remains independently available');
  if (mode === 'old') {
    for (const direction of ['horizontal', 'vertical'])
      rejected(() => arrangeWindows(target().id, direction, 1), /unsupported.*paired workspace v6/);
    const menu = await open();
    for (const direction of ['horizontal', 'vertical'])
      check(!menu.document.getElementById('shell-window-tile-' + direction), 'actual v5 provider hides ' + direction);
    await pointer(menu, 'shell-window-cascade');
    await until(() => menu.closed, 'real v5 Cascade menu closes');
    await signal('check');
    const half = await open();
    half.document.getElementById('shell-window-tile-left').focus();
    await key(28);
    await until(() => half.closed && target()?.placement === 'left' && !target()?.placementPending, 'real v5 half placement');
    check(shell.selectTheme('modern') && desktop.layoutPickerCapability(), 'real v5 Modern Maxhover enabled');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const modern = getDesktopTheme('modern'), height = modern.panel.height;
    const taskId = windowTasks([target()], modern.panel.taskGrouping).find(item => !item.launcher).id;
    await until(() => {
      const panels = shell.getSurfaces().filter(item => item.kind === 'panel');
      return panels.length === window.displays().length && panels.every(item =>
        item.window.document.body.offsetHeight === height &&
        item.window.document.getElementById('shell-panel')?.offsetHeight === height &&
        item.window.document.getElementById('shell-window-' + taskId)?.offsetWidth > 0);
    }, 'actual Modern panels/tasks after retheme');
    await signal('modern-ready ' + height);
    await signal('hover');
    await until(() => created.some(item => !item.closed && item.document.getElementById('shell-layout-picker')), 'actual v5 Maxhover');
    const picker = created.findLast(item => !item.closed && item.document.getElementById('shell-layout-picker'));
    for (const id of ['cascade', 'tile-horizontal', 'tile-vertical'])
      check(!picker.document.getElementById('shell-window-' + id), 'Maxhover excludes ' + id);
    await key(1);
    await until(() => picker.closed, 'actual v5 picker Escape');
    check(admissions === 0, 'unsupported arrangements sent no admitted request');
  } else {
    rejected(() => arrangeWindows(target().id, 'horizontal', 1));
    const horizontal = await open();
    rejected(() => arrangeWindows(target().id, 'diagonal', 1), /horizontal or vertical/);
    await pointer(horizontal, 'shell-window-tile-horizontal');
    await until(() => horizontal.closed, 'pointer horizontal menu closes');
    await signal('horizontal');
    const vertical = await open();
    vertical.document.getElementById('shell-window-tile-vertical').focus();
    await key(28);
    await until(() => vertical.closed, 'Enter vertical menu closes');
    await signal('vertical');
    await signal('small');
    await until(() => {
      const output = window.displays().find(item => item.x < 0 && item.width === 401 && item.height === 241);
      return output && shell.getSurfaces().find(item => item.output === output.id && item.kind === 'wallpaper')
        ?.window.document.body.offsetHeight === 241;
    }, 'short output and actual GUI surfaces settle');
    const short = await open(), visited = new Set();
    short.document.body.focus();
    for (let i = 0; i < 30; i++) { await tab(short); visited.add(short.document.activeElement?.id); }
    for (const action of ['activate', 'minimize', 'maximize', 'fullscreen', 'tile-left', 'tile-right',
      'cascade', 'tile-horizontal', 'tile-vertical', 'close', 'menu-close'])
      check(visited.has('shell-window-' + action), 'short-menu Tab reaches ' + action);
    check(Number(short.document.getElementById('shell-window-actions-viewport-scrollbar').style.opacity) > 0,
      'short menu uses existing shared scrollbar');
    const focus = short.document.activeElement;
    await tab(short, true);
    check(short.document.activeElement !== focus, 'actual Shift+Tab reverses navigation');
    await pointer(short, 'shell-window-tile-horizontal');
    await until(() => short.closed, 'short horizontal pointer');
    await signal('horizontal');
    const last = await open();
    last.document.getElementById('shell-window-tile-vertical').focus();
    await key(28);
    await until(() => last.closed, 'short vertical Enter');
    await signal('vertical');
    check(admissions === 4, 'both commands admit once through actual pointer and Enter at both viewport sizes');
  }
  check(JSON.stringify(configuration.snapshot) === preferences || mode === 'old', 'arrangement changes no preferences');
  check(!shell.getState().error, 'no management error');
  await signal('success');
  shell.stop(); keeper.close(); window.quit();
}
run().catch(error => { console.error(String(error) + '\n' + String(error.stack || '')); window.quit(1); });
