import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

register('./root-loader.mjs', import.meta.url);
const { createShellConfiguration, defaultShellConfiguration, migrateShellConfiguration,
  validateShellConfiguration } = await import('../shell/configuration.mjs');
const { encodeUtf8, decodeUtf8 } = await import('../../sysrt/sdk/js/encoding.mjs');
const { fixtureShortcuts } = await import('./configuration-memory.mjs');
const { shortcutActions } = await import('../shared/shortcuts.mjs');

test('native, preferences and Settings share the ordered ten-action catalog', () => {
  const source = readFileSync(new URL('../shared/shortcuts.c', import.meta.url), 'utf8');
  assert.deepEqual([...source.matchAll(/\{ "([^"]+)", "[^"]+", "[^"]+", PU_SHORTCUT_/g)].map(match => match[1]),
    shortcutActions);
  assert.equal(shortcutActions.length, 10);
  assert.deepEqual(shortcutActions.slice(7), ['tile-left', 'tile-right', 'restore-floating']);
  assert.throws(() => validateShellConfiguration({ ...defaultShellConfiguration(),
    shortcuts: fixtureShortcuts.slice(0, 7).map(({ action, key, modifiers }) => ({ action, key, modifiers })) }));
});

test('typed configuration defaults, complete validation, immutable copy, restart and once-only migration', () => {
  let bytes = null, legacyReads = 0, writes = 0;
  const files = { read: () => bytes, write(next) { bytes = next.slice(); writes++; }, close() {} };
  const create = () => createShellConfiguration(files, () => { legacyReads++; return null; });
  let store = create();
  assert.deepEqual(store.snapshot, defaultShellConfiguration());
  assert.equal(writes, 1);
  const patch = { version: 1, names: ['\u8d44\u6599', 'Code'], active: 1 };
  store.update({ workspace: patch });
  patch.names[0] = 'changed';
  assert.equal(store.snapshot.workspace.names[0], '\u8d44\u6599');
  assert.throws(() => store.snapshot.workspace.names.push('bad'));
  const saved = bytes.slice();
  for (const value of [{ surprise: true }, { version: 99 }, { audio: { version: 99 } },
    { theme: { id: 'xp', filesEnabled: 'yes' } }, { workspace: undefined }])
    assert.throws(() => store.update(value));
  assert.deepEqual(bytes, saved);
  store.close();
  assert.throws(() => store.snapshot);
  assert.throws(() => store.update({ audio: null }));
  store = create();
  assert.equal(store.snapshot.workspace.names[0], '\u8d44\u6599');
  assert.equal(legacyReads, 1);
});

test('prepublication failure preserves snapshot; published durability error advances it once without replay', () => {
  let bytes = encodeUtf8(JSON.stringify(defaultShellConfiguration())), fault = '';
  const store = createShellConfiguration({ read: () => bytes, close() {},
    write(next) {
      if (fault === 'before') throw new Error('disk full');
      bytes = next;
      if (fault === 'after') throw Object.assign(new Error('directory sync failed'), { committed: true });
    } }, () => assert.fail('legacy read'));
  const before = store.snapshot;
  fault = 'before';
  assert.throws(() => store.update({ theme: { id: 'xp', filesEnabled: false } }), /disk full/);
  assert.equal(store.snapshot, before);
  fault = 'after';
  assert.throws(() => store.update({ theme: { id: 'bigsur', filesEnabled: false } }), error => error.committed);
  assert.deepEqual(store.snapshot, JSON.parse(decodeUtf8(bytes)));
  assert.equal(store.snapshot.theme.id, 'bigsur');
});

test('strict legacy byte records migrate known Unicode preferences and reject incomplete/invalid sections', () => {
  const workspace = { version: 1, names: ['\u8d44\u6599\ud83d\udc30'], active: 0 };
  const legacy = entries => encodeUtf8('PUST1\n' + entries.map(([key, value]) =>
    [key, value].map(field => encodeUtf8(field).length + '\n' + field + '\n').join('')).join(''));
  const bytes = legacy([['desktop.theme', 'bigsur'], ['desktop.theme.files', 'disabled'],
    ['desktop.workspaces.v1', JSON.stringify(workspace)], ['unknown', 'left untouched']]);
  assert.deepEqual(migrateShellConfiguration(bytes), { ...defaultShellConfiguration(),
    theme: { id: 'bigsur', filesEnabled: false }, workspace });
  for (const bad of [bytes.slice(0, -1), encodeUtf8('PUST1\n999999999999999999999\nx\n'),
    legacy([['desktop.audio.v1', '{"version":2}']]), legacy([['desktop.theme.files', 'off']]),
    legacy([['desktop.theme', 'xp'], ['desktop.theme', 'lion']])])
    assert.throws(() => migrateShellConfiguration(bad));
  assert.throws(() => validateShellConfiguration({ ...defaultShellConfiguration(), section: {} }));
});

test('invalid existing JSON never reads legacy or writes a replacement, and closes failed handles', () => {
  for (const text of ['{broken', '{"version":2}', JSON.stringify({ ...defaultShellConfiguration(), unknown: 1 })]) {
    let closes = 0;
    assert.throws(() => createShellConfiguration({
      read: () => encodeUtf8(text), write() { assert.fail('invalid document overwritten'); }, close() { closes++; },
    }, () => assert.fail('legacy fallback')));
    assert.equal(closes, 1);
  }
});

test('v1/v2/v3 migrate atomically to v4 once preserving all old fields, bindings and launcher pins', () => {
  const populated = { ...defaultShellConfiguration(), theme: { id: 'bigsur', filesEnabled: false },
    audio: { version: 1, preferredSink: 'speaker', preferredSource: '', devices: [
      { name: 'speaker', class: 'Audio/Sink', volume: 0.4, muted: false }] },
    display: { version: 1, heads: [{ name: 'DP-1', make: 'Fixture', model: 'Display', serialNumber: 'A',
      enabled: true, width: 1280, height: 720, refresh: 60000, scale: 1, transform: 0, x: 0, y: 0, adaptiveSync: false }] },
    workspace: { version: 1, names: ['Code', 'Notes'], active: 1 },
    shortcuts: fixtureShortcuts.filter(binding => !['tile-left', 'tile-right', 'restore-floating'].includes(binding.action))
      .map(({ action, key, modifiers }) => ({ action, key, modifiers })),
    desktop: { version: 1, shortcuts: [{ id: 'files.desktop', name: 'Files',
      output: { name: 'DP-1', make: 'Fixture', model: 'Display', serialNumber: 'A' }, x: 16, y: 16 }] } };
  populated.launchers = { version: 1, applications: ['saved.desktop', 'bundle:org.example.notes'] };
  for (const version of [1, 2, 3]) {
    const { launchers, ...source } = populated;
    source.version = version;
    if (version === 3) source.launchers = launchers;
    if (version === 1) delete source.desktop;
    let bytes = encodeUtf8(JSON.stringify(source)), writes = 0;
    const expected = { ...populated, desktop: version === 1 ? { version: 1, shortcuts: [] } : populated.desktop,
      launchers: version === 3 ? launchers : { version: 1, applications: [] },
      shortcuts: [...source.shortcuts, { action: 'tile-left', modifiers: 8, key: 'Left' },
        { action: 'tile-right', modifiers: 8, key: 'Right' }, { action: 'restore-floating', modifiers: 8, key: 'Down' }] };
    const files = { read: () => bytes, close() {}, write(next, initial) {
      assert.equal(initial, false); bytes = next.slice(); writes++;
    } };
    let store = createShellConfiguration(files, () => assert.fail('JSON migration cannot reread legacy'));
    assert.deepEqual(store.snapshot, expected);
    assert.equal(writes, 1);
    store.close();
    store = createShellConfiguration(files, () => assert.fail('JSON restart cannot reread legacy'));
    assert.deepEqual(store.snapshot, expected);
    assert.equal(writes, 1);
    store.close();
    for (const committed of [false, true]) {
      bytes = encodeUtf8(JSON.stringify(source));
      assert.throws(() => createShellConfiguration({ read: () => bytes, close() {},
        write(next) {
          if (committed) bytes = next.slice();
          throw Object.assign(new Error('migration failure'), { committed });
        } }, () => assert.fail('invalid migration fallback')), error => error.committed === committed);
      assert.deepEqual(JSON.parse(decodeUtf8(bytes)), committed ? expected : source);
    }
  }
});

test('legacy shortcut collisions disable only new defaults and diagnose once after publication', () => {
  for (const version of [1, 2, 3]) for (const shortcuts of [null,
    fixtureShortcuts.slice(0, 7).map(binding => ({ action: binding.action, modifiers: binding.modifiers, key: binding.key })),
    fixtureShortcuts.slice(0, 7).map((binding, index) => ({ action: binding.action,
      modifiers: index < 3 ? 8 : 0, key: index === 0 ? 'left' : index === 1 ? 'Right' : index === 2 ? 'Down' : '' }))]) {
    const source = { ...defaultShellConfiguration(), version, shortcuts };
    if (version < 3) delete source.launchers;
    if (version === 1) delete source.desktop;
    let bytes = encodeUtf8(JSON.stringify(source)), writes = 0;
    const reports = [];
    const files = { read: () => bytes, close() {}, write(next) { bytes = next.slice(); writes++; } };
    const create = () => createShellConfiguration(files, () => assert.fail('legacy reread'), value => reports.push(value));
    let store = create();
    assert.equal(store.snapshot.version, 4);
    if (shortcuts === null) assert.equal(store.snapshot.shortcuts, null);
    else {
      assert.deepEqual(store.snapshot.shortcuts.slice(0, 7), shortcuts);
      assert.equal(store.snapshot.shortcuts.length, 10);
      const conflict = shortcuts[0].modifiers === 8;
      assert.deepEqual(store.snapshot.shortcuts.slice(7).map(binding => [binding.modifiers, binding.key]),
        conflict ? [[0, ''], [0, ''], [0, '']] : [[8, 'Left'], [8, 'Right'], [8, 'Down']]);
      assert.equal(reports.length, conflict ? 1 : 0);
    }
    const saved = bytes.slice(), count = reports.length;
    store.close(); store = create(); store.close();
    assert.deepEqual(bytes, saved); assert.equal(writes, 1); assert.equal(reports.length, count);
  }
});

test('launcher pins are strict ordered independent snapshots and follow actual publication on failure', () => {
  let bytes = encodeUtf8(JSON.stringify(defaultShellConfiguration())), fault = '';
  const store = createShellConfiguration({ read: () => bytes, close() {}, write(next) {
    if (fault === 'before') throw new Error('disk full');
    bytes = next.slice();
    if (fault === 'after') throw Object.assign(new Error('directory sync failed'), { committed: true });
  } }, () => assert.fail('legacy read'));
  const applications = ['bundle:org.example.notes', 'Files \u8d44\u6599.desktop', 'uninstalled.desktop'];
  store.update({ launchers: { version: 1, applications } });
  applications.reverse();
  assert.deepEqual(store.snapshot.launchers.applications, [...applications].reverse());
  assert.ok(Object.isFrozen(store.snapshot.launchers.applications));
  const pins = store.snapshot.launchers;
  store.update({ desktop: { version: 1, shortcuts: [] }, workspace: { version: 1, names: ['Only'], active: 0 } });
  assert.deepEqual(store.snapshot.launchers, pins);
  const desktop = store.snapshot.desktop, before = store.snapshot;
  for (const launchers of [null, [], {}, { version: 2, applications: [] }, { version: 1, applications: [], extra: true },
    { version: 1, applications: Array(33).fill('files.desktop') }, { version: 1, applications: ['x', 'x'] },
    ...[null, 4, '', '/file.desktop', '../file.desktop', 'a\\b', 'x\0', '\ud800', 'x'.repeat(256)].map(id =>
      ({ version: 1, applications: [id] }))])
    assert.throws(() => store.update({ launchers }));
  assert.equal(store.snapshot, before);
  fault = 'before';
  assert.throws(() => store.update({ launchers: { version: 1, applications: [] } }), /disk full/);
  assert.equal(store.snapshot, before);
  fault = 'after';
  assert.throws(() => store.update({ launchers: { version: 1, applications: [] } }), error => error.committed);
  assert.deepEqual(store.snapshot.launchers.applications, []);
  assert.deepEqual(store.snapshot.desktop, desktop);
  assert.deepEqual(store.snapshot, JSON.parse(decodeUtf8(bytes)));
  store.close();
});

test('shortcut publication failure keeps acknowledged bindings; uncommitted failure restores them', async () => {
  const { saveShortcuts } = await import('../shell/shortcuts.mjs');
  const { fixtureShortcuts } = await import('./configuration-memory.mjs');
  const previous = fixtureShortcuts.map(({ action, key, modifiers }) => ({ action, key, modifiers }));
  let applied = previous, committed = false;
  const next = previous.map(binding => binding.action === 'minimize-window' ? { ...binding, key: 'm', modifiers: 2 } : binding);
  const native = { shortcuts: () => applied, setShortcuts(bindings) { applied = bindings; } };
  const files = { update() { throw Object.assign(new Error('fixture'), { committed }); } };
  assert.throws(() => saveShortcuts(native, files, next));
  assert.equal(applied, previous);
  committed = true;
  assert.throws(() => saveShortcuts(native, files, next));
  assert.equal(applied, next);
});
