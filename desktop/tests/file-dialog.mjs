import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

register('./root-loader.mjs', import.meta.url);
const { fixtureFiles, fixtureHost, deliver, settled, deferred, nodes } = await import('./file-dialog-fixtures.mjs');
const { createFileDialogController } = await import('../client/file-dialog-controller.mjs');
const { showFileDialog } = await import('../client/file-dialog.mjs');
const { createFileTextApp } = await import('../client/file-dialog-example.mjs');
const HOME = '/home/polly', EXISTING = HOME + '/hello.txt';
const textFilters = [{ label: 'Text', extensions: ['txt', 'md'] }, { label: 'All', extensions: [] }];
function controller(options = {}) {
  const f = fixtureFiles(), results = [], errors = [];
  const c = createFileDialogController({ files: f.files, onFinish: value => results.push(value),
    reportError: message => errors.push(message), ...options });
  return { ...f, c, results, errors };
}
function findChoice(handle, name) {
  return nodes(handle.element).find(node => node.getAttribute?.('aria-label')?.endsWith(name));
}
function find(handle, suffix) { return handle.element.ownerDocument.getElementById(handle.id + '-' + suffix); }
async function readySave(c, name = 'new file') {
  await c.start(); c.setName(name); await c.saveSelection();
}

test('unknown schemas, invalid paths/names and unbounded filters reject explicitly', () => {
  for (const settings of [{ mode: 'delete' }, { multiselect: true }, { initialDirectory: '/home/../etc' },
    { suggestedName: 'sub/name' }, { defaultExtension: '.txt' }, { filters: [] },
    { filters: [{ label: 'x', extensions: ['*'] }] }])
    assert.throws(() => controller({ settings }));
  assert.throws(() => controller({ files: { version: 0 } }), /shared ordinary-user/);
});

test('directory load never preselects; open resolves only after explicit selection and fresh readable stat', async () => {
  const f = controller({ settings: { filters: textFilters } }); await f.c.start();
  assert.equal(f.c.getState().selection, null); await f.c.openSelection();
  assert.deepEqual(f.results, []);
  assert.equal(f.c.visibleEntries().some(item => item.name === 'image.png'), false);
  f.c.select(EXISTING); await f.c.openSelection();
  assert.deepEqual(f.results, [{ status: 'selected', mode: 'open', path: EXISTING,
    selectedPath: EXISTING, identity: f.get(EXISTING).identity }]);
  assert.equal(f.calls.some(call => call[0] === 'readText'), false, 'chooser selects, consumer reads');
  assert.equal(Object.isFrozen(f.results[0]), true);
});

test('cancel is distinct, no fake path or filesystem operation, and repeated disposal settles once', async () => {
  const f = controller(); await f.c.start(); f.c.select(EXISTING);
  const before = f.calls.length; f.c.cancel(); f.c.dispose(); f.c.cancel();
  assert.deepEqual(f.results, [{ status: 'cancelled', reason: 'cancelled' }]);
  assert.equal(f.calls.length, before);
});

test('folders navigate only on activation; home and up use actual directory listings', async () => {
  const f = controller(); await f.c.start(); f.c.select(HOME + '/Docs');
  assert.equal(f.c.getState().directory.path, HOME); await f.c.activate();
  assert.equal(f.c.getState().directory.path, HOME + '/Docs');
  assert.equal(f.c.getState().selection, null); assert.deepEqual(f.results, []);
  await f.c.up(); assert.equal(f.c.getState().directory.path, HOME);
  await f.c.navigate('/missing'); assert.match(f.c.getState().error, /ENOENT/);
  assert.equal(f.results.length, 0);
});

test('Unicode, spaces and quotes stay literal qualified paths, not launch commands or MIME guesses', async () => {
  const f = controller(); await f.c.start();
  const path = HOME + '/space "quoted" \u6587\u4ef6.txt';
  f.c.select(path); await f.c.openSelection();
  assert.equal(f.results[0].path, path);
  const bundle = controller(); bundle.put(HOME + '/Notes.app', 'directory');
  await bundle.c.start(); bundle.c.select(HOME + '/Notes.app'); await bundle.c.activate();
  assert.equal(bundle.c.getState().directory.path, HOME + '/Notes.app');
  assert.equal(bundle.calls.some(call => /launch|spawn/i.test(call[0])), false);
});

