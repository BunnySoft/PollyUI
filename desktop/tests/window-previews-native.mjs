import { createDesktopShell } from './desktop/tests/configured-shell.mjs';

const [mode, executable, script] = application.arguments;
let shell = null;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(value, message) {
  if (!value) throw new Error(message);
  console.log('PASS: ' + message);
}
async function until(predicate, message) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Window preview deadline: ' + message);
    await delay(10);
  }
}

if (mode === 'app') {
  check(Object.keys(desktop).length === 1 && desktop.fileSystem, 'source app has no Shell management authority');
  const name = executable;
  const surface = window.create({ title: 'Preview.Source.' + name, width: 240, height: 160 });
  const colors = { a: '#ff0000', b: '#00ff00', c: '#0000ff' };
  surface.document.body.style.backgroundColor = colors[name];
  let frame = 0;
  const timer = name === 'a' ? setInterval(() => {
    surface.document.body.style.backgroundColor = ++frame % 2 ? '#ff00ff' : '#ff0000';
  }, 500) : null;
  surface.onclose = () => { if (timer !== null) clearInterval(timer); window.quit(); };
  window.close();
} else {
  run().catch(error => {
    console.error('FAIL: ' + String(error) + '\n' + error.stack);
    shell?.stop(); window.quit();
  });
}

