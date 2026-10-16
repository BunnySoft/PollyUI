import { createFilesApp } from './desktop/apps/files/app.mjs';
import { filesView } from './desktop/apps/files/ui/view.mjs';
import { showFileDialog } from './desktop/client/file-dialog.mjs';
import { render } from './gui/sdk/js/reconciler.mjs';
import { getDesktopTheme } from './desktop/shared/ui/themes.mjs';
import { NInput } from './gui/sdk/js/naive.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
const settle = async () => { for (let i = 0; i < 4; i++) { await Promise.resolve(); host.render(); } };
const appearance = root => ({ focus: root.style['focus:borderColor'], radius: Number(root.style.borderRadius),
  fontSize: Number(root.childNodes[1].style.fontSize), color: root.childNodes[1].style.color,
  padding: Number(root.style.paddingLeft) });
export async function checkCommonFileInputs() {
  for (const fontSize of [7, 65, NaN, '14']) {
    let invalid = false;
    try { NInput({ fontSize }); } catch (error) { invalid = error instanceof RangeError; }
    check(invalid, 'Fallback font metric rejects invalid values through the SDK contract');
  }
  const entry = (path, type) => ({ path, type, name: path.split('/').at(-1), identity: path + ':1',
    bytes: 0, mtimeMs: 0, permissions: '0600', uid: 1000, gid: 1000, readable: true, writable: true });
  let file = entry('/fixture/old.txt', 'file'), current = getDesktopTheme('server2003'), themeRevision = 1, renames = 0, subscriptionStarts = 0;
  const fs = { version: 1, implementation: 'desktop-files-v1', overwrite: true, textObservation: 'sha256-v1', maxEntries: 1024, maxTextBytes: 1048576,
    locations: () => ({ home: '/fixture', documents: '/fixture', downloads: '/fixture', desktop: '/fixture' }),
    listDirectory: path => ({ version: 1, path, identity: path + ':1', entries: [file], complete: true }),
    stat: path => {
      if (path === file.path) return { ...file };
      if (path === '/fixture') return entry(path, 'directory');
      throw Object.assign(new Error('Missing fixture path'), { code: 'ENOENT' });
    },
    rename(path, name) { check(path === file.path, 'Original rename target identity remains available'); renames++;
      file = entry('/fixture/' + name, 'file'); return file; },
    createDirectory() { throw new Error('Unexpected directory creation'); },
    readText() { throw new Error('Unexpected file read'); }, observeText() { throw new Error('Unexpected text observation'); },
    writeText() { throw new Error('Unexpected write'); }, replaceText() { throw new Error('Unexpected overwrite'); } };
  const native = { fileSystem: fs, startThemeSubscription() { subscriptionStarts++; }, stopThemeSubscription() {},
    desktopThemeState: () => ({ available: true, ready: true, revision: themeRevision,
      document: JSON.stringify({ schemaVersion: 1, theme: current }) }) };
  const surface = { document, closed: false, close() { this.closed = true; this.onclose?.(); } };
  // Production Files has a continuing 100ms layout timer; keep its clock controlled because host input drains timers.
  const interval = globalThis.setInterval, clear = globalThis.clearInterval, token = {};
  globalThis.setInterval = (callback, ms) => { check(ms === 100, 'Only existing Files layout clock is controlled'); return token; };
  globalThis.clearInterval = id => { if (id !== token) clear(id); };
  const app = createFilesApp({ host: { create: () => surface, close() {} }, native,
    reportError: message => { throw new Error(message); } });
  const retheme = async id => { current = getDesktopTheme(id); themeRevision++; native.onDesktopThemeChanged(); await settle(); };
  let filesResult;
  try {
    app.start(); await settle();
    const filter = document.getElementById('files-filter'), first = appearance(filter);
    check(first.radius === current.button.radius && first.fontSize === current.layout.sectionFontSize &&
      first.focus === current.colors.focus && first.padding === 9, 'Real Files native input consumes complete theme fields');
    filter.focus(); host.text('old'); host.key('a', 'keydown', { ctrlKey: true, text: false }); await settle();
    const highlightBefore = filter.firstChild.childNodes.length;
    await retheme('modern');
    check(document.getElementById(filter.id) === filter && document.activeElement === filter &&
      filter.childNodes[1].firstChild.textContent === 'old' && filter.firstChild.childNodes.length === highlightBefore,
      'Files same input/focus/content/selection survive retheme');
    app.controller.filter(''); await settle();
    app.controller.select(file.path, file.identity); app.controller.beginRename(); await settle();
    const name = document.getElementById('files-name');
    name.focus(); host.key('a', 'keydown', { ctrlKey: true, text: false }); host.text('new.txt'); await settle();
    const confirm = document.getElementById('files-confirm').getBoundingClientRect();
    host.mouse('mousedown', confirm.x + confirm.width / 2, confirm.y + confirm.height / 2);
    host.mouse('mouseup', confirm.x + confirm.width / 2, confirm.y + confirm.height / 2);
    host.mouse('click', confirm.x + confirm.width / 2, confirm.y + confirm.height / 2); await settle();
    check(renames === 1 && file.name === 'new.txt', 'Actual Files edit and one confirmation retain rename controller contract');
    const state = app.controller.getState();
    render(null, document.body);
    render(filesView(state, app.controller, { theme: current }), document.body); host.render();
    const fallback = document.getElementById('files-filter');
    check(Number(fallback.style.borderRadius) === current.button.radius && fallback.style['focus:borderColor'] === current.colors.focus &&
      fallback.childNodes.some(node => Number(node.style.fontSize) === current.layout.sectionFontSize),
      'Files fallback NInput uses the same legal theme font/focus/radius mapping');
    filesResult = { first, rethemed: { radius: current.button.radius, fontSize: current.layout.sectionFontSize },
      renames, sameDOM: true, selectedRangesPreserved: true, fallbackChecked: true };
  } finally { app.stop(); globalThis.setInterval = interval; globalThis.clearInterval = clear; }
  render(null, document.body); surface.closed = false;
  const starts = subscriptionStarts;
  const neutral = showFileDialog({ parent: surface, files: fs, native, optInTheme: false, settings: { mode: 'save', initialDirectory: '/fixture', suggestedName: 'draft.txt' },
    reportError: message => { throw new Error(message); } });
  await settle();
  const neutralName = document.getElementById(neutral.id + '-name'), neutralAppearance = appearance(neutralName);
  check(neutralAppearance.fontSize === 14 && neutralAppearance.radius === 6 && neutralAppearance.focus === '#2563eb' &&
    subscriptionStarts === starts, 'Non-opt-in file dialog preserves explicit neutral defaults and does not subscribe');
  neutral.controller.cancel('fixture'); await neutral.result; await settle();
  current = getDesktopTheme('server2003'); themeRevision++;
  const dialog = showFileDialog({ parent: surface, files: fs, native, optInTheme: true,
    settings: { mode: 'save', initialDirectory: '/fixture', suggestedName: 'draft.txt' }, reportError: message => { throw new Error(message); } });
  await settle();
  const filename = document.getElementById(dialog.id + '-name'), themedFirst = appearance(filename);
  check(themedFirst.radius === current.button.radius && themedFirst.fontSize === current.layout.sectionFontSize &&
    themedFirst.focus === current.colors.focus, 'Both actual chooser inputs use full opt-in theme metrics');
  filename.focus(); host.key('a', 'keydown', { ctrlKey: true, text: false }); await settle();
  const selected = filename.firstChild.childNodes.length;
  await retheme('xp');
  check(document.getElementById(filename.id) === filename && document.activeElement === filename &&
    filename.firstChild.childNodes.length === selected, 'File dialog retheme keeps input DOM, focus, value selection');
  host.text('chosen.txt'); await settle();
  const accept = document.getElementById(dialog.id + '-accept').getBoundingClientRect();
  host.mouse('mousedown', accept.x + accept.width / 2, accept.y + accept.height / 2);
  host.mouse('mouseup', accept.x + accept.width / 2, accept.y + accept.height / 2);
  host.mouse('click', accept.x + accept.width / 2, accept.y + accept.height / 2); await settle();
  const result = await dialog.result;
  check(result.status === 'selected' && result.path === '/fixture/chosen.txt', 'Actual chooser input and one callback return the original selected-path contract');
  console.log('COMMON_FILES_INPUT ' + JSON.stringify({ files: filesResult, neutral: neutralAppearance,
    chooser: { first: themedFirst, sameDOM: true, selection: true, result: result.status },
    scope: 'Real Files/chooser consumers and controllers with bounded in-memory file service; no host FS mutation' }));
}