test('changed/deleted/non-readable selected files produce visible errors and no successful result', async () => {
  for (const change of [
    f => f.put(EXISTING),
    f => f.records.delete(EXISTING),
    f => { f.get(EXISTING).readable = false; },
  ]) {
    const f = controller(); await f.c.start(); f.c.select(EXISTING); change(f);
    await f.c.openSelection(); assert.equal(f.results.length, 0);
    assert.ok(f.c.getState().error); assert.equal(f.errors.length, 1); assert.equal(f.c.getState().selection, null);
  }
});

test('marked symlink selection revalidates link and canonical target; changed targets reject', async () => {
  const f = controller();
  const link = HOME + '/link.txt';
  f.put(link, 'symlink', { linkTarget: EXISTING, targetType: 'file', targetIdentity: f.get(EXISTING).identity });
  await f.c.start(); f.c.select(link); await f.c.openSelection();
  assert.equal(f.results[0].path, EXISTING); assert.equal(f.results[0].selectedPath, link);
  assert.ok(f.calls.some(call => call[0] === 'stat' && call[1] === link && call[2] === true));
  const changed = controller();
  changed.put(link, 'symlink', { linkTarget: EXISTING, targetType: 'file', targetIdentity: changed.get(EXISTING).identity });
  await changed.c.start(); changed.c.select(link); changed.put(EXISTING);
  await changed.c.openSelection(); assert.equal(changed.results.length, 0);
  assert.match(changed.c.getState().error, /ESTALE.*Link target/);
});

test('save-new returns a checked directory/name/no-clobber intent but does not claim writing', async () => {
  const f = controller({ settings: { mode: 'save', defaultExtension: 'txt', filters: textFilters } });
  await readySave(f.c, 'new \u6587\u4ef6');
  assert.deepEqual(f.results, [{ status: 'selected', mode: 'save', path: HOME + '/new \u6587\u4ef6.txt',
    parentPath: HOME, parentIdentity: f.get(HOME).identity, name: 'new \u6587\u4ef6.txt',
    expectedIdentity: null, overwrite: false }]);
  assert.equal(f.calls.some(call => ['writeText', 'replaceText'].includes(call[0])), false);
});

test('save keeps suffixes, rejects mismatched filters/invalid names and does not swallow target permission errors', async () => {
  for (const name of ['../escape', 'x\0y', 'x'.repeat(256), 'image.png']) {
    const f = controller({ settings: { mode: 'save', defaultExtension: 'txt', filters: textFilters } });
    await readySave(f.c, name); assert.equal(f.results.length, 0); assert.ok(f.c.getState().error);
  }
  const f = controller({ settings: { mode: 'save' } }); await f.c.start(); f.c.setName('permission.txt');
  const stat = f.files.stat;
  f.files.stat = path => { if (path.endsWith('permission.txt')) throw f.error('EACCES'); return stat(path); };
  await f.c.saveSelection(); assert.match(f.c.getState().error, /EACCES/); assert.equal(f.results.length, 0);
});

test('save requires the observed writable destination directory; stale directories do not authorize targets', async () => {
  for (const change of [f => f.put(HOME, 'directory'), f => { f.get(HOME).writable = false; }]) {
    const f = controller({ settings: { mode: 'save' } });
    await f.c.start(); f.c.setName('new.txt'); change(f); await f.c.saveSelection();
    assert.equal(f.results.length, 0); assert.match(f.c.getState().error, /ESTALE|EACCES/);
  }
});

