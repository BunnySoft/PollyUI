import { createFilesApp } from './desktop/apps/files/app.mjs';
import { showFileDialog } from './desktop/client/file-dialog.mjs';
import { h, render } from './gui/sdk/js/reconciler.mjs';
import { getDesktopTheme } from './desktop/shared/ui/themes.mjs';
import { settingsView } from './desktop/apps/settings/ui/appearance.mjs';
import { shortcutsView } from './desktop/apps/settings/ui/keyboard.mjs';
import { panelAppearance, panelDetail } from './desktop/shared/ui/panel-appearance.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
const settle = async () => { for (let i = 0; i < 6; i++) { await Promise.resolve(); host.render(); } };
const rect = node => {
  const box = node.getBoundingClientRect();
  return [box.x, box.y, box.width, box.height];
};
const outputPath = (directory, name) => directory + (directory.startsWith('/') ? '/' : '\\') + name;
const click = async node => {
  const [x, y, width, height] = rect(node);
  check(width > 0 && height > 0 && x >= 0 && y >= 0 &&
    x + width <= host.width + 1 && y + height <= host.height + 1,
    'Actual pointer target fits the viewport: ' + node.id + ' ' + JSON.stringify([x, y, width, height]));
  host.mouse('mousedown', x + width / 2, y + height / 2);
  host.mouse('mouseup', x + width / 2, y + height / 2);
  host.mouse('click', x + width / 2, y + height / 2);
  await settle();
};
const contained = (node, parent) => {
  const [x, y, w, h] = rect(node), [px, py, pw, ph] = rect(parent);
  check(x >= px - 1 && y >= py - 1 && x + w <= px + pw + 1 && y + h <= py + ph + 1,
    'Actual control stays inside its panel: ' + node.id + ' ' + JSON.stringify([rect(node), rect(parent)]));
};
async function scrollDetails(node, raw, focusColor) {
  check(node.textContent === raw, 'Readonly details preserve the complete raw text');
  const child = node.firstChild, maximum = child.offsetLeft + child.offsetWidth - node.offsetLeft - node.offsetWidth;
  check(maximum > 0, 'Actual long-token child is wider than its bounded viewport');
  node.focus(); host.key('End', 'keydown', { text: false }); await settle();
  check(Math.abs(Number(node.scrollLeft) - maximum) <= 1, 'End exposes the final part of the actual raw details');
  const [left, top, boxWidth] = rect(node);
  check(host.pixel(left + Math.floor(boxWidth / 2), top).toLowerCase() === focusColor.toLowerCase(),
    'Readonly keyboard viewport has a visible native focus border');
  host.key('Home', 'keydown', { text: false }); await settle();
  check(Number(node.scrollLeft) === 0, 'Home exposes the beginning without changing the raw value');
  host.key('ArrowRight', 'keydown', { text: false }); await settle();
  check(Number(node.scrollLeft) === Math.min(40, maximum), 'Right scrolls only inside the readonly viewport');
  host.key('ArrowLeft', 'keydown', { text: false }); await settle();
  check(Number(node.scrollLeft) === 0, 'Left is bounded at the start of the readonly viewport');
  const [x, y, width, height] = rect(node);
  host.scroll(x + width / 2, y + height / 2, 80); await settle();
  check(Number(node.scrollLeft) > 0, 'Native wheel reaches the existing horizontal scroll primitive');
}
function memoryFiles() {
  const records = new Map(), operations = [];
  const put = (path, type = 'file', extra = {}) => {
    const item = { path, type, name: path.split('/').at(-1) || '/', identity: path + ':1',
      bytes: 0, mtimeMs: 0, permissions: '0600', uid: 1000, gid: 1000, readable: true, writable: true, ...extra };
    records.set(path, item); return item;
  };
  put('/', 'directory'); put('/fixture', 'directory'); put('/fixture/old.txt');
  const files = { version: 1, implementation: 'desktop-files-v1', overwrite: true, textObservation: 'sha256-v1',
    maxEntries: 1024, maxTextBytes: 1048576,
    locations: () => ({ home: '/fixture', documents: '/fixture', downloads: '/fixture', desktop: '/fixture' }),
    listDirectory(path) {
      const directory = files.stat(path, false);
      if (directory.type !== 'directory') throw new Error('Not a fixture directory');
      return { version: 1, path, identity: directory.identity, complete: true,
        entries: [...records.values()].filter(item => item.path !== path && item.path.slice(0, item.path.lastIndexOf('/')) === path) };
    },
    stat(path) {
      if (!records.has(path)) throw Object.assign(new Error('Missing fixture path: ' + path), { code: 'ENOENT' });
      return { ...records.get(path) };
    },
    createDirectory(parent, name) { operations.push(['create', name]); return put(parent + '/' + name, 'directory'); },
    rename(path, name) { operations.push(['rename', name]); records.delete(path); return put('/fixture/' + name); },
    moveFile: true, move() { throw new Error('Cancelled fixture move must not mutate'); },
    readText() { throw new Error('Unexpected fixture read'); }, observeText() { throw new Error('Unexpected fixture observation'); },
    writeText() { throw new Error('Unexpected fixture write'); }, replaceText() { throw new Error('Unexpected fixture replace'); } };
  return { files, operations, put };
}

