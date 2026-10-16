import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
register('./root-loader.mjs', import.meta.url);
const { DESKTOP_THEMES } = await import('../shared/ui/themes.mjs');
const { scrollbarAppearance } = await import('../shared/ui/scrollbar-appearance.mjs');
const { scrollbarAppearance: genericAppearance } = await import('../../gui/sdk/js/scrollbar-appearance.mjs');

test('one cached immutable scrollbar adapter derives six theme surfaces without preset-ID dispatch', () => {
  for (const theme of DESKTOP_THEMES) {
    const before = JSON.stringify(theme), appearance = scrollbarAppearance(theme);
    assert.equal(scrollbarAppearance(theme), appearance);
    assert.ok(Object.isFrozen(appearance)); assert.ok(Object.isFrozen(appearance.metrics));
    assert.deepEqual(scrollbarAppearance({ ...theme, id: 'custom-theme' }).metrics, appearance.metrics);
    const generic = genericAppearance(appearance);
    assert.equal(generic.metrics.minThumbHeight, 28);
    assert.equal(generic.metrics.stepSize, 42, 'appearance does not replace the existing row step policy');
    assert.equal(appearance.metrics.arrowSize > 0, ['classic', 'luna', 'aqua'].includes(theme.button.surfaceStyle));
    assert.ok(appearance.metrics.width > appearance.metrics.thumbInset * 2);
    assert.equal(typeof appearance.paint, 'function'); assert.equal(typeof appearance.decorate, 'function');
    assert.equal(JSON.stringify(theme), before);
    const overlay = scrollbarAppearance(theme, 'overlay');
    assert.equal(scrollbarAppearance(theme, 'overlay'), overlay);
    assert.equal(overlay.metrics.width, 10);
    assert.ok(overlay.metrics.thumbInset * 2 < overlay.metrics.width);
    assert.equal(overlay.metrics.arrowSize, appearance.metrics.arrowSize ? 10 : 0);
    assert.throws(() => scrollbarAppearance(theme, 'thin-blue'), /Unknown scrollbar variant/);
  }
});

test('custom tokens, not palette RGB guesses or global SDK theme, determine scrollbar dimensions', () => {
  const theme = DESKTOP_THEMES[0];
  const custom = { ...theme, id: 'unrelated', layout: { ...theme.layout, fontSize: 16, borderWidth: 2 } };
  assert.equal(scrollbarAppearance(custom).metrics.width, 24);
  const noArrows = { ...custom, button: { ...custom.button, surfaceStyle: 'generic' } };
  assert.equal(scrollbarAppearance(noArrows).metrics.arrowSize, 0);
  assert.deepEqual(scrollbarAppearance({ ...custom, colors: { ...custom.colors, text: '#123456' } }).metrics,
    scrollbarAppearance(custom).metrics);
});
