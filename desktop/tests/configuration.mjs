import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

register('./root-loader.mjs', import.meta.url);
const { createShellConfiguration, defaultShellConfiguration, migrateShellConfiguration,
  validateShellConfiguration } = await import('../shell/configuration.mjs');
const { encodeUtf8, decodeUtf8 } = await import('../../sysrt/sdk/js/encoding.mjs');

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
  for (const value of [{ surprise: true }, { version: 2 }, { audio: { version: 99 } },
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