export function checkClassicPanelEdges(directory) {
  const theme = getDesktopTheme('server2003'), samples = [];
  for (const borderWidth of [1, 2]) {
    const custom = { ...theme, layout: { ...theme.layout, borderWidth } };
    for (const variant of ['card', 'dialog', 'menu']) {
      render(h('view', { style: { width: '100%', height: '100%', padding: 20, backgroundColor: '#182838' } },
        h('view', { id: 'panel', style: { ...panelAppearance(custom, variant), width: 180, height: 100 } },
          panelDetail(custom, variant))), document.body);
      host.render();
      const node = document.getElementById('panel'), [x, y, width, height] = rect(node);
      const pixels = [host.pixel(x + width / 2, y), host.pixel(x, y + height / 2),
        host.pixel(x + width / 2, y + height - 1), host.pixel(x + width - 1, y + height / 2)];
      const expected = variant === 'card' ? [theme.colors.dark, theme.colors.dark, theme.colors.light, theme.colors.light] :
        [variant === 'dialog' ? theme.colors.body : theme.colors.light,
          variant === 'dialog' ? theme.colors.body : theme.colors.light, '#404040', '#404040'];
      samples.push({ variant, borderWidth, pixels, expected });
      check(host.save(outputPath(directory, 'edge-' + variant + '-' + borderWidth + '.png')), 'Save measured Classic frame edges');
      check(pixels.every((pixel, index) => pixel.toLowerCase() === expected[index]),
        'Classic bevel owns all four outer edges: ' + JSON.stringify(samples.at(-1)));
    }
  }
  console.log('PANEL_CLASSIC_EDGES ' + JSON.stringify(samples));
}

