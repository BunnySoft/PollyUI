import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
register('./root-loader.mjs', import.meta.url);
const { getDesktopTheme } = await import('../shell/themes.mjs');
const { validateTheme } = await import('../shared/ui/theme-schema.mjs');
const { DECORATION_LAYOUT_FIELDS, decorationLayout, encodeDecorationLayout } =
  await import('../shared/ui/caption-layout.mjs');

test('Modern and Mac presets explicitly opt into effects; Classic, XP and legacy modes stay none', () => {
  const modern = getDesktopTheme('modern');
  assert.equal(modern.window.nativeEffects, 'rounded');
  assert.equal(modern.window.radius, 8);
  assert.equal(modern.window.shadow, 0);
  assert.equal(decorationLayout(modern).effect_radius, 8);
  for (const [id, radius, shadow] of [['aqua', 6, 20], ['lion', 5, 18], ['bigsur', 10, 24]]) {
    const theme = getDesktopTheme(id), layout = decorationLayout(theme);
    assert.equal(theme.window.nativeEffects, 'rounded-shadow');
    assert.equal(theme.window.radius, radius);
    assert.equal(theme.window.shadow, shadow);
    assert.equal(layout.effect_radius, radius);
    assert.equal(layout.shadow_sigma, Math.ceil(shadow / 2));
    assert.equal(layout.shadow_rgb, 0);
    assert.equal(layout.shadow_active, 24);
    assert.equal(layout.shadow_inactive, 12);
    assert.equal(layout.shadow_x_bias, 64);
    assert.equal(layout.shadow_y_bias, 64 + Math.round(shadow / 4));
    for (const mode of [undefined, 'none']) {
      const legacy = structuredClone(theme);
      delete legacy.window.nativeEffects;
      if (mode !== undefined) legacy.window.nativeEffects = mode;
      const oldLayout = decorationLayout(validateTheme(legacy));
      assert.equal(oldLayout.effect_radius, 0);
      assert.equal(oldLayout.shadow_sigma, 0);
      assert.equal(oldLayout.shadow_active, 0);
      assert.equal(oldLayout.shadow_inactive, 0);
    }
  }
  for (const id of ['xp', 'server2003']) {
    const theme = getDesktopTheme(id);
    assert.equal(decorationLayout(theme).effect_radius, 0);
    assert.equal(encodeDecorationLayout(theme)[0], 7);
  }
  const legacy = structuredClone(modern);
  delete legacy.window.nativeEffects;
  assert.equal(decorationLayout(validateTheme(legacy)).effect_radius, 0);
  assert.equal(encodeDecorationLayout(modern)[0], 7);
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