test('existing save demands an explicit confirmation, cancellation never writes', async () => {
  const f = controller({ settings: { mode: 'save' } }); await readySave(f.c, 'hello.txt');
  assert.equal(f.c.getState().phase, 'overwrite'); assert.deepEqual(f.results, []);
  assert.equal(f.c.getState().confirmation.path, EXISTING);
  const identity = f.c.getState().confirmation.target.identity;
  await f.c.confirmOverwrite();
  assert.equal(f.results[0].overwrite, true); assert.equal(f.results[0].expectedIdentity, identity);
  assert.equal(f.calls.some(call => call[0] === 'replaceText'), false);
  const cancelled = controller({ settings: { mode: 'save' } }); await readySave(cancelled.c, 'hello.txt');
  cancelled.c.cancel(); assert.equal(cancelled.results[0].status, 'cancelled');
});

test('changed existing identity requires another fresh explicit confirmation, not retrying the old choice', async () => {
  const f = controller({ settings: { mode: 'save' } }); await readySave(f.c, 'hello.txt');
  const oldRevision = f.c.getState().revision;
  f.put(EXISTING, 'file', { text: 'externally changed' });
  await f.c.confirmOverwrite(oldRevision);
  assert.equal(f.results.length, 0); assert.equal(f.c.getState().phase, 'overwrite');
  assert.match(f.c.getState().error, /changed.*confirm again/);
  await f.c.confirmOverwrite(oldRevision); assert.equal(f.results.length, 0, 'retained confirmation callback is stale');
  await f.c.confirmOverwrite(f.c.getState().revision);
  assert.equal(f.results[0].expectedIdentity, f.get(EXISTING).identity);
});

test('changed parent observation also requires fresh consent; replaced non-directory parent is rejected', async () => {
  const f = controller({ settings: { mode: 'save' } }); await readySave(f.c, 'hello.txt');
  f.put(HOME, 'directory');
  await f.c.confirmOverwrite();
  assert.equal(f.results.length, 0); assert.equal(f.c.getState().phase, 'overwrite');
  assert.match(f.c.getState().error, /directory changed.*confirm again/);
  await f.c.confirmOverwrite();
  assert.equal(f.results[0].parentIdentity, f.get(HOME).identity);
  const bad = controller({ settings: { mode: 'save' } }); await readySave(bad.c, 'hello.txt');
  bad.put(HOME, 'file'); await bad.c.confirmOverwrite();
  assert.equal(bad.results.length, 0); assert.match(bad.c.getState().error, /ESTALE/);
});

test('existing links/special targets and old new-only capability never masquerade as replace readiness', async () => {
  for (const type of ['symlink', 'other', 'directory']) {
    const f = controller({ settings: { mode: 'save' } });
    f.put(HOME + '/existing', type, type === 'symlink' ? { linkTarget: EXISTING,
      targetType: 'file', targetIdentity: f.get(EXISTING).identity } : {});
    await readySave(f.c, 'existing'); assert.equal(f.results.length, 0);
    assert.match(f.c.getState().error, /EEXIST/);
  }
  const f = controller({ settings: { mode: 'save' } }); f.files.overwrite = false;
  await readySave(f.c, 'hello.txt'); assert.match(f.c.getState().error, /unavailable/);
  assert.equal(f.c.getState().confirmation, null);
});

test('late directory/readiness completions and stale callbacks cannot revive cancelled or replaced selection', async () => {
  const f = controller(); await f.c.start();
  const held = deferred(), listing = f.files.listDirectory(HOME);
  f.files.listDirectory = () => held.promise;
  const pending = f.c.navigate(HOME); const old = f.c.getState().revision;
  f.c.cancel(); held.resolve(listing); await pending;
  f.c.select(EXISTING, old); assert.equal(f.results.length, 1); assert.equal(f.results[0].status, 'cancelled');
  const selecting = controller(); await selecting.c.start(); selecting.c.select(EXISTING);
  const observed = selecting.files.stat(EXISTING), stat = selecting.files.stat, hold = deferred();
  selecting.files.stat = path => path === EXISTING ? hold.promise : stat(path);
  const open = selecting.c.openSelection();
  selecting.c.select(HOME + '/space "quoted" \u6587\u4ef6.txt');
  hold.resolve(observed); await open;
  assert.equal(selecting.results.length, 0);
  assert.match(selecting.c.getState().selection.path, /quoted/);
});