export async function checkPanelConsumers(directory) {
  const { files, operations, put } = memoryFiles(), errors = [], samples = [], launches = [];
  let current = getDesktopTheme('server2003'), revision = 1, starts = 0;
  const native = { fileSystem: files, startThemeSubscription() { starts++; }, stopThemeSubscription() {},
    desktopThemeState: () => ({ available: true, ready: true, revision,
      document: JSON.stringify({ schemaVersion: 1, theme: current }) }),
    applicationFiles: () => [{ id: 'fixture.desktop', path: '/fixture/applications/fixture.desktop',
      contents: '[Desktop Entry]\nType=Application\nName=Fixture editor\nExec=/fixture/editor %f\nMimeType=text/plain;\n' }],
    documentPlatform: 'linux', documentMimeType: () => 'text/plain', canExecute: name => name === '/fixture/editor',
    mimeAssociationFiles: () => [{ path: '/fixture/mimeapps.list', directory: '/fixture/applications',
      desktopSpecific: false, contents: '[Default Applications]\ntext/plain=fixture.desktop;\n' }],
    spawnApplication(argv) { launches.push(argv); } };
  const parent = { document, closed: false, close() { this.closed = true; this.onclose?.(); } };
  const reportError = message => errors.push(message);
  const retheme = async id => { current = getDesktopTheme(id); revision++; native.onDesktopThemeChanged(); await settle(); };
  const neutral = showFileDialog({ parent, files, native, settings: { mode: 'save', initialDirectory: '/fixture', suggestedName: 'draft.txt' }, reportError });
  await settle();
  document.activeElement?.blur(); await settle();
  check(starts === 0, 'Neutral chooser never starts a theme subscription');
  check(host.save(outputPath(directory, 'neutral.png')), 'Save whole neutral chooser PNG without masks');
  const neutralPanel = neutral.element.firstChild, neutralBox = rect(neutralPanel);
  check(Number(neutralPanel.style.borderRadius) === 6 && Number(neutralPanel.style.padding) === 14 &&
    Number(neutralPanel.style.gap) === 10, 'Neutral chooser keeps explicit panel metrics');
  neutral.dispose(); await neutral.result; await settle();
  const longFile = put('/fixture/' + 'long-file-name-'.repeat(15) + '.txt');
  const link = put('/fixture/long-link', 'symlink', { linkTarget: '/fixture/' + 'long-directory/'.repeat(28) + 'target.txt',
    targetType: 'file', targetIdentity: 'target:1', targetError: null });

  const interval = globalThis.setInterval, clear = globalThis.clearInterval, token = {};
  globalThis.setInterval = (callback, ms) => { check(ms === 100, 'Only existing Files layout clock is controlled'); return token; };
  globalThis.clearInterval = id => { if (id !== token) clear(id); };
  const app = createFilesApp({ host: { create: () => parent, close() {} }, native, reportError });
  try {
    app.start(); await settle();
    const c = app.controller, find = id => document.getElementById('files-' + id);
    for (const id of ['server2003', 'xp', 'modern', 'aqua']) {
      await retheme(id);
      await click(find('new-folder'));
      const panel = find('confirmation'), input = find('name');
      check(host.save(outputPath(directory, 'files-' + id + '.png')), 'Save actual Files create panel');
      check(Number(panel.style.borderRadius) === current.window.radius,
        'Files dialog consumes theme shape: ' + id + ' expected ' + current.window.radius + ' actual ' + panel.style.borderRadius);
      check(Number(panel.style.padding) + Number(panel.style.borderWidth) === current.layout.contentPadding + current.layout.borderWidth &&
        panel.style.backgroundColor === current.colors.body,
        'Files dialog consumes theme spacing/surface: ' + id);
      contained(panel, document.body); contained(input, panel); contained(find('confirm'), panel);
      const dialogBox = rect(panel);
      input.focus(); host.key('a', 'keydown', { ctrlKey: true, text: false }); await settle();
      const selected = input.firstChild.childNodes.length;
      await retheme(id === 'aqua' ? 'server2003' : 'aqua');
      check(find('name') === input && document.activeElement === input && input.firstChild.childNodes.length === selected,
        'Files modal retheme preserves native input DOM/focus/selection');
      host.text('Folder-' + id); await settle();
      check(c.getState().dialog.name === 'Folder-' + id, 'Selected text is replaced at the original caret after retheme');
      await click(find('confirm'));
      check(operations.filter(op => op[0] === 'create' && op[1] === 'Folder-' + id).length === 1,
        'One native pointer confirmation creates exactly one bounded-memory folder');
      await retheme(id);
      const chosen = c.getState().snapshot.entries.find(item => item.path === '/fixture/old.txt');
      c.select(chosen.path, chosen.identity); await settle();
      host.key('F10', 'keydown', { shiftKey: true, text: false }); await settle();
      // The actual row owns ContextMenu; focus it before asking for its menu.
      if (!find('context')) {
        const row = Array.from(find('list').childNodes).find(node => node.getAttribute('data-path') === chosen.path);
        row.focus(); host.key('ContextMenu', 'keydown', { text: false }); await settle();
      }
      const menu = find('context');
      check(menu && Number(menu.style.borderRadius) === current.button.radius, 'Real Files context menu consumes theme radius');
      contained(menu, document.body); contained(find('context-open'), menu);
      const menuBox = rect(menu);
      check(host.save(outputPath(directory, 'context-' + id + '.png')), 'Save actual Files context panel');
      const oldAction = find('context-rename').__listeners.click;
      c.cancel(); await settle();
      oldAction({ button: 0, stopPropagation() {} });
      check(c.getState().dialog === null, 'Detached Files context callback cannot reopen a retired generation');
      c.select(longFile.path, longFile.identity); c.cut(); c.beginPaste(); await settle();
      contained(find('confirmation'), document.body);
      contained(find('confirm'), find('confirmation'));
      contained(find('operation-source'), find('confirmation'));
      check(find('operation-source').textContent === longFile.path, 'Long Files source path stays verbatim');
      const sourceViewport = rect(find('operation-source'));
      await scrollDetails(find('operation-source'), longFile.path, current.colors.focus);
      check(host.save(outputPath(directory, 'move-' + id + '.png')), 'Save actual long-path move review');
      await click(find('cancel')); c.clearCut(); await settle();
      c.select(link.path, link.identity); await c.open(); await settle();
      const linkPanel = find('confirmation');
      contained(linkPanel, document.body); contained(find('confirm'), linkPanel);
      contained(find('link-target'), linkPanel);
      await scrollDetails(find('link-target'), 'Target: ' + link.linkTarget, current.colors.focus);
      check(host.save(outputPath(directory, 'link-' + id + '.png')), 'Save actual long-target symlink review');
      await click(find('cancel'));
      c.select(longFile.path, longFile.identity); c.showOpenWith(); await settle();
      contained(find('confirmation'), document.body); contained(find('handler-0'), find('confirmation'));
      check(host.save(outputPath(directory, 'open-with-' + id + '.png')), 'Save actual MIME Open With panel');
      if (id === 'server2003') {
        await click(find('handler-0'));
        check(launches.length === 1 && launches[0][0] === '/fixture/editor' && launches[0][1] === longFile.path,
          'One actual handler action dispatches the literal path once to the bounded launcher fixture');
      } else await click(find('handler-cancel'));
      c.select(chosen.path, chosen.identity);
      c.beginRename(); await settle();
      check(find('confirmation').getAttribute('aria-modal') === 'false' &&
        !find('confirmation').childNodes.some(node => node.className === 'theme-bevel'),
        'Inline rename keeps its non-modal selection-root semantics');
      c.cancel(); await settle();
      samples.push({ id, dialog: dialogBox, menu: menuBox, radius: current.button.radius,
        sourceViewport, sourceTextWidth: measureText(longFile.path, 13) });
    }
  } finally { app.stop(); globalThis.setInterval = interval; globalThis.clearInterval = clear; }
  render(null, document.body); parent.closed = false;

  current = getDesktopTheme('server2003'); revision++;
  const chooser = showFileDialog({ parent, files, native, optInTheme: true,
    settings: { mode: 'save', initialDirectory: '/fixture', suggestedName: 'draft.txt' }, reportError });
  await settle();
  const panel = chooser.element.firstChild, input = document.getElementById(chooser.id + '-name');
  const themeStarts = starts;
  for (const id of ['server2003', 'xp', 'modern', 'aqua', 'server2003']) {
    input.focus(); host.key('a', 'keydown', { ctrlKey: true, text: false }); await settle();
    const selected = input.firstChild.childNodes.length;
    await retheme(id);
    check(Number(panel.style.borderRadius) === current.window.radius &&
      Number(panel.style.padding) + Number(panel.style.borderWidth) === current.layout.contentPadding + current.layout.borderWidth,
      'Opt-in chooser panel consumes current theme metrics: ' + id);
    check(document.getElementById(input.id) === input && document.activeElement === input &&
      input.firstChild.childNodes.length === selected, 'Chooser retheme keeps native input, caret and selection');
    check(starts === themeStarts, 'Retheme never starts another subscription');
    contained(panel, document.body); contained(input, panel);
    contained(document.getElementById(chooser.id + '-accept'), panel);
    check(host.save(outputPath(directory, 'chooser-' + id + '.png')), 'Save actual opt-in chooser panel');
    samples.push({ id, chooser: rect(panel) });
  }
  const location = document.getElementById(chooser.id + '-location');
  location.focus(); host.key('a', 'keydown', { ctrlKey: true, text: false }); host.text('/fixture/unfinished'); await settle();
  host.key('a', 'keydown', { ctrlKey: true, text: false }); await settle();
  const locationSelection = location.firstChild.childNodes.length;
  await retheme('xp');
  check(document.getElementById(location.id) === location && document.activeElement === location &&
    location.childNodes[1].firstChild.textContent === '/fixture/unfinished' &&
    location.firstChild.childNodes.length === locationSelection, 'Partial location DOM/value/caret selection survive retheme');
  const missing = '/missing/' + 'long-directory/'.repeat(28);
  host.text(missing.slice(0, -1)); host.key('Enter', 'keydown', { text: false }); await settle();
  const error = document.getElementById(chooser.id + '-error');
  check(error && error.textContent.includes('Missing fixture path'), 'Long-path navigation reports the original visible error');
  contained(error, panel); contained(document.getElementById(chooser.id + '-accept'), panel);
  await scrollDetails(error, chooser.controller.getState().error, current.colors.focus);
  check(host.save(outputPath(directory, 'chooser-long-error.png')), 'Save actual long-path chooser error');
  check(errors.length === 1 && errors[0].includes('ENOENT'), 'Expected missing path is reported exactly once');
  input.focus(); host.key('a', 'keydown', { ctrlKey: true, text: false });
  host.text('chosen.txt'); await settle();
  const retired = document.getElementById(chooser.id + '-accept');
  check(chooser.controller.getState().name === 'chosen.txt' && retired.getAttribute('aria-disabled') === 'false',
    'Native filename edit enables the original acceptance action: ' + JSON.stringify(chooser.controller.getState()));
  const oldAccept = retired.__listeners.click;
  let resolutions = 0; chooser.result.then(() => resolutions++);
  await click(retired);
  check(chooser.controller.getState().phase === 'finished',
    'Actual native confirmation reaches the terminal state: ' + JSON.stringify(chooser.controller.getState()));
  const result = await chooser.result;
  oldAccept({ button: 0, stopPropagation() {} }); chooser.dispose(); await settle();
  check(result.status === 'selected' && result.path === '/fixture/chosen.txt' && resolutions === 1,
    'Chooser returns one checked path and detached confirmation cannot settle twice');
  check(!document.getElementById(chooser.id), 'Chooser disposal removes the ordinary parent-owned modal');
  const cancel = showFileDialog({ parent, files, native, optInTheme: true, reportError });
  await settle(); host.key('Escape', 'keydown', { text: false }); await settle();
  check((await cancel.result).status === 'cancelled', 'Real Escape cancels themed chooser without a selected path');
  render(null, document.body);

  for (const id of ['server2003', 'xp', 'modern', 'aqua']) {
    const theme = getDesktopTheme(id), noop = () => {};
    render(settingsView(theme, noop, noop, noop, 'Fixture error: ' + 'a long status message '.repeat(8),
      true, null, null, null, null, null, null, true, 'Fixture status'), document.body);
    await settle();
    const root = document.getElementById('shell-settings');
    const status = root.childNodes.find(node => node.getAttribute('role') === 'status');
    const alert = root.childNodes.find(node => node.getAttribute('role') === 'alert');
    check(Number(status.style.borderRadius) === theme.button.radius && Number(alert.style.borderRadius) === theme.button.radius,
      'Settings status/error use card shape: ' + id);
    contained(alert, root); contained(document.getElementById('shell-retry'), alert);
    const message = alert.childNodes.find(node => node.textContent.startsWith('Fixture error:'));
    check(rect(message)[3] > 28, 'Settings error text wraps instead of escaping the card');
    document.getElementById('shell-retry').focus(); await settle();
    check(host.save(outputPath(directory, 'settings-' + id + '.png')), 'Save actual Settings error/status');
    const bindings = [{ action: 'fixture', label: 'Fixture shortcut', key: 'Tab', modifiers: ['Alt'] }];
    render(shortcutsView(theme, bindings, null, noop, noop, noop, noop), document.body); await settle();
    const change = document.getElementById('shell-shortcut-fixture'), card = change.parentNode.parentNode;
    check(Number(card.style.borderRadius) === theme.button.radius, 'Settings keyboard card consumes theme radius');
    change.focus(); await settle();
    host.key('Tab', 'keydown', { text: false });
    check(document.activeElement?.id === 'shell-shortcut-disable-fixture', 'Passive panel detail never enters native Tab order');
  }
  check(errors.length === 1, 'Only the deliberate missing-path probe reports an error: ' + JSON.stringify(errors));
  console.log('PANEL_CONSUMERS ' + JSON.stringify({ viewport: [host.width, host.height], neutralBox, samples,
    operations, launches, errors, subscriptions: starts, result, resolutions,
    scope: 'Production Files/chooser/Settings views, controllers and native GUI renderer/input; bounded memory FS only; scale 1; not OS reference pixels or physical/compositor input',
    longTokenBoundary: 'Readonly path/error viewports expose complete raw long tokens by wheel and Home/End; no claim of automatic long-token wrapping' }));
}
