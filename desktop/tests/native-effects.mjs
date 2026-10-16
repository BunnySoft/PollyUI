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
    assert.equal(encodeDecorationLayout(theme)[0], 6);
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
  assert.equal(encoded[2 + DECORATION_LAYOUT_FIELDS.findIndex(([field]) => field === 'effect_radius')], 24);
  const none = structuredClone(theme);
  none.window.nativeEffects = 'none';
  assert.equal(decorationLayout(validateTheme(none)).effect_radius, 0);
});
test('unknown modes, implicit booleans and invalid radii are rejected', () => {
  for (const mode of ['blur', 'shadow', true, 1, null]) {
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
test('shadow policy stays in JS and encodes signed offsets as bounded positive geometry', () => {
  const theme = structuredClone(getDesktopTheme('modern'));
  Object.assign(theme.window, { nativeEffects: 'rounded-shadow', nativeShadowColor: '#1234ab',
    nativeShadowOpacity: 40, nativeShadowInactiveOpacity: 17, nativeShadowX: -8, nativeShadowY: 12 });
  const layout = decorationLayout(validateTheme(theme));
  assert.equal(layout.shadow_rgb, 0x1234ab);
  assert.equal(layout.shadow_active, 40);
  assert.equal(layout.shadow_inactive, 17);
  assert.equal(layout.shadow_x_bias, 56);
  assert.equal(layout.shadow_y_bias, 76);
  assert.equal(layout.shadow_sigma, Math.ceil(theme.window.shadow / 2));
  for (const [field, value] of [['nativeShadowColor', 'red'], ['nativeShadowColor', '#11223344'],
    ['nativeShadowOpacity', 101], ['nativeShadowInactiveOpacity', -1], ['nativeShadowX', -65], ['nativeShadowY', 65]]) {
    const bad = structuredClone(theme);
    bad.window[field] = value;
    assert.throws(() => validateTheme(bad), /nativeShadow/);
  }
});
