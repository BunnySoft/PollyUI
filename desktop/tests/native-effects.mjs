import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
register('./root-loader.mjs', import.meta.url);
const { getDesktopTheme } = await import('../shell/themes.mjs');
const { validateTheme } = await import('../shared/ui/theme-schema.mjs');
const { DECORATION_LAYOUT_FIELDS, decorationLayout, encodeDecorationLayout } =
  await import('../shared/ui/caption-layout.mjs');

test('existing radius and preview shadow do not silently opt native windows in', () => {
  for (const id of ['modern', 'xp', 'aqua']) {
    const theme = getDesktopTheme(id);
    assert.equal(decorationLayout(theme).effect_radius, 0);
    assert.equal(encodeDecorationLayout(theme)[0], 5);
  }
});
test('optional native effects select only validated numeric radius', () => {
  const theme = structuredClone(getDesktopTheme('modern'));
  theme.window.nativeEffects = 'rounded';
  theme.window.radius = 24;
  validateTheme(theme);
  assert.equal(decorationLayout(theme).effect_radius, 24);
  const encoded = encodeDecorationLayout(theme);
  assert.equal(encoded.length, DECORATION_LAYOUT_FIELDS.length + 2);
  assert.equal(encoded.at(-1), 24);
  const none = structuredClone(theme);
  none.window.nativeEffects = 'none';
  assert.equal(decorationLayout(validateTheme(none)).effect_radius, 0);
});
test('unknown modes, implicit booleans and invalid radii are rejected', () => {
  for (const mode of ['blur', 'rounded-shadow', true, 1, null]) {
    const theme = structuredClone(getDesktopTheme('modern'));
    theme.window.nativeEffects = mode;
    assert.throws(() => validateTheme(theme), /nativeEffects/);
  }
  for (const radius of [-1, 65, NaN, 0.5]) {
    const theme = structuredClone(getDesktopTheme('modern'));
    theme.window.nativeEffects = 'rounded';
    theme.window.radius = radius;
    assert.throws(() => validateTheme(theme), /radius/);
  }
});