async function run() {
  const created = [], reports = [], exited = new Map();
  desktop.onExit = event => exited.set(event.pid, event.status);
  shell = createDesktopShell({ report: message => reports.push(message),
    settingsFactory: () => ({ close() {}, exited() {}, getState: () => ({ pid: 0, connected: false, error: '' }) }),
    host: {
      close: () => window.close(), displays: () => window.displays(),
      create(options) {
        const surface = window.create(options);
        created.push({ title: options.title, window: surface });
        return surface;
      },
    },
  }).start();
  check(desktop.windowPreviewCapability() === true, 'actual paired compositor advertises native previews');
  if (mode === 'initial') check(shell.setSwitcherStyle('thumbnails'), 'thumbnail style applies through typed Shell preferences');
  else check(shell.configuration.snapshot.theme.switcherStyle === 'thumbnails', 'thumbnail preference survives a new Shell PID');
  async function signal(title) {
    const marker = window.create({ title, layer: 'overlay', width: 1, height: 1,
      anchors: ['top', 'right'], exclusiveZone: -1 });
    await until(() => marker.closed, title);
  }
  async function key(code, down) { await signal('fixture-key ' + code + ' ' + (down ? 1 : 0)); }
  async function tap(code) { await key(code, true); await key(code, false); }
  async function begin() {
    await key(56, true); await tap(15);
    await until(() => desktop.windowSwitcher().active &&
      desktop.windowSwitcher().previewConfigured &&
      desktop.windowSwitcher().previewMask === (1 << desktop.windowSwitcher().items.length) - 1,
    'native image batch acknowledged');
  }
  async function clickCard(index) {
    const surface = created.findLast(item => item.title.startsWith('PollyShell.switcher.') && !item.window.closed);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rect = surface.window.document.getElementById('shell-switcher-item-' + index).getBoundingClientRect();
    await signal('fixture-click 999 ' + Math.floor(rect.x + rect.width / 2) + ' ' +
      Math.floor(rect.y + rect.height / 2) + ' 0 ' + surface.title);
  }
  const app = suffix => desktop.windows().find(view => view.appId === 'org.pollyui.preview-' + suffix &&
    view.title === 'Preview.Source.' + suffix);
  const sources = mode === 'initial' ? ['a', 'b', 'c'] : ['b'];
  for (const suffix of sources) {
    desktop.spawnApplication([executable, '--app-id', 'org.pollyui.preview-' + suffix,
      script, 'app', suffix], '', 'preview-' + suffix);
    await until(() => app(suffix)?.active && desktop.windows().filter(view =>
      view.appId === 'org.pollyui.preview-' + suffix).length === 1, 'source window ' + suffix + ' mapped and focused');
  }
  const original = desktop.windows().find(view => view.active)?.id;
  await begin();
  const snapshot = desktop.windowSwitcher();
  await signal('fixture-previews-ready ' + sources.length);
  check(desktop.windows().find(view => view.active)?.id === original, 'previewing does not activate another source window');
  if (mode === 'initial') {
    const moving = snapshot.items.findIndex(item => item.appId === 'org.pollyui.preview-a');
    const stable = snapshot.items.findIndex(item => item.appId === 'org.pollyui.preview-b');
    check(moving >= 0 && stable >= 0, 'actual candidate indices identify both source apps');
    const owner = created.findLast(item => item.title.startsWith('PollyShell.switcher.') && !item.window.closed).window;
    for (const rectangles of [[[999, 20, 60, 100, 60]],
      [[0, 20, 60, 100, 60], [0, 150, 60, 100, 60]]]) {
      const before = desktop.windowSwitcher();
      let rejected = false;
      try { desktop.configureWindowPreviews(before.serial, owner, rectangles, 0xf3f3f3); }
      catch { rejected = true; }
      const after = desktop.windowSwitcher();
      console.log('PREVIEW_REJECTION=' + JSON.stringify({ rejected, before: before.previewRequest, after: after.previewRequest,
        serialBefore: before.serial, serialAfter: after.serial }));
      check(rejected && after.previewRequest === before.previewRequest,
        'invalid native preview request preserves the committed presentation');
    }
    await signal('fixture-previews-ready 3');
    await signal('fixture-preview-live ' + moving);
    await signal('fixture-preview-idle ' + stable);
    await tap(1); await key(56, false);
    await until(() => !desktop.windowSwitcher().active, 'Escape cancels the visual selector');
    check(desktop.windows().find(view => view.active)?.id === original, 'Escape preserves original application focus');
    await signal('fixture-previews-closed');
    let stale = false;
    try { desktop.configureWindowPreviews(snapshot.serial, owner, [[0, 20, 60, 100, 60]], 0xf3f3f3); }
    catch { stale = true; }
    check(stale, 'retired native selector handles cannot replay a capture');
    desktop.minimizeWindow(app('a').id);
    await until(() => app('a')?.minimized, 'source app is minimized');
    await begin();
    await signal('fixture-previews-ready 3');
    const serial = desktop.windowSwitcher().serial;
    desktop.closeWindow(app('b').id);
    await until(() => desktop.windowSwitcher().active && desktop.windowSwitcher().serial !== serial &&
      desktop.windowSwitcher().items.length === 2 && desktop.windowSwitcher().previewConfigured &&
      desktop.windowSwitcher().previewMask === 3, 'source closure revokes old frames and rebuilds exact surviving candidates');
    await signal('fixture-previews-ready 2');
    const target = desktop.windowSwitcher().items.findIndex(item => item.appId === 'org.pollyui.preview-a');
    await clickCard(target);
    await key(56, false);
    await until(() => !desktop.windowSwitcher().active && app('a')?.active && !app('a')?.minimized,
      'one image-card click restores and activates the minimized source');
    await signal('fixture-previews-closed');
  } else {
    await clickCard(0);
    await key(56, false);
    await until(() => !desktop.windowSwitcher().active && app('b')?.active, 'one real pointer click accepts the image card');
    await signal('fixture-previews-closed');
  }
  for (const view of desktop.windows().filter(view => view.appId.startsWith('org.pollyui.preview-')))
    desktop.closeWindow(view.id);
  await until(() => !desktop.windows().some(view => view.appId.startsWith('org.pollyui.preview-')), 'source apps close');
  check(reports.every(message => message.startsWith('[shell] Application exited: preview-')),
    'preview service has no unexpected errors');
  console.log('PASS: native window previews ' + mode + ' complete');
  await signal('fixture-success');
  shell.stop(); window.quit();
}
