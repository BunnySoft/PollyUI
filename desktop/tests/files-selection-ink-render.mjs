import { createFilesApp } from './desktop/apps/files/app.mjs';
import { getDesktopTheme } from './desktop/shared/ui/themes.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
const settle = async () => { for (let i = 0; i < 5; i++) { await Promise.resolve(); host.render(); } };
const box = node => { const r = node.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
export async function checkFilesSelectionInk(verify = true) {
  const entry = (path, type = 'file') => ({ path, type, name: path.split('/').at(-1), identity: path + ':1',
    bytes: 14, mtimeMs: 1700000000000, permissions: '0600', uid: 1000, gid: 1000, readable: true, writable: true });
  let records = [entry('/fixture/Folder', 'directory'), entry('/fixture/old.txt')];
  const operations = [];
  let theme = getDesktopTheme('server2003'), revision = 1;
  const fs = { version: 1, implementation: 'desktop-files-v1', overwrite: true, textObservation: 'sha256-v1', maxEntries: 1024, maxTextBytes: 1048576,
    locations: () => ({ home: '/fixture', documents: '/fixture', downloads: '/fixture', desktop: '/fixture' }),
    listDirectory: path => ({ version: 1, path, identity: path + ':1', complete: true, entries: records.map(item => ({ ...item })) }),
    stat: path => records.find(item => item.path === path) || entry(path, 'directory'),
    createDirectory(parent, name) { operations.push('create'); const item = entry(parent + '/' + name, 'directory'); records.push(item); return item; },
    rename(path, name) { operations.push('rename'); const item = entry('/fixture/' + name); records = records.map(value => value.path === path ? item : value); return item; },
    readText() { throw new Error('Unexpected read'); }, observeText() { throw new Error('Unexpected text read'); },
    writeText() { throw new Error('Unexpected write'); }, replaceText() { throw new Error('Unexpected replace'); } };
  const native = { fileSystem: fs, startThemeSubscription() {}, stopThemeSubscription() {},
    desktopThemeState: () => ({ available: true, ready: true, revision, document: JSON.stringify({ schemaVersion: 1, theme }) }) };
  const surface = { document, closed: false, close() { this.closed = true; this.onclose?.(); } };
  const interval = globalThis.setInterval, clear = globalThis.clearInterval, clock = {};
  // Keep only the existing Files layout clock controlled; input helpers drain real timers.
  globalThis.setInterval = (callback, ms) => { check(ms === 100, 'Only the existing Files clock is controlled'); return clock; };
  globalThis.clearInterval = token => { if (token !== clock) clear(token); };
  const app = createFilesApp({ host: { create: () => surface, close() {} }, native,
    reportError: message => { throw new Error(message); } });
  const rows = () => document.getElementById('files-list').childNodes.filter(node => node.getAttribute('role') === 'option');
  const byPath = path => rows().find(node => node.getAttribute('data-path') === path);
  const inks = node => ({ name: node.childNodes[0].childNodes[1].style.color,
    metadata: node.childNodes.slice(1).map(child => child.style.color), glyph: node.firstChild.firstChild.firstChild.style.borderColor,
    selected: node.getAttribute('aria-selected'), box: box(node) });
  const pixels = node => {
    const [x, y, width, height] = box(node), result = [];
    for (let dy = 0; dy < height; dy++) for (let dx = 0; dx < width; dx++) result.push(host.pixel(x + dx, y + dy));
    return result;
  };
  const pointer = async (node, type) => { const r = node.getBoundingClientRect(); host.mouse(type, r.x + r.width / 2, r.y + r.height / 2); await settle(); };
  const click = async node => { for (const type of ['mousedown', 'mouseup', 'click']) await pointer(node, type); };
  const update = async next => { theme = next; revision++; native.onDesktopThemeChanged(); await settle(); };
  try {
    app.start(); await settle();
    let row = byPath('/fixture/old.txt');
    const initial = inks(row), normalPixels = pixels(row), folderInitial = inks(byPath('/fixture/Folder'));
    await pointer(row, 'mousemove'); const hovered = inks(row);
    if (verify) check(hovered.name === theme.colors.selectionText && hovered.metadata.every(value => value === theme.colors.selectionText) &&
      hovered.glyph === theme.colors.selectionText, 'Actual hovered FileRow text, metadata and original monochrome art consume the same selection ink');
    host.mouse('mousemove', 1039, 759); await settle();
    check(JSON.stringify(inks(row)) === JSON.stringify(initial), 'Leave restores exact original FileRow per-part ink and geometry');
    check(JSON.stringify(pixels(row)) === JSON.stringify(normalPixels), 'Leave restores every pixel of the original unselected row');
    await click(row); const chosen = inks(row);
    if (verify) check(chosen.selected === 'true' && chosen.name === theme.colors.selectionText &&
      chosen.metadata.every(value => value === theme.colors.selectionText), 'Selected FileRow uses semantic text ink without changing selection truth');
    const custom = { ...getDesktopTheme('lion'), colors: { ...getDesktopTheme('lion').colors, selectionText: '#e040d0' } };
    await update(custom);
    const rethemed = inks(row);
    if (verify) check(byPath('/fixture/old.txt') === row && rethemed.name === '#e040d0' &&
      document.activeElement === row && rethemed.metadata.every(value => value === '#e040d0') &&
      rethemed.box.join(':') === initial.box.join(':'),
      'Same FileRow DOM/theme update preserves 42px geometry and repaints only the selected ink');
    const legacy = { ...theme, colors: { ...theme.colors } }; delete legacy.colors.selectionText;
    await update(legacy); const missing = inks(row);
    check(missing.name === theme.colors.text && missing.metadata.every(value => value === theme.colors.muted) &&
      missing.glyph === theme.colors.accent, 'A missing token preserves original selected-row name/metadata/glyph colors');
    await update(getDesktopTheme('server2003'));
    await click(byPath('/fixture/Folder'));
    const folderSelected = inks(byPath('/fixture/Folder'));
    if (verify) check(folderSelected.glyph === theme.colors.selectionText && folderInitial.glyph === '#b07816',
      'Directory fallback art uses selected ink but retains its explicit original unselected directory color');
    const file = records.find(item => item.path === '/fixture/old.txt');
    app.controller.select(file.path, file.identity); app.controller.beginRename(); await settle();
    const input = document.getElementById('files-name');
    await pointer(byPath(file.path), 'mousemove');
    check(inks(byPath('/fixture/Folder')).glyph === folderInitial.glyph,
      'Leaving a no-longer-selected directory restores its original directory-art ink');
    check(input.childNodes[1].style.color === theme.colors.text, 'Inline rename input is never recolored as row selection text');
    const modalGeneration = app.controller.getState().generation;
    await click(byPath(file.path));
    check(app.controller.getState().generation === modalGeneration && app.controller.getState().dialog.kind === 'rename' &&
      operations.length === 0, 'Modal-disabled FileRow business actions remain guarded while its visual ink follows selection');
    input.focus(); host.key('a', 'keydown', { ctrlKey: true, text: false }); host.text('renamed.txt'); await settle();
    await click(document.getElementById('files-confirm'));
    check(operations.filter(value => value === 'rename').length === 1, 'Actual inline rename keeps its existing single controller mutation');
    app.controller.beginCreate(); await settle();
    const name = document.getElementById('files-name'); name.focus();
    host.key('a', 'keydown', { ctrlKey: true, text: false }); host.text('Created'); await settle();
    await click(document.getElementById('files-confirm'));
    check(operations.join(':') === 'rename:create', 'Existing create/rename workflows and generation guards remain in use');
    console.log('FILES_SELECTION_INK ' + JSON.stringify({ verify, initial, hovered, chosen, rethemed, missing,
      folderInitial, folderSelected, operations, rowHeight: initial.box[3],
      scope: 'Actual Files factory/controller with bounded in-memory file service; no host filesystem operations' }));
  } finally { app.stop(); globalThis.setInterval = interval; globalThis.clearInterval = clear; document.activeElement?.blur(); }
}
