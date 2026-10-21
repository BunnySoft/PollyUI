import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';
register('./root-loader.mjs', import.meta.url);
const { companionPreferences, companionPosition, companionInput } = await import('./desktop/shared/ui/companion.mjs');
const { companionAtlas, companionMasks } = await import('./desktop/resources/companions/polly-rabbit.mjs');
const { memoryConfiguration } = await import('./desktop/tests/configuration-memory.mjs');
const { parseAppearance } = await import('./desktop/client/settings-contract.mjs');
const { BUILTIN_THEME_CATALOG } = await import('./desktop/shell/themes.mjs');

test('original companion masks match every actual transparent/visible sprite pixel and stay in the native region budget', () => {
  const png = Buffer.from(companionAtlas.split(',')[1], 'base64'), compressed = [];
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), 768);
  assert.equal(png.readUInt32BE(20), 96);
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset), kind = png.subarray(offset + 4, offset + 8).toString();
    if (kind === 'IDAT') compressed.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const pixels = inflateSync(Buffer.concat(compressed)), stride = 768 * 4 + 1;
  for (let frame = 0; frame < 8; frame++) {
    const mask = companionMasks[frame];
    assert.ok(mask.length > 0 && mask.length <= 63);
    let visible = 0;
    for (let y = 0; y < 96; y++) {
      assert.equal(pixels[y * stride], 0);
      for (let x = 0; x < 96; x++) {
        const alpha = pixels[y * stride + 1 + (frame * 96 + x) * 4 + 3];
        const accepts = mask.some(([rx, ry, width, height]) => x >= rx && y >= ry && x < rx + width && y < ry + height);
        assert.equal(accepts, alpha !== 0, `frame ${frame}, pixel ${x},${y}`);
        visible += alpha !== 0;
      }
    }
    assert.ok(visible > 1000 && visible < 96 * 96 / 2);
    assert.ok(companionInput(mask, { x: 100, y: 200 }, { x: 0, y: 0, width: 200, height: 120 }).length <= 64);
  }
});

test('companion placement clamps to logical output bounds and reserves the taskbar area', () => {
  for (const [width, height] of [[1280, 720], [240, 240], [3840, 2160]]) {
    assert.deepEqual(companionPosition(-100, -100, width, height, 64), { x: 0, y: 0 });
    assert.deepEqual(companionPosition(99999, 99999, width, height, 64),
      { x: width - 96, y: height - 160 });
  }
  for (const values of [[NaN, 0, 1000, 720], [0, 0, 95, 720], [0, 0, 720, 0]])
    assert.throws(() => companionPosition(...values));
});

test('optional companion preferences keep old configurations disabled, remain strict and preserve other effects', () => {
  const configuration = memoryConfiguration();
  assert.equal(configuration.snapshot.theme.companion, undefined);
  const policy = { enabled: true, reducedMotion: true };
  configuration.update({ theme: { ...configuration.snapshot.theme, companion: policy } });
  configuration.update({ theme: { ...configuration.snapshot.theme, switcherStyle: 'flip3d', windowOpacityPercent: 75 } });
  assert.deepEqual(configuration.snapshot.theme.companion, policy);
  for (const value of [null, {}, { enabled: 1, reducedMotion: false },
    { enabled: true, reducedMotion: false, character: 'proprietary' }]) {
    assert.throws(() => companionPreferences(value));
    assert.throws(() => configuration.update({ theme: { ...configuration.snapshot.theme, companion: value } }));
  }
  configuration.close();
});

test('companion Settings DTO rejects invented capability and unknown settings', () => {
  const catalog = BUILTIN_THEME_CATALOG;
  const value = { version: 1, revision: 1, catalogRevision: 1, themeId: catalog.default, catalog,
    themeFilesEnabled: false, themeFilesAvailable: false, status: '', error: '',
    build: { version: 'fixture', revision: 'unknown', sourceDirty: null },
    companion: { enabled: false, reducedMotion: false, available: true, reason: '', error: '' } };
  assert.equal(parseAppearance(JSON.stringify(value)).companion.enabled, false);
  for (const patch of [{ enabled: 1 }, { reducedMotion: null }, { available: 'true' }, { action: 'run' }])
    assert.throws(() => parseAppearance(JSON.stringify({ ...value, companion: { ...value.companion, ...patch } })));
});
