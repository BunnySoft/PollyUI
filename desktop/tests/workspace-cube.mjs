import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
register('./root-loader.mjs', import.meta.url);
const { workspaceCubePreferences } = await import('./desktop/shared/ui/workspace-cube.mjs');
const { memoryConfiguration } = await import('./desktop/tests/configuration-memory.mjs');
const { parseAppearance } = await import('./desktop/client/settings-contract.mjs');
const { BUILTIN_THEME_CATALOG } = await import('./desktop/shell/themes.mjs');

test('cube policy is opt-in, strict and independent of window switcher and wallpaper motion', () => {
  const configuration = memoryConfiguration();
  assert.equal(configuration.snapshot.theme.workspaceCube, undefined);
  for (const policy of [null, {}, { enabled: 1, motion: true }, { enabled: true, motion: null },
    { enabled: true, motion: true, count: 4 }]) {
    assert.throws(() => workspaceCubePreferences(policy));
    assert.throws(() => configuration.update({ theme: { ...configuration.snapshot.theme, workspaceCube: policy } }));
  }
  const policy = { enabled: true, motion: false };
  configuration.update({ theme: { ...configuration.snapshot.theme, workspaceCube: policy,
    switcherMotion: true, wallpaper: { mode: 'aurora', reducedMotion: false } } });
  policy.motion = true;
  assert.deepEqual(configuration.snapshot.theme.workspaceCube, { enabled: true, motion: false });
  assert.equal(configuration.snapshot.theme.switcherMotion, true);
  assert.equal(configuration.snapshot.theme.wallpaper.reducedMotion, false);
  configuration.close();
});

test('Settings admits only complete typed cube capability and error snapshots', () => {
  const value = { version: 1, revision: 1, catalogRevision: 1,
    themeId: BUILTIN_THEME_CATALOG.themes[0].id, catalog: BUILTIN_THEME_CATALOG,
    themeFilesEnabled: false, themeFilesAvailable: true, status: '', error: '',
    build: { version: 'fixture', revision: 'unknown', sourceDirty: null },
    workspaceCube: { enabled: true, motion: false, available: true, reason: '', error: '' } };
  assert.deepEqual(parseAppearance(JSON.stringify(value)).workspaceCube, value.workspaceCube);
  for (const patch of [{ enabled: 1 }, { motion: null }, { available: 1 }, { error: [] }, { count: 4 }])
    assert.throws(() => parseAppearance(JSON.stringify({ ...value, workspaceCube: { ...value.workspaceCube, ...patch } })));
  const incomplete = { ...value.workspaceCube }; delete incomplete.reason;
  assert.throws(() => parseAppearance(JSON.stringify({ ...value, workspaceCube: incomplete })));
});