test('editing filename during pending validation invalidates late results', async () => {
  const f = controller({ settings: { mode: 'save' } }); await f.c.start(); f.c.setName('first.txt');
  const hold = deferred(), stat = f.files.stat;
  f.files.stat = path => path === HOME ? hold.promise : stat(path);
  const pending = f.c.saveSelection(); f.c.setName('second.txt');
  hold.resolve(stat(HOME)); await pending;
  assert.equal(f.results.length, 0); assert.equal(f.c.getState().name, 'second.txt');
});

test('missing production API is visibly unavailable and cancellation has no selected path', async t => {
  const { host } = fixtureHost(t), parent = host.create({}), errors = [];
  const dialog = showFileDialog({ parent, native: null, reportError: message => errors.push(message) });
  assert.match(dialog.element.textContent, /missing|incompatible/);
  assert.equal(find(dialog, 'accept').getAttribute('aria-disabled'), 'true');
  deliver(find(dialog, 'cancel')); assert.deepEqual(await dialog.result, { status: 'cancelled', reason: 'cancelled' });
  assert.equal(errors.length, 1);
});

test('optional theme failure is visible without replacing the filesystem or selecting a fake file', async t => {
  const { host } = fixtureHost(t), parent = host.create({}), f = fixtureFiles(), errors = [];
  const dialog = showFileDialog({ parent, files: f.files, optInTheme: true, native: null,
    reportError: message => errors.push(message) }); await settled();
  assert.match(dialog.element.textContent, /Theme error.*native/);
  assert.equal(dialog.controller.getState().selection, null); assert.equal(errors.length, 1);
  dialog.dispose();
});

test('actual reconciler/textinput mock supports keyboard select, Tab trap, Enter, Escape and focus restoration', async t => {
  const { host } = fixtureHost(t), parent = host.create({}), f = fixtureFiles();
  const original = parent.document.createElement('view'); original.tabIndex = 0;
  parent.document.body.appendChild(original); original.focus();
  let shortcuts = 0; parent.document.body.addEventListener('keydown', () => shortcuts++);
  const dialog = showFileDialog({ parent, files: f.files }); await settled();
  assert.notEqual(parent.document.activeElement, original);
  const tab = deliver(parent.document.activeElement, 'keydown', { key: 'Tab' });
  assert.equal(tab.defaultPrevented, true); assert.equal(shortcuts, 0);
  deliver(findChoice(dialog, 'hello.txt'), 'keydown', { key: 'Enter' });
  assert.equal(dialog.controller.getState().selection.path, EXISTING);
  deliver(find(dialog, 'accept'), 'keydown', { key: 'Enter' }); await settled();
  assert.equal((await dialog.result).path, EXISTING);
  assert.equal(parent.document.activeElement, original);
  const second = showFileDialog({ parent, files: f.files }); await settled();
  deliver(second.element, 'keydown', { key: 'Escape' });
  assert.equal((await second.result).status, 'cancelled');
  assert.equal(second.element.parentNode, null);
});

test('UI breadcrumbs/location navigate; Unicode textinput builds the save name and real selected target result', async t => {
  const { host } = fixtureHost(t), parent = host.create({}), f = fixtureFiles();
  const dialog = showFileDialog({ parent, files: f.files, settings: { mode: 'save', defaultExtension: 'txt' } });
  await settled();
  deliver(find(dialog, 'name'), 'textinput', { data: 'new "\u6587\u4ef6"' });
  assert.equal(dialog.controller.getState().name, 'new "\u6587\u4ef6"');
  deliver(find(dialog, 'name'), 'keydown', { key: 'Enter' }); await settled();
  assert.equal((await dialog.result).path, HOME + '/new "\u6587\u4ef6".txt');
  const open = showFileDialog({ parent, files: f.files }); await settled();
  deliver(find(open, 'crumb-1')); await settled(); assert.equal(open.controller.getState().directory.path, '/home');
  deliver(find(open, 'home')); await settled(); assert.equal(open.controller.getState().directory.path, HOME);
  open.dispose();
});

