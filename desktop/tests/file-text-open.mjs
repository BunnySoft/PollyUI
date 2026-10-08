import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

register('./root-loader.mjs', import.meta.url);
const { createFileTextApp, parseFileTextArguments } = await import('../client/file-dialog-example.mjs');
const { fixtureFiles, fixtureHost, settled, deferred } = await import('./file-dialog-fixtures.mjs');
const HOME = '/home/polly', FILE = HOME + '/space "quoted" \u6587\u4ef6.txt';

test('File Text --file parser preserves the original directory/theme interface and literal filenames', () => {
  assert.deepEqual(parseFileTextArguments([]), { initialDirectory: null, initialFile: null, optInTheme: false });
  for (const args of [[HOME, '--theme'], ['--theme', HOME]])
    assert.deepEqual(parseFileTextArguments(args), { initialDirectory: HOME, initialFile: null, optInTheme: true });
  assert.deepEqual(parseFileTextArguments(['--theme']), { initialDirectory: null, initialFile: null, optInTheme: true });
  assert.deepEqual(parseFileTextArguments(['--file', FILE, '--theme']),
    { initialDirectory: null, initialFile: FILE, optInTheme: true });
  assert.deepEqual(parseFileTextArguments([HOME, '--file', FILE]),
    { initialDirectory: HOME, initialFile: FILE, optInTheme: false });
  assert.equal(parseFileTextArguments([FILE]).initialDirectory, FILE, 'a bare positional argument remains a directory');
  for (const args of [['--file'], ['--file', FILE, '--file', FILE], ['--file', 'relative.txt'],
    ['--file', 'file:///tmp/file.txt'], ['--file', '/tmp/NUL\0.txt'], ['--unknown'], [HOME, HOME]])
    assert.throws(() => parseFileTextArguments(args));
});

test('File Text --file startup actually consumes the named file with strong identity, without chooser or write', async t => {
  const { host } = fixtureHost(t), f = fixtureFiles();
  const app = createFileTextApp({ host, files: f.files, initialFile: FILE }).start();
  t.after(app.stop); await settled();
  const read = f.calls.find(call => call[0] === 'readText');
  assert.equal(read[1], FILE); assert.ok(read[2].startsWith('sha256:'));
  assert.equal(app.getState().lastPath, FILE); assert.equal(app.getState().contents, f.get(FILE).text);
  assert.match(app.getState().status, /^Read /); assert.equal(app.getState().busy, false);
  assert.equal(app.getDialog(), null); assert.equal(app.getState().saved, null);
  assert.equal(f.calls.some(call => ['listDirectory', 'writeText', 'replaceText'].includes(call[0])), false);
  assert.equal(app.getWindow().document.getElementById('file-text-input').textContent, 'PollyUI saved text',
    'reading does not silently turn the bounded new-text field into a document editor');
});

test('File Text --file public openPath displays the observed canonical path, never the unverified argument', async t => {
  const { host } = fixtureHost(t), f = fixtureFiles(), canonical = HOME + '/Docs/canonical.txt';
  f.put(canonical, 'file', { text: 'Actual canonical fixture text.' });
  const observe = f.files.observeText, observed = observe(canonical), requested = [];
  f.files.observeText = path => { requested.push(path); return observe(canonical); };
  const app = createFileTextApp({ host, files: f.files }).start(); t.after(app.stop);
  await app.openPath(FILE);
  assert.deepEqual(requested, [FILE]);
  assert.ok(f.calls.some(call => call[0] === 'readText' && call[1] === canonical && call[2] === observed.identity));
  assert.equal(app.getState().lastPath, canonical); assert.equal(app.getState().contents, f.get(canonical).text);
  assert.equal(app.getDialog(), null);
});

test('File Text --file production entry routes argv to real consumer code; directory-only launch remains idle', async t => {
  const { host, windows } = fixtureHost(t), f = fixtureFiles();
  const before = { window: globalThis.window, desktop: globalThis.desktop, application: globalThis.application };
  Object.assign(globalThis, { window: host, desktop: { fileSystem: f.files }, application: { arguments: ['--file', FILE] } });
  t.after(() => Object.assign(globalThis, before));
  await import('../examples/file-dialog.mjs?file-text-literal-entry'); await settled();
  assert.equal(windows[0].document.getElementById('file-text-path').textContent, FILE);
  assert.equal(windows[0].document.getElementById('file-text-content').textContent, f.get(FILE).text);
  assert.match(windows[0].document.getElementById('file-text-status').textContent, /^Read /);
  const calls = f.calls.length;
  globalThis.application = { arguments: [HOME, '--theme'] };
  await import('../examples/file-dialog.mjs?file-text-directory-entry'); await settled();
  assert.equal(windows.length, 2); assert.equal(f.calls.length, calls, 'legacy directory/theme start does not auto-read');
  assert.match(windows[1].document.getElementById('file-text-status').textContent, /Open reads a real file/);
});

