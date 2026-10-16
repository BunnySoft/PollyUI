import assert from 'node:assert/strict';
import { register } from 'node:module';
register('../../desktop/tests/root-loader.mjs', import.meta.url);
const { selectionAppearance } = await import('../sdk/js/selection-appearance.mjs');
const { theme } = await import('../sdk/js/naive.mjs');
const { fontFamily, requireFontFamily } = await import('../sdk/js/font-family.mjs');
const before = JSON.stringify(theme);
const input = { colors: { primary: '#123456', text: '#112233' }, metrics: { fontSize: 11, markerSize: 13, radius: 0 } };
const copy = JSON.stringify(input), projected = selectionAppearance(input, theme);
assert.equal(projected.colors.primary, '#123456');
assert.equal(projected.metrics.markerSize, 13);
assert.equal(selectionAppearance(undefined, theme).custom, false);
const defaults = selectionAppearance(undefined, theme).metrics;
assert.throws(() => { defaults.fontSize = 63; }, TypeError);
assert.equal(selectionAppearance(undefined, theme).metrics.fontSize, 14, 'Default metrics cannot leak mutation into another instance');
assert.equal(JSON.stringify(theme), before);
assert.equal(JSON.stringify(input), copy);
for (const appearance of [null, [], 3, { other: true }, { colors: { unknown: 'red' } }, { colors: { primary: 3 } },
  { paint: true }, { decorate: 'no' }, { revision: 3 }])
  assert.throws(() => selectionAppearance(appearance, theme), TypeError);
for (const metrics of [{ fontSize: 7 }, { markerSize: NaN }, { knobSize: 70 }, { radioDot: 20 },
  { disabledOpacity: 2 }, { optionHeight: 10 }, { switchHeight: 12, knobSize: 18 }])
  assert.throws(() => selectionAppearance({ metrics }, theme), RangeError);
console.log('PASS: validated per-instance selection appearance, fitting metrics, unchanged caller data and no SDK global mutation');
for (const value of ['Consolas', 'Noto Sans CJK SC', '\u5fae\u8f6f\u96c5\u9ed1', 'a'.repeat(128)])
  assert.equal(fontFamily(value), value);
for (const value of [null, 12, '', ' a', 'a ', 'a'.repeat(129), '/font.ttf', 'C:\\font.ttf',
  'https://font', 'Arial, sans-serif', 'url(font)', 'a\nb', 'a\0b', 'x; color:red'])
  assert.throws(() => fontFamily(value), TypeError);
assert.equal(requireFontFamily(undefined), undefined);
const savedMeasure = globalThis.measureText, savedLayout = globalThis.layoutText;
try {
  globalThis.measureText = () => 10;
  assert.throws(() => requireFontFamily('Consolas'), /font-family-aware/);
  measureText.supportsFontFamily = true;
  globalThis.layoutText = () => ({});
  assert.throws(() => selectionAppearance({ fontFamily: 'Consolas' }, theme), /font-family-aware/);
  layoutText.supportsFontFamily = true;
  const a = selectionAppearance({ fontFamily: 'Consolas' }, theme);
  const b = selectionAppearance({ fontFamily: 'Arial' }, theme);
  assert.equal(a.fontFamily, 'Consolas'); assert.notEqual(a.signature, b.signature);
  assert.equal(selectionAppearance(undefined, theme).fontFamily, undefined);
} finally {
  if (savedMeasure === undefined) delete globalThis.measureText; else globalThis.measureText = savedMeasure;
  if (savedLayout === undefined) delete globalThis.layoutText; else globalThis.layoutText = savedLayout;
}
console.log('PASS: literal family validation, explicit provider capabilities and per-instance family signatures');
