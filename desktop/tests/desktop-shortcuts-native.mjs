import { createDesktopShell } from './desktop/tests/configured-shell.mjs';
import { getDesktopTheme } from './desktop/shell/themes.mjs';

const [mode] = application.arguments;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const created = [];
const decodedIcons = [];
let bundleFixture = globalThis.desktopArtworkFixture?.file ?? null;
let shell;
function check(value, message) {
  if (!value) throw new Error(message);
  console.log('PASS: ' + message);
}
async function until(predicate, message) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { if (predicate()) return; await pause(10); }
  throw new Error('Timed out: ' + message);
}
async function native(title) {
  const marker = window.create({ title, layer: 'overlay', width: 1, height: 1,
    anchors: ['top', 'right'], exclusiveZone: -1 });
  await until(() => marker.closed, title); await pause(30);
}
function background(output = shell.getState().outputs[0]) {
  return shell.getSurfaces().find(surface => surface.kind === 'wallpaper' && surface.output === output);
}
const target = surface => `PollyShell.${surface.kind}.${surface.output}`;
const state = surface => surface.desktopController.state;
const icon = (surface, id) => surface.window.document.getElementById('shell-desktop-icon-' + id);
async function pointer(surface, action, x, y) {
  await native(`fixture-desktop-pointer ${action} ${Math.floor(x)} ${Math.floor(y)} ${target(surface)}`);
}
async function clickNode(surface, node, action = 'click') {
  await until(() => node.offsetWidth > 0 && node.offsetHeight > 0, node.id + ' layout');
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const bounds = node.getBoundingClientRect();
  console.log('INFO: fixture pointer ' + node.id + ' ' + JSON.stringify(bounds));
  await pointer(surface, action, bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
}
async function key(code, modifiers = []) {
  for (const modifier of modifiers) await native(`fixture-key ${modifier} 1`);
  await native(`fixture-key ${code} 1`); await native(`fixture-key ${code} 0`);
  for (const modifier of [...modifiers].reverse()) await native(`fixture-key ${modifier} 0`);
}
function color(value) { return value.slice(1); }
async function pixel(surface, x, y, expected) {
  await pause(80);
  await native(`fixture-desktop-pixel ${Math.floor(x)} ${Math.floor(y)} ${color(expected)} ${target(surface)}`);
}
async function run() {
  const nativeApi = new Proxy(desktop, {
    get(object, key) {
      if (key === 'bundleFiles' && globalThis.desktopArtworkFixture) return () => bundleFixture ? [bundleFixture] : [];
      return Reflect.get(object, key);
    },
    set(object, key, value) { return Reflect.set(object, key, value); },
  });
  if (globalThis.desktopArtworkFixture) {
    const decode = globalThis.createBitmap;
    globalThis.createBitmap = (bytes, maximum) => {
      const bitmap = decode(bytes, maximum); decodedIcons.push(bitmap); return bitmap;
    };
  }
  shell = createDesktopShell({ host: { close: () => window.close(), displays: () => window.displays(),
    create(options) { const native = window.create(options); created.push({ ...options, window: native }); return native; } },
    native: nativeApi }).start();
  check(shell.selectTheme('xp'), 'desktop fixture selects actual production XP theme');
  await until(() => shell.getSurfaces().every(surface => surface.window.document.body.offsetWidth > 0), 'all native Shell surfaces');
  console.log('INFO: native output identity fixture ' + JSON.stringify({ moduleRoot: application.moduleRoot,
    runtimeRevision: application.runtimeRevision, runtimeSourceDirty: application.runtimeSourceDirty,
    displays: window.displays(), heads: desktop.outputConfiguration().heads }));
  const first = background(), second = background(shell.getState().outputs[1]);
  check(first && second && first.window.document !== second.window.document, 'two independent output documents');
  if (mode === 'artwork') {
    const id = 'bundle:' + bundleFixture.id;
    check(shell.addDesktopShortcut(first.output, id), 'production Shell pins a validated managed-bundle catalog fixture');
    await until(() => icon(first, id)?.firstChild?.style.backgroundImage?.startsWith('polly-memory:'), 'bundle icon decoded');
    await pause(120);
    const image = icon(first, id).firstChild;
    await pixel(first, image.offsetLeft + 18, image.offsetTop + 18, '#2090e0');
    first.window.capture(application.cacheDir + '/desktop-bundle-icon.png');
    check(shell.removeDesktopShortcuts([id]), 'Shell unpins bundle shortcut');
    check(decodedIcons[0].closed, 'actual Shell unpin releases registered icon bitmap');
    check(shell.addDesktopShortcut(first.output, id), 'Shell repins bundle shortcut');
    await until(() => decodedIcons.length === 2, 'repin artwork');
    bundleFixture = desktopArtworkFixture.alternate;
    shell.showApplications(first.output);
    await until(() => decodedIcons.length === 3, 'catalog replacement artwork');
    check(decodedIcons[1].closed && !decodedIcons[2].closed, 'actual Shell catalog object change replaces and closes bitmap');
    await key(1);
    bundleFixture = desktopArtworkFixture.invalid;
    shell.showApplications(first.output);
    await until(() => icon(first, id)?.firstChild?.style.backgroundImage === '', 'fallback artwork after bad bitmap');
    check(decodedIcons[2].closed, 'invalid replacement cannot retain stale bundle image');
    check(first.window.document.getElementById('shell-desktop-status').firstChild,
      'bad bundle icon has explicit desktop error feedback with original fallback artwork');
    await key(1);
    bundleFixture = desktopArtworkFixture.alternate;
    shell.showApplications(first.output); await key(1);
    await until(() => decodedIcons.length === 4, 'restored valid icon');
    await native('fixture-success'); shell.stop();
    check(decodedIcons[3].closed, 'actual Shell stop releases remaining bitmap');
    window.quit(); return;
  } else if (mode === 'reload') {
    check(shell.configuration.snapshot.desktop.shortcuts.length === 3, 'shortcut profile survives actual process restart');
    const app = icon(first, 'bd04-a.desktop');
    await until(() => app?.offsetWidth > 0, 'reloaded icon');
    check(app.offsetTop >= 120, 'rearranged logical desktop position survives restart');
    first.window.capture(application.cacheDir + '/desktop-reloaded.png');
  } else {
    check(shell.configuration.snapshot.desktop.shortcuts.length === 0, 'first desktop is empty, not catalog-autopinned');
    const menuWindow = shell.showApplications(first.output);
    const menu = { window: menuWindow, kind: 'settings', output: first.output };
    await until(() => menuWindow.document.getElementById('shell-app-pin-bd04-a.desktop')?.offsetWidth > 0, 'native application add entry');
    menuWindow.document.body.addEventListener('click', event => console.log('INFO: actual native menu click ' + event.target.id));
    menuWindow.capture(application.cacheDir + '/desktop-application-menu.png');
    await clickNode(menu, menuWindow.document.getElementById('shell-app-pin-bd04-a.desktop'));
    await until(() => shell.configuration.snapshot.desktop.shortcuts.length === 1, 'native menu pin publication');
    check(shell.configuration.snapshot.desktop.shortcuts.length === 1, 'real Applications menu adds stable desktop ID');
    check(shell.addDesktopShortcut(first.output, 'bd04-a.desktop'), 'duplicate add is idempotent');
    check(shell.configuration.snapshot.desktop.shortcuts.length === 1, 'duplicate shortcuts are not saved');
    check(shell.addDesktopShortcut(first.output, 'bd04-b.desktop'), 'second fixture shortcut added');
    check(shell.addDesktopShortcut(second.output, 'org.pollyui.settings'), 'Settings shortcut assigned to second stable output');
    await key(1);
    await pause(100);
    const a = icon(first, 'bd04-a.desktop'), b = icon(first, 'bd04-b.desktop');
    await pointer(first, 'move', a.offsetLeft + 48, a.offsetTop + 20);
    await pixel(first, a.offsetLeft, a.offsetTop + 52, getDesktopTheme('xp').colors.light);
    first.window.capture(application.cacheDir + '/desktop-hover.png');
    await clickNode(first, a);
    check(state(first).selected.size === 1, 'actual native single-click selects without launching');
    check(!desktop.windows().some(view => view.title === 'BD04.App'), 'single-click does not spawn an app');
    await pixel(first, a.offsetLeft + 4, a.offsetTop + 4, getDesktopTheme('xp').colors.selection);
    await native('fixture-key 29 1');
    await clickNode(first, b);
    await native('fixture-key 29 0');
    check(state(first).selected.size === 2, 'native Ctrl-click adds to selection');
    check(state(second).selected.size === 0, 'selection does not leak into another output document');
    await clickNode(first, a); await pause(400);
    await native('fixture-key 42 1'); await clickNode(first, b); await native('fixture-key 42 0');
    check(state(first).selected.size === 2, 'native Shift-click ordered range');
    await pointer(first, 'click', 450, 250);
    check(state(first).selected.size === 0, 'native blank click clears selection');
    first.window.capture(application.cacheDir + '/desktop-before-marquee.png');
    await pointer(first, 'down', 250, 150);
    check(first.window.document.body.hasMouseCapture(), 'native background capture exists only during held press');
    await pointer(first, 'move', 247, 147);
    check(!state(first).dragging && !state(first).rectangle, 'native movement below four logical pixels remains a click');
    await pointer(first, 'move', 10, 10);
    check(state(first).rectangle?.width === 240 && state(first).selected.size === 2, 'native reverse-direction marquee intersects icon bounding boxes');
    first.window.capture(application.cacheDir + '/desktop-marquee.png');
    shell.refresh(true);
    check(state(first).held && first.window.document.body.hasMouseCapture(), 'production Shell repaint retains native capture and marquee state');
    await pointer(first, 'up', 10, 10);
    check(!state(first).held && !first.window.document.body.hasMouseCapture(), 'real release ends marquee and capture');
    const positions = state(first).items.map(item => [item.id, item.x, item.y]);
    let dragX = a.offsetLeft + 48, dragY = a.offsetTop + 20;
    await pointer(first, 'down', dragX, dragY);
    await pointer(first, 'move', dragX, dragY + 208);
    check(state(first).dragging, 'native group drag crosses four logical pixel threshold');
    await key(1);
    check(JSON.stringify(state(first).items.map(item => [item.id, item.x, item.y])) === JSON.stringify(positions),
      'Escape restores original group positions without saving');
    await pointer(first, 'up', dragX, dragY + 208);
    await key(30, [29]);
    check(state(first).selected.size === 2, 'native Ctrl+A selects output-local shortcuts');
    dragX = a.offsetLeft + 48; dragY = a.offsetTop + 20;
    await pointer(first, 'down', dragX, dragY);
    await pointer(first, 'move', dragX, dragY + 104);
    await pointer(first, 'up', dragX, dragY + 104);
    await pause(100);
    check(state(first).items[0].y === 120 && state(first).items[1].y === 120, 'native group move retains relative grid arrangement');
    check(shell.configuration.snapshot.desktop.shortcuts.find(item => item.id === 'bd04-a.desktop').y === 120,
      'native completed group move persisted logical coordinates');
    first.window.capture(application.cacheDir + '/desktop-rearranged.png');
    await pointer(first, 'click', 450, 250);
    await clickNode(first, a); await pause(90); await clickNode(first, a);
    await until(() => desktop.windows().some(view => view.title === 'BD04.App'), 'double-click real fixture launch');
    check(desktop.windows().some(view => view.appId === 'org.pollyui.bd04-fixture'), 'double-click uses actual trusted application spawning');
    await native('fixture-desktop-pointer click 20 30 BD04.App');
    await key(30, [29]);
    check(state(first).selected.size === 1, 'covered desktop does not steal application Ctrl+A');
    await until(() => !desktop.windows().some(view => view.title === 'BD04.App'), 'fixture app self-close');
    await pause(400); await clickNode(first, a); await key(106);
    check(state(first).focused === 'bd04-b.desktop', 'native ArrowRight moves roving grid focus');
    await key(30, [29]); await key(28);
    await until(() => desktop.windows().some(view => view.title === 'BD04.App'), 'Enter actual fixture launch');
    check(desktop.windows().filter(view => view.title === 'BD04.App').length === 1,
      'multi-selection Enter launches only the focused fixture application');
    await until(() => !desktop.windows().some(view => view.title === 'BD04.App'), 'Enter fixture self-close');
    await pointer(first, 'down', 250, 150); await pointer(first, 'move', 10, 10);
    const peer = window.create({ title: 'BD04.CapturePeer', width: 220, height: 140 });
    await until(() => !state(first).held, 'ordinary native focus loss cancels background capture');
    check(!state(first).rectangle && !first.window.document.body.hasMouseCapture(),
      'ordinary native focus loss releases capture and cancels marquee without synthetic mouseup');
    peer.close(); await pointer(first, 'up', 10, 10);
    await pointer(first, 'down', 250, 150); await pointer(first, 'move', 10, 10);
    await native('fixture-desktop-lock');
    await until(() => !state(first).held, 'real session lock cancels native capture');
    check(!state(first).rectangle, 'lock never leaves a stale marquee');
    await native('fixture-desktop-unlocked'); await pointer(first, 'up', 10, 10);
    await pointer(first, 'right', 450, 250);
    await until(() => created.some(surface => !surface.window.closed && surface.window.document.getElementById('shell-desktop-settings')),
      'desktop context menu preserves Settings entry');
    const context = created.findLast(surface => !surface.window.closed && surface.window.document.getElementById('shell-desktop-remove-bd04-b.desktop'));
    await pointer({ window: context.window, kind: 'settings', output: first.output }, 'wheel', 160, 300);
    await clickNode({ window: context.window, kind: 'settings', output: first.output },
      context.window.document.getElementById('shell-desktop-remove-bd04-b.desktop'));
    check(!icon(first, 'bd04-b.desktop') && desktop.applicationFiles().some(entry => entry.id === 'bd04-b.desktop'),
      'native context-menu removal removes only shortcut, not its catalog application');
    check(shell.addDesktopShortcut(first.output, 'bd04-b.desktop'), 'removed native shortcut can be added again');
    await key(1);
    const head = desktop.outputConfiguration().heads.find(head => head.description === window.displays().find(output => output.id === first.output).name);
    await native(`fixture-desktop-scale 1.25 ${head.name}`);
    await until(() => desktop.outputConfiguration().heads.find(item => item.name === head.name)?.scale === 1.25 &&
      Math.abs(first.window.document.body.offsetWidth - 1024) <= 1, 'fractional DPI logical background geometry');
    shell.refresh(true); await pause(150);
    check(state(first).items.every(item => item.x + 96 <= first.window.document.body.offsetWidth &&
      item.y + 104 < first.window.document.body.offsetHeight - getDesktopTheme('xp').panel.height),
      'fractional DPI icons use constrained logical output coordinates');
    first.window.capture(application.cacheDir + '/desktop-fractional.png');
    const secondHead = desktop.outputConfiguration().heads.find(head =>
      head.description === window.displays().find(output => output.id === second.output).name);
    await native(`fixture-desktop-scale 1.5 ${secondHead.name}`);
    await until(() => Math.abs(second.window.document.body.offsetWidth - 853) <= 1, 'second fractional output geometry');
    shell.refresh(true); await pause(100);
    await clickNode(second, icon(second, 'org.pollyui.settings'));
    check(state(second).selected.size === 1 && state(first).selected.size === 1,
      'simultaneous 1.25 and 1.5 fractional outputs keep independent selection');
    second.window.capture(application.cacheDir + '/desktop-second-fractional.png');
    await pixel(second, 20, 20, getDesktopTheme('xp').colors.selection);
    await native(`fixture-desktop-scale 1 ${head.name}`); shell.refresh(true); await pause(100);
    await native(`fixture-desktop-scale 1 ${secondHead.name}`); shell.refresh(true); await pause(100);
    await pointer(second, 'down', 250, 150); await pointer(second, 'move', 10, 10);
    const removed = desktop.outputConfiguration().heads.find(head => head.description === window.displays().find(output => output.id === second.output).name);
    await native(`fixture-output-remove ${removed.name}`);
    await until(() => second.window.closed, 'active desktop output retires');
    shell.refresh(true);
    check(!state(second).held && state(second).rectangle === null, 'output retirement cancels document-owned capture');
    check(shell.configuration.snapshot.desktop.shortcuts.length === 3, 'output removal never silently deletes saved shortcuts');
    check(icon(first, 'org.pollyui.settings'), 'disconnected display shortcut is accessible on surviving output');
    const savedHome = JSON.stringify(shell.configuration.snapshot.desktop.shortcuts.find(item => item.id === 'org.pollyui.settings'));
    await clickNode(first, a);
    dragX = a.offsetLeft + 48; dragY = a.offsetTop + 20;
    await pointer(first, 'down', dragX, dragY);
    await pointer(first, 'move', dragX, dragY + 104);
    await pointer(first, 'up', dragX, dragY + 104);
    check(JSON.stringify(shell.configuration.snapshot.desktop.shortcuts.find(item => item.id === 'org.pollyui.settings')) === savedHome,
      'moving another selected icon preserves unselected disconnected shortcut home and saved coordinates');
    dragX = a.offsetLeft + 48; dragY = a.offsetTop + 20;
    await pointer(first, 'down', dragX, dragY);
    await pointer(first, 'move', dragX, dragY - 104);
    await pointer(first, 'up', dragX, dragY - 104);
  }
  await native('fixture-success');
  shell.stop(); window.quit();
}
run().catch(error => {
  console.error('FAIL: desktop shortcuts native ' + String(error) + '\n' + error.stack);
  shell?.stop(); window.quit();
});
