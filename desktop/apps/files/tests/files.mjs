import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
register('../../../tests/menu-host-loader.mjs', import.meta.url);
const { pathValue, childPath, parentPath, directorySnapshot, requireFileSystem, textObservation } = await import('../logic/model.mjs');
const { createFilesController } = await import('../logic/controller.mjs');
const { filesView } = await import('../ui/view.mjs');
const { createFilesApp } = await import('../app.mjs');
const { render } = await import('./gui/sdk/js/reconciler.mjs');
const { visibleEntries } = await import('../ui/format.mjs');
const { DESKTOP_THEMES } = await import('./desktop/shared/ui/themes.mjs');
const { panelAppearance } = await import('./desktop/shared/ui/panel-appearance.mjs');
// Source-only layout tests inject font metrics; native fixtures measure actual shaped text.
globalThis.measureText = value => String(value).length * 7;

const entry = (path, type = 'file', extra = {}) => ({ path, type, name: path.split('/').at(-1) || '/',
  identity: path + ':1', bytes: 6, mtimeMs: 1000, permissions: '0600', uid: 1000, gid: 1000,
  readable: true, writable: true, linkTarget: '', targetType: '', targetIdentity: '', targetError: null, ...extra });
function fixture() {
  const directories = new Map([['/fixture', [entry('/fixture/Documents', 'directory'),
    entry('/fixture/literal %u; 中文.txt'), entry('/fixture/unmanaged.app', 'directory')]],
  ['/fixture/Documents', []], ['/fixture/unmanaged.app', []]]);
  const operations = [], errors = [];
  const fs = {
    version: 1, implementation: 'desktop-files-v1', overwrite: true, textObservation: 'sha256-v1', maxEntries: 1024, maxTextBytes: 1048576,
    locations: () => ({ home: '/fixture', documents: '/fixture/Documents', downloads: '/fixture/Downloads', desktop: '/fixture/Desktop' }),
    listDirectory(path) {
      operations.push(['list', path]);
      if (!directories.has(path)) throw Object.assign(new Error('Folder denied'), { code: 'EACCES' });
      return { version: 1, path, identity: path + ':directory', entries: [...directories.get(path)], complete: true };
    },
    stat(path, follow) {
      operations.push(['stat', path, follow]);
      const found = [...directories.values()].flat().find(item => item.path === path);
      if (found) return { ...found };
      if (directories.has(path)) return entry(path, 'directory');
      throw Object.assign(new Error('Missing entry'), { code: 'ENOENT' });
    },
    createDirectory(parent, name, identity) {
      operations.push(['mkdir', parent, name, identity]);
      if (directories.get(parent).some(item => item.name === name))
        throw Object.assign(new Error('Existing destination'), { code: 'EEXIST' });
      const item = entry(childPath(parent, name), 'directory');
      directories.get(parent).push(item); directories.set(item.path, []); return item;
    },
    rename(path, name, identity, parentIdentity) {
      operations.push(['rename', path, name, identity, parentIdentity]);
      const entries = directories.get(parentPath(path)), index = entries.findIndex(item => item.path === path);
      const renamed = entry(childPath(parentPath(path), name), entries[index].type);
      entries[index] = renamed; return renamed;
    },
    moveFile: true,
    move(path, parent, name, identity, sourceParentIdentity, destinationIdentity) {
      operations.push(['move', path, parent, name, identity, sourceParentIdentity, destinationIdentity]);
      const source = directories.get(parentPath(path)), destination = directories.get(parent);
      const index = source.findIndex(item => item.path === path && item.identity === identity);
      if (index < 0) throw Object.assign(new Error('Source changed'), { code: 'ESTALE' });
      if (destination.some(item => item.name === name)) throw Object.assign(new Error('Name exists'), { code: 'EEXIST' });
      const moved = entry(childPath(parent, name));
      source.splice(index, 1); destination.push(moved); return moved;
    },
    readText() {}, observeText() {}, writeText() {}, replaceText() {},
  };
  const opened = [], launcher = {
    refresh: () => [], launch: async id => { opened.push(['launch', id]); },
    documentApplications: path => ({ mimeType: 'text/plain', defaultApplication: 'editor.desktop',
      applications: [{ id: 'editor.desktop', name: 'Editor', path }] }),
    openDocuments: async (paths, id) => { opened.push(['documents', paths, id]); },
  };
  const controller = createFilesController({ api: fs, launcher, reportError: value => errors.push(value) });
  return { controller, fs, directories, operations, opened, launcher, errors };
}
const select = (controller, path) => {
  const state = controller.getState(), item = state.snapshot.entries.find(item => item.path === path);
  assert.ok(item); assert.equal(controller.select(path, item.identity, state.generation), true);
  return item;
};
function flatten(node) {
  if (!node || typeof node !== 'object') return [];
  return [node, ...(node.children ?? []).flatMap(flatten)];
}