test('File Text --file missing backend and stale content errors are visible, with no read-success fallback', async t => {
  const { host } = fixtureHost(t), errors = [];
  const unavailable = createFileTextApp({ host, native: null, initialFile: FILE,
    reportError: message => errors.push(message) }).start();
  t.after(unavailable.stop); await settled();
  assert.match(unavailable.getState().status, /Open named file failed.*missing|Open named file failed.*incompatible/);
  assert.equal(unavailable.getState().lastPath, ''); assert.equal(unavailable.getState().busy, false);
  assert.match(unavailable.getWindow().document.getElementById('file-text-status').textContent, /missing|incompatible/);
  const f = fixtureFiles(), read = f.files.readText;
  f.files.readText = (...args) => { f.get(FILE).text = 'Changed after strong observation.'; return read(...args); };
  const stale = createFileTextApp({ host, files: f.files, initialFile: FILE,
    reportError: message => errors.push(message) }).start();
  t.after(stale.stop); await settled();
  assert.match(stale.getState().status, /Open named file failed: ESTALE/);
  assert.equal(stale.getState().contents, ''); assert.equal(stale.getState().lastPath, '');
  assert.equal(stale.getState().busy, false); assert.equal(stale.getDialog(), null);
  assert.ok(errors.some(message => message.includes('ESTALE')));
});

test('File Text --file rejects mismatched canonical path, weak read identity and non-text replies', async t => {
  const { host } = fixtureHost(t);
  for (const mismatch of ['path', 'identity', 'text']) {
    const f = fixtureFiles(), read = f.files.readText;
    f.files.readText = (...args) => ({ ...read(...args),
      [mismatch]: mismatch === 'path' ? HOME + '/different.txt' : mismatch === 'identity' ? f.get(FILE).identity : null });
    const app = createFileTextApp({ host, files: f.files, reportError: () => {} }).start(); t.after(app.stop);
    await app.openPath(FILE);
    assert.match(app.getState().status, /Open named file failed.*mismatched file identity or text/);
    assert.equal(app.getState().lastPath, ''); assert.equal(app.getState().contents, '');
    assert.equal(app.getState().busy, false);
  }
});

test('File Text --file close during strong observation blocks late read dispatch and busy actions', async t => {
  const { host } = fixtureHost(t), f = fixtureFiles(), held = deferred();
  const observed = f.files.observeText(FILE); let observations = 0;
  f.files.observeText = () => { observations++; return held.promise; };
  const app = createFileTextApp({ host, files: f.files, initialFile: FILE }).start(); t.after(app.stop);
  assert.equal(app.getState().busy, true); assert.equal(app.getDialog(), null);
  assert.equal(app.getWindow().document.getElementById('file-text-save').getAttribute('aria-disabled'), 'true');
  await app.openPath(FILE); await app.open(); await app.save();
  assert.equal(observations, 1, 'busy calls do not supersede or dispatch writes');
  app.getWindow().close();
  const state = app.getState(), visible = app.getWindow().document.body.textContent;
  held.resolve(observed); await settled();
  assert.equal(f.calls.some(call => call[0] === 'readText'), false);
  assert.deepEqual(app.getState(), state); assert.equal(app.getWindow().document.body.textContent, visible);
  assert.equal(app.getState().closed, true);
});

test('File Text --file close during read ignores both late success and late failure', async t => {
  const { host } = fixtureHost(t);
  for (const reject of [false, true]) {
    const f = fixtureFiles(), held = deferred(), errors = [], read = f.files.readText;
    let reply;
    f.files.readText = (...args) => { reply = read(...args); return held.promise; };
    const app = createFileTextApp({ host, files: f.files, initialFile: FILE,
      reportError: message => errors.push(message) }).start(); t.after(app.stop);
    await settled(); assert.equal(app.getState().busy, true);
    app.getWindow().close();
    const state = app.getState(), visible = app.getWindow().document.body.textContent;
    if (reject) held.reject(f.error('EIO', 'late native read failed'));
    else held.resolve(reply);
    await settled();
    assert.deepEqual(app.getState(), state); assert.equal(app.getWindow().document.body.textContent, visible);
    assert.equal(app.getState().closed, true); assert.equal(app.getState().lastPath, '');
    assert.equal(errors.length, reject ? 1 : 0);
  }
});
