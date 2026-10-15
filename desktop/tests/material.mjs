import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWallpaperMaterial } from '../shared/ui/material.mjs';
import { getDesktopTheme, DEFAULT_DESKTOP_THEME } from '../shared/ui/themes.mjs';

const theme = getDesktopTheme(DEFAULT_DESKTOP_THEME);
function provider({ filter = true, deferred = false } = {}) {
  const canvases = [], images = [], waits = [];
  const document = { createElement(kind) {
    if (kind === 'img') {
      const image = { removeAttribute() { this.src = ''; },
        decode: () => deferred ? new Promise((resolve, reject) => waits.push({ resolve, reject })) : Promise.resolve() };
      images.push(image); return image;
    }
    const context = { scale() {}, translate() {}, rotate() {}, save() {}, restore() {},
      beginPath() {}, roundRect() {}, fill() {}, stroke() {}, fillRect() {}, drawImage() {},
      createLinearGradient: () => ({ addColorStop() {} }), ...(filter ? { filter: 'none' } : {}) };
    let width = 300, height = 150;
    const canvas = { maxArea: 0, style: {}, getContext: () => context,
      get width() { return width; }, set width(value) { width = value; this.maxArea = Math.max(this.maxArea, width * height); },
      get height() { return height; }, set height(value) { height = value; this.maxArea = Math.max(this.maxArea, width * height); } };
    canvases.push(canvas); return canvas;
  } };
  return { document, canvases, images, waits };
}
const input = (extra = {}) => ({ theme, width: 320, height: 180, ...extra });
const setup = options => {
  const fake = provider(options), errors = [];
  return { ...fake, errors, material: createWallpaperMaterial({ document: fake.document,
    onError: error => errors.push(error) }) };
};

test('unchanged updates do no decode, wallpaper paint, blur or composite', async () => {
  const { material } = setup();
  assert.equal(await material.update(input({ asset: 'wallpaper.png' })), true);
  const first = material.stats;
  assert.equal(await material.update(input({ asset: 'wallpaper.png' })), false);
  assert.deepEqual(material.stats, first);
  assert.deepEqual([first.decodes, first.wallpaperPaints, first.blurs, first.composites], [1, 1, 1, 1]);
  material.dispose();
});
test('activation/tint reuses blur; source, desktop, geometry and DPI invalidate explicitly', async () => {
  const { material } = setup();
  let value = input({ asset: 'wallpaper.png' });
  await material.update(value);
  await material.update({ ...value, active: false });
  const tinted = { ...theme, colors: { ...theme.colors, surface: '#c0d0e0' } };
  await material.update({ ...value, theme: tinted });
  assert.equal(material.stats.blurs, 1); assert.equal(material.stats.composites, 3);
  for (const change of [{ width: 321 }, { height: 181 }, { scale: 2 }, { sourceRevision: 1 },
    { asset: 'other.png' }, { theme: { ...theme, desktop: { ...theme.desktop, from: '#123456' } } }]) {
    value = { ...value, ...change }; await material.update(value);
  }
  assert.equal(material.stats.blurs, 7); assert.equal(material.stats.decodes, 3);
  material.dispose();
});
test('huge logical bounds and scale obey the padded pixel budget', async () => {
  const { material, canvases } = setup();
  await material.update(input({ width: 16384, height: 16384, scale: 8, blur: 64 }));
  for (const [width, height] of [[1, 16384], [16384, 1], [1, 16384]])
    await material.update(input({ width, height, scale: 8, blur: 0 }));
  assert.ok(material.stats.width * material.stats.height <= material.stats.maxPixels);
  assert.ok(canvases.every(canvas => canvas.maxArea <= material.stats.maxPixels),
    'Every intermediate resize and padded/scratch allocation respects the exact budget');
  material.dispose();
  assert.ok(canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
});
test('unsupported provider rejects and reports; caller can explicitly recover solid', async () => {
  const { material, errors } = setup({ filter: false });
  await assert.rejects(material.update(input()), /requires Canvas blur support/);
  assert.equal(errors.length, 1); assert.equal(material.stats.ready, false);
  assert.equal(material.canvas.width, 0);
  assert.equal(await material.update(input({ mode: 'solid' })), true);
  assert.equal(material.stats.blurs, 0); assert.equal(material.canvas.width, 1);
  material.dispose();
});
test('decode failures report and clear success; retry does not reuse rejected source', async () => {
  const { material, waits, errors, images } = setup({ deferred: true });
  await material.update(input());
  const bad = material.update(input({ asset: 'bad.png' }));
  waits[0].reject(new Error('decode failed'));
  await assert.rejects(bad, /decode failed/);
  assert.equal(errors.length, 1); assert.equal(material.stats.ready, false);
  assert.equal(material.canvas.width, 0); assert.equal(images[0].src, '');
  const retry = material.update(input({ asset: 'bad.png' }));
  waits[1].resolve(); assert.equal(await retry, true);
  assert.equal(material.stats.decodes, 2);
  material.dispose();
});
test('inflight identical requests share work; stale decode cannot overwrite newer solid', async () => {
  const { material, waits, errors } = setup({ deferred: true });
  const first = material.update(input({ asset: 'first.png' }));
  assert.equal(material.update(input({ asset: 'first.png' })), first);
  assert.equal(await material.update(input({ mode: 'solid' })), true);
  waits[0].reject(new Error('cancelled decode'));
  assert.equal(await first, false);
  assert.equal(material.stats.composites, 1); assert.equal(errors.length, 0);
  material.dispose();
});
test('invalid requests revoke pending publication and dispose is idempotent', async () => {
  const { material, waits, errors, images } = setup({ deferred: true });
  const loading = material.update(input({ asset: 'first.png' }));
  await assert.rejects(material.update(input({ scale: NaN })), /scale/);
  waits[0].resolve(); assert.equal(await loading, false);
  assert.equal(material.stats.ready, false); assert.equal(errors.length, 1);
  assert.equal(images[0].src, '');
  material.dispose(); material.dispose();
  await assert.rejects(material.update(input()), /disposed/);
  assert.equal(material.stats.disposed, true);
});
test('all caller boundaries reject instead of publishing a success-shaped fallback', async () => {
  for (const extra of [{ width: 0 }, { height: Infinity }, { scale: 0.1 }, { scale: 9 }, { blur: 65 },
    { active: 'yes' }, { mode: 'acrylic' }, { asset: {} }, { sourceRevision: {} }, { theme: {} }]) {
    const { material, errors } = setup();
    await assert.rejects(material.update(input(extra)));
    assert.equal(errors.length, 1); assert.equal(material.stats.ready, false);
    material.dispose();
  }
});
