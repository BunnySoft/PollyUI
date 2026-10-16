import assert from 'node:assert/strict';
import { register } from 'node:module';
register('../../desktop/tests/root-loader.mjs', import.meta.url);
const { selectionAppearance } = await import('../sdk/js/selection-appearance.mjs');
const { theme } = await import('../sdk/js/naive.mjs');
const before = JSON.stringify(theme);
const input = { colors: { primary: '#123456', text: '#112233' }, metrics: { fontSize: 11, markerSize: 13, radius: 0 } };
const copy = JSON.stringify(input), projected = selectionAppearance(input, theme);
assert.equal(projected.colors.primary, '#123456');
assert.equal(projected.metrics.markerSize, 13);
assert.equal(selectionAppearance(undefined, theme).custom, false);
assert.equal(JSON.stringify(theme), before);
assert.equal(JSON.stringify(input), copy);
for (const appearance of [null, [], 3, { other: true }, { colors: { unknown: 'red' } }, { colors: { primary: 3 } },
  { paint: true }, { decorate: 'no' }, { revision: 3 }])
  assert.throws(() => selectionAppearance(appearance, theme), TypeError);
for (const metrics of [{ fontSize: 7 }, { markerSize: NaN }, { knobSize: 70 }, { radioDot: 20 },
  { disabledOpacity: 2 }, { optionHeight: 10 }, { switchHeight: 12, knobSize: 18 }])
  assert.throws(() => selectionAppearance({ metrics }, theme), RangeError);
console.log('PASS: validated per-instance selection appearance, fitting metrics, unchanged caller data and no SDK global mutation');