test('failed typed navigation restores the actual location rather than showing a false save destination', async t => {
  const { host } = fixtureHost(t), parent = host.create({}), f = fixtureFiles();
  const dialog = showFileDialog({ parent, files: f.files, settings: { mode: 'save' } }); await settled();
  const location = find(dialog, 'location');
  deliver(location, 'keydown', { key: 'a', ctrlKey: true });
  deliver(location, 'textinput', { data: '/missing' });
  deliver(location, 'keydown', { key: 'Enter' }); await settled();
  assert.equal(dialog.controller.getState().directory.path, HOME);
  assert.equal(location.textContent, HOME);
  assert.match(dialog.element.textContent, /ENOENT/);
  dialog.dispose();
});

test('UI overwrite is modal and defaults to keep; changed identity is visibly reconfirmed, old callbacks cannot approve', async t => {
  const { host } = fixtureHost(t), parent = host.create({}), f = fixtureFiles();
  const dialog = showFileDialog({ parent, files: f.files, settings: { mode: 'save', suggestedName: 'hello.txt' } });
  await settled(); deliver(find(dialog, 'accept')); await settled();
  assert.match(dialog.element.textContent, /Replace existing file.*hello.txt/);
  assert.equal(parent.document.activeElement, find(dialog, 'keep'));
  const old = find(dialog, 'replace').listeners.get('click')[0];
  f.put(EXISTING); deliver(find(dialog, 'replace')); await settled();
  assert.match(dialog.element.textContent, /changed.*confirm again/);
  old({ button: 0, stopPropagation() {} }); await settled();
  assert.equal(dialog.controller.getState().phase, 'overwrite');
  deliver(find(dialog, 'replace')); await settled(); assert.equal((await dialog.result).overwrite, true);
});

test('dismissing overwrite keeps focus in the modal, excludes hidden controls and cancellation writes nothing', async t => {
  const { host } = fixtureHost(t), parent = host.create({}), f = fixtureFiles();
  const dialog = showFileDialog({ parent, files: f.files, settings: { mode: 'save', suggestedName: 'hello.txt' } });
  await settled(); deliver(find(dialog, 'accept')); await settled();
  deliver(find(dialog, 'keep'), 'keydown', { key: 'Tab' });
  assert.equal(parent.document.activeElement, find(dialog, 'replace'));
  deliver(find(dialog, 'keep')); assert.equal(parent.document.activeElement, find(dialog, 'name'));
  deliver(find(dialog, 'name'), 'keydown', { key: 'Escape' });
  assert.equal((await dialog.result).status, 'cancelled');
  assert.equal(f.calls.some(call => call[0] === 'replaceText'), false);
});

test('large directories render only 64 rows/page with visible list-cap disclosure and bounded scrolling', async t => {
  const { host } = fixtureHost(t), parent = host.create({}), f = fixtureFiles();
  for (let i = 0; i < 1000; i++) f.put(HOME + '/file' + String(i).padStart(4, '0') + '.txt');
  const list = f.files.listDirectory; f.files.listDirectory = path => ({ ...list(path), complete: false });
  const dialog = showFileDialog({ parent, files: f.files }); await settled();
  const rows = () => nodes(dialog.element).filter(node => node.id.startsWith(dialog.id + '-entry-'));
  assert.equal(rows().length, 64);
  assert.match(dialog.element.textContent, /limited to 1024.*64 rows per page/s);
  const first = rows()[0].textContent; deliver(find(dialog, 'next')); assert.notEqual(rows()[0].textContent, first);
  assert.equal(rows().length, 64); dialog.dispose();
});

