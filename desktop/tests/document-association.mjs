import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

register('./root-loader.mjs', import.meta.url);
const { localDocument, localDocuments, mimeType, parseMimeApps, resolveMimeApplications, utf8Bytes } =
  await import('./desktop/shell/documents.mjs');
const { expandExec, parseDesktopEntry, applicationCatalog, createApplicationLauncher } =
  await import('./desktop/shell/applications.mjs');
const entry = { name: 'Editor %u 中文', path: '/user/applications/editor file.desktop', icon: 'editor icon' };
const file = (id = 'editor.desktop', extra = '', directory = '/user/applications') => ({
  id, path: directory + '/' + id,
  contents: '[Desktop Entry]\nType=Application\nName=Editor\nExec=/bin/editor %F\nMimeType=text/plain;\n' + extra,
});
const associations = (contents = '', directory = '/user/applications', desktopSpecific = false) =>
  ({ path: directory + '/mimeapps.list', directory, desktopSpecific, contents });
const defaults = ids => '[Default Applications]\ntext/plain=' + ids + ';\n';

test('absolute paths and local file URIs roundtrip Unicode, spaces and command-looking data', () => {
  for (const path of ['/tmp/two words.txt', '/tmp/中文 e\u0301.txt', '/tmp/$(touch evil);&`echo`.txt',
    '/tmp/a%f?#\'"\\\n.txt', '/tmp/-flag', '/']) {
    const document = localDocument(path);
    assert.equal(localDocument(document.uri).path, path);
    assert.ok(document.uri.startsWith('file:///'));
    assert.doesNotMatch(document.uri, /[?#\s\\]/);
  }
  assert.deepEqual(localDocument('file:///tmp/%E4%B8%AD%20a%25.txt'), {
    path: '/tmp/中 a%.txt', uri: 'file:///tmp/%E4%B8%AD%20a%25.txt',
  });
  assert.equal(utf8Bytes('中文'), 6);
});

test('remote schemes, authorities, malformed UTF8/escaping, NUL, relative and overbound data refuse', () => {
  for (const value of ['', null, 42, 'relative.txt', './file', '//host/file', 'https://example/a', 'file://host/a',
    'file:/tmp/a', 'file:///tmp/a b', 'file:///tmp/中', 'file:///tmp/a?query', 'file:///tmp/a#fragment',
    'file:///tmp/%', 'file:///tmp/%GG', 'file:///tmp/%C0%AF', 'file:///tmp/%00', '/tmp/\0file',
    'file:////host/file', 'file:///%2Fhost/file', 'file:///tmp/\\file', '/tmp/\ud800',
    '/' + 'a'.repeat(4095), '/' + '中'.repeat(1365)]) {
    assert.throws(() => localDocument(value), undefined, String(value));
  }
  assert.equal(utf8Bytes(localDocument('/' + 'a'.repeat(4094)).path), 4095);
  assert.throws(() => localDocuments('string'));
  assert.throws(() => localDocuments([], true));
  assert.throws(() => localDocuments(Array(33).fill('/a')));
  assert.throws(() => localDocuments(Array(1)));
  assert.throws(() => localDocuments(Array(32).fill('/' + '中'.repeat(100))), /8192/);
});

test('Exec produces measured argv shapes without quoting, shell interpolation or repeated expansion', () => {
  const paths = ['/tmp/one $(id);.txt', '/tmp/中文 %u.txt'];
  const uris = paths.map(path => localDocument(path).uri);
  assert.deepEqual(expandExec('/bin/editor %F %i %c %k %% "two words" ""', entry, paths),
    ['/bin/editor', ...paths, '--icon', entry.icon, entry.name, entry.path, '%', 'two words', '']);
  assert.deepEqual(expandExec('/bin/editor %U', entry, paths), ['/bin/editor', ...uris]);
  assert.deepEqual(expandExec('/bin/editor --file=%f', entry, [paths[0]]),
    ['/bin/editor', '--file=' + paths[0]]);
  assert.deepEqual(expandExec('/bin/editor %u', entry, [uris[0]]), ['/bin/editor', uris[0]]);
  assert.deepEqual(expandExec('/bin/editor %F %% %d %i', { ...entry, icon: '' }, []), ['/bin/editor', '%']);
  assert.deepEqual(expandExec('"/bin/editor with space" "a\\$b" %f', entry, [paths[0]]),
    ['/bin/editor with space', 'a$b', paths[0]]);
});

test('Exec rejects multiple file codes, quoted/embedded lists, missing handler and argument overflow', () => {
  for (const command of ['/bin/editor %f %U', '/bin/editor %F %F', '/bin/editor prefix%F',
    '/bin/editor "%f"', '/bin/editor prefix%i', '/bin/editor %z', '/bin/editor %',
    '/bin/editor "unclosed', '/bin/editor $HOME', '/bin/editor x;command', '%f /bin/editor',
    '/bin/editor %%f']) assert.throws(() => expandExec(command, entry, ['/tmp/a']), undefined, command);
  for (const code of ['f', 'u']) assert.throws(() => expandExec('/bin/editor %' + code, entry, ['/a', '/b']), /Single-document/);
  assert.throws(() => expandExec('/bin/editor %f', entry, ['/bad\0']), /NUL/);
  assert.throws(() => expandExec('%F /bin/editor', entry), /cannot select the executable/);
  assert.throws(() => expandExec('/bin/editor %F ' + Array(255).fill('arg').join(' '), entry, ['/a']), /bounded argv/);
  assert.throws(() => expandExec('/bin/editor %F %c', { ...entry, name: 'a'.repeat(65536) }, ['/a']), /bounded argv/);
});

test('concrete MIME and strict bounded mimeapps parser refuse malformed sources visibly', () => {
  for (const value of ['text/plain\n', 'Text/plain', 'text/*', 'text', 'text/plain; charset=UTF-8',
    'text/plain\0', '/plain', 'text/', null, 'a/'.padEnd(256, 'a')]) assert.throws(() => mimeType(value));
  assert.equal(mimeType('application/vnd.example+json'), 'application/vnd.example+json');
  const parsed = parseMimeApps(associations(defaults('one.desktop;two.desktop')));
  assert.deepEqual(parsed.get('Default Applications').get('text/plain'), ['one.desktop', 'two.desktop']);
  for (const contents of ['[Default Applications\ntext/plain=a.desktop;\n',
    defaults('a.desktop') + defaults('b.desktop'), defaults('a.desktop') + 'text/plain=b.desktop;\n',
    defaults('../evil.desktop'), defaults('not-an-id'), defaults('a.desktop;;b.desktop'),
    defaults('a.desktop') + '\0', defaults(Array(257).fill('a.desktop').join(';')),
    '[Added Associations]\ntext/plain=a.desktop;\n[Removed Associations]\ntext/plain=a.desktop;',
    '[Added Associations]\nnot a MIME=a.desktop;', 'a'.repeat(1024 * 1024 + 1)]) {
    assert.throws(() => parseMimeApps(associations(contents)), undefined, contents.slice(0, 70));
  }
});

test('reuse existing masked catalog and distinguish launch-only, advertised and parameter-capable apps', () => {
  const reports = [];
  const noMime = { ...file('launch-only.desktop'), contents: file('launch-only.desktop').contents.replace('MimeType=text/plain;\n', '') };
  const noField = { ...file('no-field.desktop'), contents: file('no-field.desktop').contents.replace('%F', '') };
  const catalog = applicationCatalog([noMime, noField, file('hidden.desktop', 'Hidden=true'),
    file('hidden.desktop', '', '/system/applications'),
    { ...file('bad.desktop'), contents: 'invalid' }, file('bad.desktop', '', '/system/applications'),
    file('editor.desktop', 'NoDisplay=true')], { documentHandlers: true }, message => reports.push(message));
  assert.equal(catalog.length, 3);
  assert.equal(applicationCatalog([file('editor.desktop', 'NoDisplay=true')]).length, 0);
  const resolved = resolveMimeApplications('text/plain', catalog, [associations(defaults('no-field.desktop;launch-only.desktop;editor.desktop'))]);
  assert.equal(resolved.defaultApplication, 'editor.desktop');
  assert.deepEqual(resolved.applications.map(app => app.id), ['editor.desktop']);
  const unavailable = applicationCatalog([file()], { canExecute: () => false });
  assert.throws(() => resolveMimeApplications('text/plain', unavailable, [associations()]), /No available/);
});

test('XDG defaults precede system defaults, removals suppress lower associations and defaults', () => {
  const catalog = applicationCatalog([file('user.desktop'), file('system.desktop', '', '/system/applications')]);
  assert.equal(resolveMimeApplications('text/plain', catalog, [
    associations(defaults('user.desktop'), '/config', true),
    associations(defaults('system.desktop')), associations('', '/system/applications'),
  ]).defaultApplication, 'user.desktop');
  assert.equal(resolveMimeApplications('text/plain', catalog, [
    associations(defaults('user.desktop') + '[Removed Associations]\ntext/plain=user.desktop;', '/config'),
    associations(), associations(defaults('system.desktop'), '/system/applications'),
  ]).defaultApplication, 'system.desktop');
  assert.equal(resolveMimeApplications('text/plain', catalog, [
    associations('[Added Associations]\ntext/plain=system.desktop;', '/config'),
    associations(defaults('system.desktop') + '[Removed Associations]\ntext/plain=system.desktop;', '/user/applications'),
    associations('', '/system/applications'),
  ]).defaultApplication, 'system.desktop', 'higher-priority added association survives lower removal');
  assert.equal(resolveMimeApplications('text/plain', catalog, [
    associations(defaults('user.desktop') + '[Removed Associations]\ntext/plain=user.desktop;', '/config', true),
    associations(), associations('', '/system/applications'),
  ]).defaultApplication, 'user.desktop', 'desktop-specific files supply defaults only');
  assert.equal(resolveMimeApplications('text/plain', catalog, [
    associations(),
    associations(defaults('user.desktop') + '[Removed Associations]\ntext/plain=user.desktop;', '/system/applications'),
  ]).defaultApplication, 'user.desktop', 'lower data-directory removals cannot rewrite higher desktop entries');
  assert.throws(() => resolveMimeApplications('text/plain', catalog, [
    associations('[Removed Associations]\ntext/plain=user.desktop;system.desktop;', '/config'),
    associations(), associations('', '/system/applications'),
  ]), /No available/);
  assert.throws(() => resolveMimeApplications('text/plain', catalog, [
    associations(defaults('system.desktop') + '[Default Applications]'),
  ]), /Duplicate/);
});

function fixture() {
  const state = { files: [file()], mime: 'text/plain', sources: [associations()], calls: [], qualified: true };
  const native = {
    documentPlatform: 'linux', locale: 'C', terminal: '/bin/terminal',
    applicationFiles: () => state.files, canExecute: () => true,
    mimeAssociationFiles: () => state.sources,
    documentMimeType: path => { state.calls.push(['mime', path]); return state.mime; },
    canActivateApplication: () => state.qualified, activateApplication: () => { throw new Error('Forbidden Activate'); },
    openApplicationDocuments: (id, uris) => { state.calls.push(['open', id, uris]); return state.promise; },
    spawnApplication: (...args) => { state.calls.push(['spawn', ...args]); return 123; },
  };
  return { state, native, launcher: createApplicationLauncher(native, () => {}) };
}

test('document API uses current custom registry, rechecks MIME/metadata/defaults and cannot bypass association', () => {
  const { state, launcher } = fixture();
  assert.equal(launcher.documentApplications('/tmp/a').defaultApplication, 'editor.desktop');
  assert.equal(launcher.openDocuments(['/tmp/a', 'file:///tmp/b']), 123);
  assert.deepEqual(state.calls.at(-1), ['spawn', ['/bin/editor', '/tmp/a', '/tmp/b'], '', 'editor.desktop']);
  state.files = [{ ...file(), contents: file().contents.replace('/bin/editor %F', '/bin/replaced %U') }];
  launcher.openDocuments(['/tmp/中文']);
  assert.deepEqual(state.calls.at(-1), ['spawn', ['/bin/replaced', 'file:///tmp/%E4%B8%AD%E6%96%87'], '', 'editor.desktop']);
  for (const files of [[], [file(undefined, 'Hidden=true'), file()], [file(undefined, 'Name=Duplicate'), file()]]) {
    state.files = files;
    assert.throws(() => launcher.openDocuments(['/tmp/a']), /No available/);
  }
  state.files = [file()];
  state.sources = [associations('[Removed Associations]\ntext/plain=editor.desktop;', '/config'), associations()];
  assert.throws(() => launcher.openDocuments(['/tmp/a'], 'editor.desktop'), /No available/);
  state.sources = [associations()];
  assert.throws(() => launcher.openDocuments(['/tmp/a'], '/bin/evil'), /not an available handler/);
  state.mime = 'application/json';
  assert.throws(() => launcher.openDocuments(['/tmp/a']), /No available/);
});

test('terminal, cwd, single versus multi-document and launch-only/bundles retain direct launch behavior', () => {
  const { state, launcher } = fixture();
  state.files = [file(undefined, 'Terminal=true\nPath=/working directory')];
  launcher.openDocuments(['/tmp/a']);
  assert.deepEqual(state.calls.at(-1), ['spawn', ['/bin/terminal', '-e', '/bin/editor', '/tmp/a'], '/working directory', 'editor.desktop']);
  state.files = [{ ...file(), contents: file().contents.replace('%F', '%f') }];
  assert.throws(() => launcher.openDocuments(['/a', '/b']), /Single-document/);
  const before = state.calls.filter(call => call[0] === 'spawn').length;
  assert.equal(before, 1);
  launcher.launch('editor.desktop');
  assert.deepEqual(state.calls.at(-1), ['spawn', ['/bin/editor'], '', 'editor.desktop']);
  assert.throws(() => launcher.openDocuments(['/a'], 'bundle:org.example.Editor'), /not an available handler/);
});

test('terminal prefix counts toward final document argv bound and cannot create a partial spawn', () => {
  const { state, launcher } = fixture();
  const source = file(undefined, 'Terminal=true');
  source.contents = source.contents.replace('/bin/editor %F', '/bin/editor %F ' + Array(253).fill('arg').join(' '));
  state.files = [source];
  assert.throws(() => launcher.openDocuments(['/a']), /including terminal prefix/);
  assert.equal(state.calls.filter(call => call[0] === 'spawn').length, 0);
});

test('unsupported platform, missing primitive, MIME tool and settings failure propagate without spawn', () => {
  for (const failure of ['platform', 'mime-api', 'source-api', 'tool', 'type', 'settings', 'executable', 'TryExec']) {
    const { state, native, launcher } = fixture();
    if (failure === 'platform') native.documentPlatform = 'windows';
    if (failure === 'mime-api') delete native.documentMimeType;
    if (failure === 'source-api') delete native.mimeAssociationFiles;
    if (failure === 'tool') native.documentMimeType = () => { throw new Error('file unavailable'); };
    if (failure === 'type') state.mime = 'cannot open (permission denied)';
    if (failure === 'settings') native.mimeAssociationFiles = () => { throw new Error('settings read failure'); };
    if (failure === 'executable') native.canExecute = () => false;
    if (failure === 'TryExec') { native.canExecute = name => name !== 'missing'; state.files = [file(undefined, 'TryExec=missing')]; }
    assert.throws(() => launcher.openDocuments(['/tmp/a']), undefined, failure);
    assert.equal(state.calls.filter(call => ['spawn', 'open'].includes(call[0])).length, 0);
  }
});

test('standard D-Bus Open returns the actual acknowledgement promise and indeterminate errors never fallback', async () => {
  for (const code of [null, 'POLLY_ACTIVATION_TIMEOUT', 'POLLY_ACTIVATION_DISCONNECTED',
    'POLLY_ACTIVATION_INVALID_REPLY', 'POLLY_ACTIVATION_CANCELLED', 'org.freedesktop.DBus.Error.NoReply']) {
    const { state, launcher } = fixture();
    const id = 'org.pollyui.DocumentFixture.desktop';
    state.files = [{ ...file(id), contents: file(id).contents.replace('Exec=/bin/editor %F', 'DBusActivatable=true') }];
    const error = Object.assign(new Error('indeterminate ' + code), { code });
    const result = { kind: 'dbus', id, acknowledged: true, method: 'Open' };
    state.promise = code ? Promise.reject(error) : Promise.resolve(result);
    const promise = launcher.openDocuments(['/tmp/one', '/tmp/中文']);
    assert.equal(promise, state.promise);
    if (code) await assert.rejects(promise, failure => failure === error);
    else assert.equal(await promise, result);
    assert.deepEqual(state.calls.filter(call => call[0] !== 'mime'), [
      ['open', id, ['file:///tmp/one', 'file:///tmp/%E4%B8%AD%E6%96%87']],
    ]);
  }
});

test('D-Bus document capability/trust is rechecked and Exec wins even when DBusActivatable', () => {
  const { state, native, launcher } = fixture();
  state.files = [file(undefined, 'DBusActivatable=true')];
  assert.equal(launcher.openDocuments(['/a']), 123);
  state.files = [{ ...file('org.pollyui.DocumentFixture.desktop'),
    contents: file().contents.replace('Exec=/bin/editor %F', 'DBusActivatable=true') }];
  state.qualified = false;
  assert.throws(() => launcher.openDocuments(['/a']), /No available/);
  state.qualified = true;
  delete native.openApplicationDocuments;
  assert.throws(() => launcher.openDocuments(['/a']), /No available/);
});

test('mixed MIME defaults need an explicit common handler; no partial launches or first-file guessing', () => {
  const { state, native, launcher } = fixture();
  const common = { ...file('common.desktop'), contents: file('common.desktop').contents
    .replace('MimeType=text/plain;', 'MimeType=text/plain;application/json;') };
  const json = { ...file('json.desktop'), contents: file('json.desktop').contents.replace('text/plain', 'application/json') };
  state.files = [file(), json, common];
  state.sources = [associations(defaults('editor.desktop') + 'application/json=json.desktop;')];
  native.documentMimeType = path => path.endsWith('.json') ? 'application/json' : 'text/plain';
  assert.throws(() => launcher.openDocuments(['/a.txt', '/b.json']), /different default applications/);
  assert.throws(() => launcher.openDocuments(['/a.txt', '/b.json'], 'editor.desktop'), /every document/);
  assert.equal(state.calls.length, 0);
  assert.equal(launcher.openDocuments(['/a.txt', '/b.json'], 'common.desktop'), 123);
  assert.deepEqual(state.calls, [['spawn', ['/bin/editor', '/a.txt', '/b.json'], '', 'common.desktop']]);
});