test('shared path/child/parent bounds preserve literal Unicode and reject traversal, NUL and malformed paths', () => {
  assert.equal(childPath('/fixture', '中文 %u; $(literal).txt'), '/fixture/中文 %u; $(literal).txt');
  assert.equal(parentPath('/fixture/file'), '/fixture'); assert.equal(parentPath('/'), '/');
  for (const value of ['//fixture', '/fixture/', '/fixture/../escape', '/fixture/./a', '/x\0y', 'relative',
    '/fixture/' + '中'.repeat(86), '/\ud800']) assert.throws(() => pathValue(value));
  for (const name of ['', '.', '..', 'a/b', 'x\0y', 'x'.repeat(256)]) assert.throws(() => childPath('/fixture', name));
});
test('overwrite observations require a strong bounded native identity, not metadata-only receipts', () => {
  const metadata = entry('/fixture/text.txt');
  const strong = { ...metadata, metadataIdentity: metadata.identity,
    identity: 'sha256:' + metadata.identity + ':' + 'a'.repeat(64) };
  assert.equal(textObservation(strong).identity, strong.identity);
  assert.throws(() => textObservation(metadata));
  assert.throws(() => textObservation({ ...strong, bytes: 1048577 }));
  assert.throws(() => textObservation({ ...strong, identity: 'sha256:' + metadata.identity + ':bad' }));
});
test('fresh native API requires exact implementation and explicit replaceText capability', () => {
  const { fs } = fixture(); assert.equal(requireFileSystem({ fileSystem: fs }), fs);
  for (const change of [{ version: 0 }, { overwrite: false }, { implementation: 'mock' }, { replaceText: null }])
    assert.throws(() => requireFileSystem({ fileSystem: { ...fs, ...change } }));
});
test('snapshot entry validation refuses unrelated paths, duplicate names and invalid metadata', () => {
  const snapshot = fixture().fs.listDirectory('/fixture', null);
  assert.equal(directorySnapshot(snapshot).entries[0].type, 'directory');
  for (const item of [entry('/else/file'), entry('/fixture/file', 'file', { bytes: -1 })])
    assert.throws(() => directorySnapshot({ ...snapshot, entries: [item] }));
  assert.throws(() => directorySnapshot({ ...snapshot, entries: [snapshot.entries[0], snapshot.entries[0]] }));
});
test('ordinary flow model navigates home, Documents, Up, Back, Forward and refresh without preselection', async () => {
  const { controller } = fixture();
  await controller.start(); assert.equal(controller.getState().selection, null);
  select(controller, '/fixture/Documents'); await controller.open();
  assert.equal(controller.getState().path, '/fixture/Documents');
  assert.equal(controller.getState().snapshot.entries.length, 0);
  await controller.back(); assert.equal(controller.getState().path, '/fixture');
  await controller.forward(); assert.equal(controller.getState().path, '/fixture/Documents');
  await controller.parent(); assert.equal(controller.getState().path, '/fixture');
  await controller.refresh(); assert.equal(controller.getState().selection, null);
});
test('denied folder is an explicit error, never empty successful folder', async () => {
  const { controller, errors } = fixture(); await controller.start('/fixture/Downloads');
  assert.equal(controller.getState().phase, 'error'); assert.equal(controller.getState().snapshot, null);
  assert.match(controller.getState().error, /EACCES/); assert.equal(errors.length, 1);
  const nodes = flatten(filesView(controller.getState(), controller));
  assert.ok(nodes.some(node => node.props?.id === 'files-error'));
  assert.ok(!nodes.some(node => node.props?.id === 'files-empty'));
});
test('new folder and rename require exact explicit confirmation; cancel performs no mutation', async () => {
  const { controller, operations } = fixture(); await controller.start();
  controller.beginCreate(); controller.editName('New folder'); controller.cancel();
  assert.equal(operations.filter(item => item[0] === 'mkdir').length, 0);
  controller.beginCreate(); controller.editName('New folder'); await controller.confirm();
  assert.equal(controller.getState().selection.name, 'New folder');
  controller.beginRename(); controller.editName('Renamed folder');
  assert.equal(operations.filter(item => item[0] === 'rename').length, 0);
  await controller.confirm();
  assert.equal(controller.getState().selection.name, 'Renamed folder');
  assert.deepEqual(operations.find(item => item[0] === 'rename').slice(1),
    ['/fixture/New folder', 'Renamed folder', '/fixture/New folder:1', '/fixture:directory']);
});
test('existing destination errors are visible and retain original list; no silent retry', async () => {
  const { controller, operations } = fixture(); await controller.start();
  controller.beginCreate(); controller.editName('Documents'); assert.equal(await controller.confirm(), false);
  assert.match(controller.getState().error, /EEXIST/); assert.equal(controller.getState().selection, null);
  assert.equal(operations.filter(item => item[0] === 'mkdir').length, 1);
});
test('Cut survives navigation; Paste reviews exact source/destination, cancels without mutation and moves once', async () => {
  const { controller, operations, directories } = fixture(); await controller.start();
  select(controller, '/fixture/literal %u; 中文.txt');
  assert.equal(controller.cut(), true);
  await controller.navigate('/fixture/Documents');
  controller.beginPaste();
  const stale = controller.getState().generation;
  const nodes = flatten(filesView(controller.getState(), controller));
  const source = nodes.find(node => node.props.id === 'files-operation-source');
  assert.equal(flatten(source).filter(node => node.type === '#text').map(node => node.props.nodeValue).join(''),
    '/fixture/literal %u; 中文.txt');
  controller.cancel(); assert.equal(operations.some(item => item[0] === 'move'), false);
  controller.beginPaste(); controller.editName('moved %u.txt');
  assert.equal(await controller.confirm(stale), false);
  assert.equal(await controller.confirm(), true);
  assert.equal(controller.getState().cut, null);
  assert.equal(controller.getState().selection.path, '/fixture/Documents/moved %u.txt');
  assert.equal(directories.get('/fixture').some(item => item.name.startsWith('literal')), false);
  assert.deepEqual(operations.find(item => item[0] === 'move').slice(1), [
    '/fixture/literal %u; 中文.txt', '/fixture/Documents', 'moved %u.txt',
    '/fixture/literal %u; 中文.txt:1', '/fixture:directory', '/fixture/Documents:directory',
  ]);
});
test('Cut/Paste refuses stale/denied/cross-device/colliding outcomes and clears intent without replay', async () => {
  for (const code of ['ESTALE', 'EACCES', 'EXDEV', 'EEXIST', 'EROFS']) {
    const { controller, fs, operations } = fixture(); await controller.start();
    select(controller, '/fixture/literal %u; 中文.txt'); controller.cut();
    await controller.navigate('/fixture/Documents'); controller.beginPaste();
    fs.move = () => { operations.push(['failed-move']); throw Object.assign(new Error(code), { code }); };
    assert.equal(await controller.confirm(), false);
    assert.match(controller.getState().error, new RegExp(code));
    assert.equal(controller.getState().cut, null);
    await controller.refresh();
    assert.equal(operations.filter(item => item[0] === 'failed-move').length, 1);
  }
});
test('Cut does not claim folder/link or old-runtime support; text input shortcuts remain text editing', async () => {
  const { controller, fs } = fixture(); await controller.start(); select(controller, '/fixture/Documents');
  assert.equal(controller.cut(), false); assert.match(controller.getState().error, /regular files only/);
  fs.moveFile = false;
  const older = createFilesController({ api: fs }); await older.start();
  select(older, '/fixture/literal %u; 中文.txt'); assert.equal(older.cut(), false);
  assert.equal(older.getState().moveAvailable, false);
});
test('stale selection/generation invalidates previous rename and entry row callbacks', async () => {
  const { controller, operations } = fixture(); await controller.start();
  const item = select(controller, '/fixture/literal %u; 中文.txt'), generation = controller.getState().generation;
  controller.beginRename(); controller.editName('must not rename'); await controller.refresh();
  assert.equal(await controller.confirm(generation), false);
  assert.equal(controller.select(item.path, item.identity, generation), false);
  assert.equal(await controller.open(generation, item.identity), false);
  assert.equal(operations.filter(item => item[0] === 'rename').length, 0);
});
test('file changed since selection is refused before MIME Open', async () => {
  const { controller, directories, opened } = fixture(); await controller.start();
  const item = select(controller, '/fixture/literal %u; 中文.txt');
  directories.get('/fixture')[1] = { ...item, identity: 'changed' };
  assert.equal(await controller.open(), false); assert.equal(opened.length, 0);
  assert.match(controller.getState().error, /changed/);
});
test('selection epochs distinguish different hard-link names with the same metadata identity', async () => {
  const { controller, directories, operations } = fixture();
  directories.get('/fixture').push(entry('/fixture/hard-a.txt', 'file', { identity: 'shared-inode' }),
    entry('/fixture/hard-b.txt', 'file', { identity: 'shared-inode' }));
  await controller.start(); select(controller, '/fixture/hard-a.txt');
  const old = controller.getState().generation;
  select(controller, '/fixture/hard-b.txt');
  assert.equal(controller.beginRename(old, 'shared-inode'), false);
  assert.equal(await controller.open(old, 'shared-inode'), false);
  assert.equal(operations.filter(item => item[0] === 'rename').length, 0);
});
test('stale double-click view callback cannot open the current equal-identity hard-link selection', async () => {
  const { controller, directories, operations, opened } = fixture();
  directories.get('/fixture').push(entry('/fixture/hard-a.txt', 'file', { identity: 'shared-inode' }),
    entry('/fixture/hard-b.txt', 'file', { identity: 'shared-inode' }));
  await controller.start(); select(controller, '/fixture/hard-a.txt');
  const oldState = controller.getState(), index = oldState.snapshot.entries.findIndex(item => item.path === '/fixture/hard-a.txt');
  const oldRow = flatten(filesView(oldState, controller)).find(node => node.props?.id === 'files-entry-' + index);
  select(controller, '/fixture/hard-b.txt');
  const current = controller.getState(), operationCount = operations.length;
  await oldRow.props.onDblclick();
  assert.equal(opened.length, 0);
  assert.equal(operations.length, operationCount);
  assert.equal(controller.getState().selection, current.selection);
  assert.equal(controller.getState().path, current.path);
  assert.equal(controller.getState().generation, current.generation);
  const newIndex = current.snapshot.entries.findIndex(item => item.path === '/fixture/hard-b.txt');
  const newRow = flatten(filesView(controller.getState(), controller))
    .find(node => node.props?.id === 'files-entry-' + newIndex);
  assert.equal(await newRow.props.onDblclick(), true);
  assert.deepEqual(opened, [['documents', ['/fixture/hard-b.txt'], 'editor.desktop']]);
});
test('stale arrow view callback cannot page a new directory after failed captured-epoch selection', async () => {
  const { controller, fs, operations } = fixture(), list = fs.listDirectory;
  fs.listDirectory = path => ({ ...list(path), entries: Array.from({ length: 130 }, (_, index) =>
    entry(path + '/entry-' + String(index).padStart(3, '0'))) });
  await controller.start();
  select(controller, controller.getState().snapshot.entries[63].path);
  const oldTree = filesView(controller.getState(), controller);
  await controller.navigate('/fixture/Documents');
  const current = controller.getState(), operationCount = operations.length;
  oldTree.props.onKeydown({ key: 'ArrowDown', preventDefault() {} });
  assert.equal(controller.getState().selection, null);
  assert.equal(controller.getState().path, current.path);
  assert.equal(controller.getState().generation, current.generation);
  assert.equal(operations.length, operationCount);
  const selected = select(controller, controller.getState().snapshot.entries[63].path);
  filesView(controller.getState(), controller).props.onKeydown({ key: 'ArrowDown', preventDefault() {} });
  assert.equal(controller.getState().selection.path, '/fixture/Documents/entry-064');
  assert.notEqual(controller.getState().selection.path, selected.path);
});
test('cancelled confirmation and name callbacks cannot operate on a reopened dialog', async () => {
  const { controller, operations } = fixture(); await controller.start();
  controller.beginCreate(); controller.editName('Cancelled folder');
  const old = controller.getState().generation; controller.cancel();
  controller.beginCreate(); controller.editName('Current folder');
  assert.equal(controller.editName('Retired name', old), false);
  assert.equal(controller.cancel(old), false);
  assert.equal(await controller.confirm(old), false);
  assert.equal(operations.filter(item => item[0] === 'mkdir').length, 0);
  assert.equal(controller.getState().dialog.name, 'Current folder');
  assert.equal(await controller.confirm(), true);
  assert.equal(controller.getState().selection.name, 'Current folder');
});
test('MIME opening passes literal path into existing launcher and Open With uses actual available handler ID', async () => {
  const { controller, opened } = fixture(); await controller.start();
  const item = select(controller, '/fixture/literal %u; 中文.txt');
  assert.equal(await controller.open(), true);
  assert.deepEqual(opened[0], ['documents', [item.path], 'editor.desktop']);
  controller.showOpenWith(); assert.equal(controller.getState().openWith.mimeType, 'text/plain');
  assert.equal(await controller.openWith('unavailable.desktop'), false);
  assert.equal(await controller.openWith('editor.desktop'), true);
});
test('unknown MIME/OpenWith is visible and has no arbitrary command fallback', async () => {
  const { controller, launcher, opened } = fixture();
  launcher.documentApplications = () => { throw new Error('No available document handler for unknown/type'); };
  await controller.start(); select(controller, '/fixture/literal %u; 中文.txt');
  assert.equal(await controller.open(), false); assert.equal(controller.getState().phase, 'ready');
  assert.match(controller.getState().error, /Open With.*No available/); assert.equal(opened.length, 0);
});
test('.app extension alone is only a folder; actual registry path is managed app and cannot be renamed', async () => {
  const { controller, launcher, opened } = fixture(); await controller.start();
  select(controller, '/fixture/unmanaged.app'); await controller.open();
  assert.equal(controller.getState().path, '/fixture/unmanaged.app'); assert.equal(opened.length, 0);
  launcher.refresh = () => [{ id: 'bundle:org.example.notes', path: '/fixture/unmanaged.app', name: 'Notes' }];
  await controller.start('/fixture'); select(controller, '/fixture/unmanaged.app');
  assert.equal(controller.beginRename(), false); assert.match(controller.getState().error, /application manager/);
  await controller.open(); assert.deepEqual(opened[0], ['launch', 'bundle:org.example.notes']);
});
test('symlink follow is an explicit action, validates target identity and does not claim ownership', async () => {
  const { controller, directories, fs, operations } = fixture();
  const link = entry('/fixture/folder link', 'symlink', { linkTarget: 'Documents', targetType: 'directory',
    targetIdentity: '/fixture/Documents:1', readable: false, writable: false });
  directories.get('/fixture').push(link);
  const stat = fs.stat; fs.stat = (path, follow) => path === link.path && follow ? entry('/fixture/Documents', 'directory') : stat(path, follow);
  await controller.start(); select(controller, link.path); await controller.open();
  assert.equal(controller.getState().dialog.kind, 'link'); assert.equal(controller.getState().path, '/fixture');
  assert.equal(operations.filter(item => item[0] === 'list').length, 1);
  await controller.confirm(); assert.equal(controller.getState().path, '/fixture/Documents');
});
test('changed managed registry cannot launch a different version from the selected package path', async () => {
  const { controller, launcher, opened } = fixture();
  launcher.refresh = () => [{ id: 'bundle:org.example.notes', path: '/fixture/unmanaged.app', name: 'Notes' }];
  await controller.start(); select(controller, '/fixture/unmanaged.app');
  launcher.refresh = () => [{ id: 'bundle:org.example.notes', path: '/fixture/new-version.app', name: 'Notes v2' }];
  assert.equal(await controller.open(), false); assert.equal(opened.length, 0);
  assert.match(controller.getState().error, /version changed.*Refresh/);
  await controller.refresh(); assert.equal(controller.getState().applications[0].path, '/fixture/new-version.app');
});
test('partial snapshot stays labelled and continuously scrolls all loaded rows without pagination', async () => {
  const { controller, fs } = fixture(), list = fs.listDirectory;
  fs.listDirectory = path => ({ ...list(path), complete: false,
    entries: Array.from({ length: 130 }, (_, index) => entry('/fixture/entry-' + index)) });
  await controller.start();
  let tree = filesView(controller.getState(), controller), nodes = flatten(tree);
  assert.ok(nodes.some(node => node.props?.id === 'files-partial'));
  assert.equal(nodes.filter(node => node.props?.role === 'option').length, 130);
  assert.equal(typeof nodes.find(node => node.props?.id === 'files-list').props.onWheel, 'function');
  tree.props.onKeydown({ key: 'ArrowDown', preventDefault() {} });
  assert.ok(controller.getState().selection);
  assert.ok(!nodes.some(node => node.props?.id === 'files-page-next'));
});
test('native Files viewport uses supported flex dimensions so rows do not expand the window', async () => {
  const { controller } = fixture(); await controller.start();
  const tree = filesView(controller.getState(), controller), nodes = flatten(tree);
  const list = nodes.find(node => node.props?.id === 'files-list');
  const viewport = nodes.find(node => node.props?.id === 'files-viewport');
  assert.equal(viewport.props.style.flexGrow, 1);
  assert.equal(viewport.props.style.flexBasis, 0);
  assert.equal(viewport.props.style.flexShrink, 1);
  assert.equal(viewport.props.style.minHeight, 100);
  assert.equal(viewport.props.style.overflow, 'hidden');
  assert.equal(list.props.style.flexGrow, 1);
  assert.equal(list.props.style.flexBasis, 0);
  assert.equal(list.props.style.minWidth, 0);
  assert.equal(list.props.style.minHeight, 0);
  assert.equal(list.props.style.overflow, 'scroll');
  assert.equal(tree.props.style.overflow, 'hidden');
  assert.ok(nodes.every(node => !Object.hasOwn(node.props?.style ?? {}, 'flex')));
  const footer = nodes.find(node => node.props?.id === 'files-status');
  assert.equal(footer.props.style.flexShrink, 0);
});
test('Files reuses shared theme surfaces for every modal kind, context and breadcrumbs; inline rename stays unframed', async () => {
  for (const theme of DESKTOP_THEMES) {
    const { controller } = fixture(); await controller.start();
    const tree = () => flatten(filesView(controller.getState(), controller, { theme }));
    const find = id => tree().find(node => node.props?.id === id);
    const appearance = (node, variant) => {
      for (const [key, value] of Object.entries(panelAppearance(theme, variant)))
        if (key !== 'position' && key !== 'gap') assert.equal(node.props.style[key], value, theme.id + ':' + variant + ':' + key);
      assert.equal(node.children.some(child => child.props?.className === 'theme-bevel'),
        theme.button.surfaceStyle === 'classic');
    };
    appearance(find('files-breadcrumbs'), 'inset');
    controller.beginCreate(); appearance(find('files-confirmation'), 'dialog'); controller.cancel();
    const chosen = select(controller, '/fixture/literal %u; 中文.txt');
    controller.showContext(chosen.path, chosen.identity, 20, 20);
    appearance(find('files-context'), 'menu'); controller.cancel();
    controller.showOpenWith(); appearance(find('files-confirmation'), 'dialog'); controller.cancel();
    controller.cut(); controller.beginPaste(); appearance(find('files-confirmation'), 'dialog'); controller.cancel();
    controller.beginRename();
    const inline = find('files-confirmation');
    assert.equal(inline.props['aria-modal'], 'false');
    assert.equal(inline.props.style.position, undefined);
    assert.equal(inline.children.some(child => child.props?.className === 'theme-bevel'), false);
  }
});
test('column sorting and folder-local filtering preserve exact identities and retire old row/context callbacks', async () => {
  const { controller, operations } = fixture(); await controller.start();
  const chosen = select(controller, '/fixture/literal %u; 中文.txt');
  const stale = flatten(filesView(controller.getState(), controller)).find(node => node.props?.id === 'files-rename');
  const initial = controller.getState();
  assert.equal(controller.sortBy('size'), true);
  assert.equal(controller.getState().selection.identity, chosen.identity);
  assert.equal(controller.getState().sort.direction, 1);
  controller.sortBy('size'); assert.equal(controller.getState().sort.direction, -1);
  assert.equal(visibleEntries(controller.getState())[0].type, 'directory', 'folders always precede files');
  stale.props.onClick({ button: 0, stopPropagation() {} });
  assert.equal(controller.getState().dialog, null);
  assert.equal(controller.filter('中文'), true);
  assert.equal(visibleEntries(controller.getState()).length, 1);
  assert.equal(controller.getState().snapshot, initial.snapshot, 'filter never performs another filesystem search');
  assert.equal(controller.getState().selection.identity, chosen.identity);
  controller.showContext(chosen.path, chosen.identity, 20, 20);
  const menu = flatten(filesView(controller.getState(), controller)).find(node => node.props?.id === 'files-context-rename');
  controller.filter('Documents');
  assert.equal(controller.getState().selection, null, 'hidden selection cannot remain an actionable target');
  menu.props.onClick({ button: 0, stopPropagation() {} });
  assert.equal(controller.getState().dialog, null);
  assert.equal(operations.filter(item => item[0] === 'rename').length, 0);
});
test('overlay scrollbar preserves continuous list and metadata widths at normal and narrow sizes', async () => {
  const { controller } = fixture(); await controller.start();
  for (const width of [1040, 680, 640]) {
    const nodes = flatten(filesView(controller.getState(), controller, { width, height: 540 }));
    const region = nodes.find(node => node.props?.id === 'files-list-region');
    const list = nodes.find(node => node.props?.id === 'files-list');
    const rail = nodes.find(node => node.props?.id === 'files-scrollbar');
    assert.deepEqual(region.children.map(node => node.props.id), ['files-list', 'files-scrollbar']);
    assert.equal(rail.props.style.position, 'absolute'); assert.equal(rail.props.style.width, 10);
    assert.equal(rail.props['aria-controls'], 'files-list');
    assert.equal(list.props.style.padding, 4);
    assert.ok(!Object.hasOwn(list.props.style, 'paddingRight'));
    const row = nodes.find(node => node.props?.id === 'files-entry-0');
    assert.deepEqual(row.children.map(node => node.props.style.width), ['44%', '23%', '21%', '12%']);
    assert.equal(nodes.filter(node => node.props?.id?.startsWith('files-entry-')).length, visibleEntries(controller.getState()).length);
  }
});
test('keyboard movement follows the sorted filtered rows, address mode and inline rename do not swallow input keys', async () => {
  const { controller } = fixture(); await controller.start();
  controller.filter('中文');
  filesView(controller.getState(), controller).props.onKeydown({ key: 'ArrowDown', preventDefault() {} });
  assert.equal(controller.getState().selection.name, 'literal %u; 中文.txt');
  const generation = controller.getState().generation;
  filesView(controller.getState(), controller).props.onKeydown({
    key: 'ArrowUp', target: { id: 'files-filter' }, preventDefault() { throw new Error('input key swallowed'); } });
  assert.equal(controller.getState().generation, generation);
  filesView(controller.getState(), controller).props.onKeydown({ key: 'F2', preventDefault() {} });
  const nodes = flatten(filesView(controller.getState(), controller));
  assert.ok(nodes.find(node => node.props?.id === 'files-entry-0').children
    .some(node => flatten(node).some(child => child.props?.id === 'files-name')));
  assert.equal(nodes.find(node => node.props?.id === 'files-confirmation').props['aria-modal'], 'false');
  controller.cancel(); controller.editAddress();
  controller.editAddress('/fixture/Documents');
  await filesView(controller.getState(), controller).props.onKeydown({
    key: 'Enter', target: { id: 'files-address' }, preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.getState().path, '/fixture/Documents');
});
test('native Files wheel scroll clamps bounded viewport using absolute unscrolled child geometry', async () => {
  const { controller } = fixture(); await controller.start();
  const list = flatten(filesView(controller.getState(), controller)).find(node => node.props?.id === 'files-list');
  const node = { offsetTop: 135, offsetHeight: 450, scrollTop: 0,
    childNodes: [{ offsetTop: 135, offsetHeight: 60 }, { offsetTop: 3955, offsetHeight: 60 }] };
  let prevented = 0;
  const wheel = deltaY => list.props.onWheel({ currentTarget: node, deltaY, preventDefault() { prevented++; } });
  wheel(180); assert.equal(node.scrollTop, 180);
  wheel(10000); assert.equal(node.scrollTop, 3430);
  wheel(-10000); assert.equal(node.scrollTop, 0);
  node.childNodes = []; wheel(180); assert.equal(node.scrollTop, 0);
  assert.equal(prevented, 4);
});
test('fixture close marker follows persisted callback receipt without needing a later timer', () => {
  const source = readFileSync(new URL('../../../tests/files-window-client.mjs', import.meta.url), 'utf8');
  const handler = source.slice(source.indexOf('const surface = app.getWindow(), originalClose = surface.onclose;'),
    source.indexOf('const timer = setInterval('));
  assert.ok(handler.includes('surface.onclose = () =>'));
  for (const mode of ['success', 'write-failure', 'no-driver-close', 'drive-failed', 'incomplete-captures']) {
    const calls = [], evidence = { actualAction: true }, captures = mode === 'incomplete-captures' ? [] : ['actual.png'];
    const surface = { onclose() { calls.push('original-close'); } };
    const context = { app: { getWindow: () => surface, controller: { getState: () => ({ phase: 'disposed' }) } },
      evidence, captures, interactionSamples: [], captureStages: ['only-stage'], mode: '--drive', driving: true, details: false, flow: 'browser',
      closingViaDriver: mode !== 'no-driver-close',
      driveFailed: mode === 'drive-failed', root: '/tmp/polly-files-window-unit', renamedName: 'New folde',
      console: { log(message) { calls.push(message); }, error(message) { calls.push(message); } },
      api: { stat() { return { identity: 'parent-observation' }; }, writeText(parent, name, text, expected) {
        calls.push('write-receipt');
        assert.equal(parent, context.root); assert.equal(name, 'files-window-result.json');
        assert.equal(expected, 'parent-observation'); assert.equal(JSON.parse(text).closeObserved, true);
        if (mode === 'write-failure') throw new Error('Private write failed');
      } } };
    runInNewContext(handler, context);
    surface.onclose();
    assert.equal(calls[0], 'original-close');
    const passed = calls.some(call => call.startsWith('FILES_WINDOW_CLOSE_PASS:'));
    assert.equal(passed, mode === 'success');
    if (passed) assert.equal(calls[1], 'write-receipt');
    if (mode === 'write-failure') assert.ok(calls.some(call => call.startsWith('FILES_WINDOW_FAIL:')));
    if (['no-driver-close', 'drive-failed', 'incomplete-captures'].includes(mode))
      assert.ok(!calls.includes('write-receipt'));
  }
});
test('late navigation reply and close cannot resurrect a retired snapshot', async () => {
  const { controller, fs } = fixture(), list = fs.listDirectory;
  let resolve; fs.listDirectory = () => new Promise(yes => { resolve = yes; });
  const pending = controller.start(); await Promise.resolve();
  fs.listDirectory = list; await controller.navigate('/fixture/Documents');
  resolve(list('/fixture')); await pending;
  assert.equal(controller.getState().path, '/fixture/Documents');
  let resolveClose; fs.listDirectory = () => new Promise(yes => { resolveClose = yes; });
  const closing = controller.refresh(); controller.dispose(); resolveClose(list('/fixture/Documents')); await closing;
  assert.equal(controller.getState().phase, 'disposed'); assert.equal(controller.getState().snapshot, null);
});
test('app lifecycle rejects missing/old native API visibly and allows a fresh reopened instance', async () => {
  const surfaces = [], host = { create() {
    const surface = { closed: false, document: { body: null }, close() { this.closed = true; } };
    surfaces.push(surface); return surface;
  }, close() {} };
  // Lifecycle stop is independent of a rendering engine; native window proof is a separate fixture.
  const missing = createFilesApp({ host, native: null, optInTheme: false, reportError() {} });
  missing.stop(); assert.equal(missing.controller.getState().phase, 'disposed');
  assert.throws(() => missing.start(), /cannot restart/);
  const fresh = createFilesApp({ host, native: { fileSystem: fixture().fs }, optInTheme: false });
  fresh.stop(); assert.equal(fresh.controller.getState().phase, 'disposed');
});

test('actual reconciler dispatches injected pointer/key/textinput browser actions and preserves old-row invalidation', async t => {
  class Node {
    constructor(owner) {
      this.ownerDocument = owner; this.childNodes = []; this.style = {}; this.listeners = new Map();
      this.parentNode = null; this.id = ''; this.scrollTop = 0;
    }
    get firstChild() { return this.childNodes[0] ?? null; }
    appendChild(node) { return this.insertBefore(node, null); }
    insertBefore(node, before) {
      node.parentNode?.removeChild(node); node.parentNode = this;
      this.childNodes.splice(before ? this.childNodes.indexOf(before) : this.childNodes.length, 0, node); return node;
    }
    removeChild(node) { this.childNodes.splice(this.childNodes.indexOf(node), 1); node.parentNode = null; return node; }
    setAttribute(key, value) { this[key] = value; }
    getAttribute(key) { return Object.hasOwn(this, key) ? String(this[key]) : null; }
    removeAttribute(key) { delete this[key]; }
    querySelectorAll(selector) {
      const matches = node => selector.startsWith('.') ? (node.className || '').split(' ').includes(selector.slice(1)) :
        selector.startsWith('#') ? node.id === selector.slice(1) : false;
      const collect = node => node.childNodes.flatMap(child => [...(matches(child) ? [child] : []), ...collect(child)]);
      return collect(this);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    addEventListener(key, callback) { this.listeners.set(key, [...(this.listeners.get(key) ?? []), callback]); }
    removeEventListener(key, callback) { this.listeners.set(key, (this.listeners.get(key) ?? []).filter(item => item !== callback)); }
    fire(type, extra = {}) {
      for (const callback of [...(this.listeners.get(type) ?? [])])
        callback({ target: this, currentTarget: this, button: 0, preventDefault() {}, stopPropagation() {}, ...extra });
    }
  }
  const oldDocument = globalThis.document;
  const oldMeasureText = globalThis.measureText;
  globalThis.measureText = value => value.length * 7;
  const document = { createElement() { return new Node(document); },
    createTextNode(text) { return Object.assign(new Node(document), { textContent: text }); },
    getElementById(id) {
      const find = node => node.id === id ? node : node.childNodes.map(find).find(Boolean);
      return find(document.body);
    } };
  document.body = new Node(document); globalThis.document = document;
  t.after(() => { globalThis.document = oldDocument; globalThis.measureText = oldMeasureText; });
  const { fs, operations } = fixture();
  const controller = createFilesController({ api: fs, onChange: () =>
    render(filesView(controller.getState(), controller), document.body), reportError() {} });
  t.after(() => controller.dispose());
  await controller.start();
  const oldRow = document.getElementById('files-entry-0'), oldClick = oldRow.listeners.get('click')[0];
  oldRow.fire('click'); document.getElementById('files-open').fire('click');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.getState().path, '/fixture/Documents');
  oldClick({ button: 0, stopPropagation() {} });
  assert.equal(controller.getState().selection, null);
  document.getElementById('files-parent').fire('keydown', { key: 'Enter' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.getState().path, '/fixture');
  document.getElementById('files-new-folder').fire('click');
  assert.equal(controller.getState().dialog.name, 'New folder');
  document.getElementById('files-name').fire('keydown', { key: 'a', ctrlKey: true });
  document.getElementById('files-name').fire('textinput', { data: 'New folder' });
  assert.equal(controller.getState().dialog.name, 'New folder');
  document.getElementById('files-confirm').fire('click');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.getState().selection.name, 'New folder');
  assert.equal(operations.filter(item => item[0] === 'mkdir').length, 1);
  document.getElementById('files-rename').fire('click');
  document.getElementById('files-cancel').fire('click');
  assert.equal(controller.getState().dialog, null);
  assert.equal(operations.filter(item => item[0] === 'rename').length, 0);
});