test('parent close, explicit disposal and held native reads do not repaint or complete as selected after close', async t => {
  const { host } = fixtureHost(t), parent = host.create({}), f = fixtureFiles();
  let closed = 0; parent.onclose = () => closed++;
  const dialog = showFileDialog({ parent, files: f.files }); await settled();
  assert.throws(() => showFileDialog({ parent, files: f.files }), /already owns/);
  const hold = deferred(), stat = f.files.stat;
  f.files.stat = path => path === EXISTING ? hold.promise : stat(path);
  dialog.controller.select(EXISTING); const pending = dialog.controller.openSelection();
  parent.close(); hold.resolve(stat(EXISTING)); await pending;
  assert.deepEqual(await dialog.result, { status: 'cancelled', reason: 'parent-closed' });
  assert.equal(closed, 1); assert.equal(dialog.element.parentNode, null);
});

test('real consumer wiring reads chosen identity and writes bounded text then readback, not chooser-only success', async t => {
  const { host } = fixtureHost(t), f = fixtureFiles();
  const app = createFileTextApp({ host, files: f.files }).start(); t.after(app.stop);
  const opening = app.open(); await settled(); let dialog = app.getDialog();
  dialog.controller.select(EXISTING); await dialog.controller.openSelection(); await opening;
  assert.match(app.getState().status, /Read/); assert.equal(app.getState().contents, f.get(EXISTING).text);
  assert.ok(f.calls.some(call => call[0] === 'readText' && call[2] === f.get(EXISTING).identity));
  const saving = app.save(); await settled(); dialog = app.getDialog();
  dialog.controller.setName('saved.txt'); await dialog.controller.saveSelection(); await saving;
  assert.equal(f.get(HOME + '/saved.txt').text, 'PollyUI saved text');
  assert.match(app.getState().status, /Saved and read back/);
  assert.ok(f.calls.some(call => call[0] === 'writeText' && call[2] === 'saved.txt'));
});

test('consumer replacement ESTALE reopens fresh chooser and requires new explicit confirmation, no automatic overwrite retry', async t => {
  const { host } = fixtureHost(t), f = fixtureFiles();
  const replace = f.files.replaceText; let requests = 0;
  f.files.replaceText = (...args) => {
    requests++;
    if (requests === 1) { f.put(EXISTING, 'file', { text: 'external update retained' }); throw f.error('ESTALE'); }
    return replace(...args);
  };
  const app = createFileTextApp({ host, files: f.files, suggestedName: 'hello.txt',
    reportError: () => {} }).start(); t.after(app.stop);
  const saving = app.save(); await settled(); let dialog = app.getDialog();
  await dialog.controller.saveSelection(); await dialog.controller.confirmOverwrite(); await settled();
  dialog = app.getDialog();
  assert.equal(requests, 1); assert.equal(f.get(EXISTING).text, 'external update retained');
  assert.match(dialog.element.textContent, /changed before replacement.*confirm.*again/i);
  await dialog.controller.saveSelection(); assert.equal(requests, 1);
  await dialog.controller.confirmOverwrite(); await saving;
  assert.equal(requests, 2); assert.equal(f.get(EXISTING).text, 'PollyUI saved text');
  assert.match(app.getState().status, /Saved and read back/);
});

test('consumer readback failures report already completed write, cancellation does not request replacement', async t => {
  const { host } = fixtureHost(t), f = fixtureFiles();
  f.files.readText = () => { throw f.error('EIO', 'readback failed'); };
  const errors = [];
  const app = createFileTextApp({ host, files: f.files, reportError: message => errors.push(message) }).start();
  t.after(app.stop);
  const saving = app.save(); await settled(); const dialog = app.getDialog();
  dialog.controller.setName('new.txt'); await dialog.controller.saveSelection(); await saving;
  assert.match(app.getState().status, /Write completed but readback failed/);
  assert.equal(app.getState().saved, null); assert.equal(f.get(HOME + '/new.txt').text, 'PollyUI saved text');
  const again = app.save(); await settled(); app.getDialog().controller.cancel(); await again;
  assert.match(app.getState().status, /cancelled.*No write/); assert.equal(errors.length, 1);
});
