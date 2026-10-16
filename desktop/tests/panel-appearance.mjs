import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
register('./root-loader.mjs', import.meta.url);
const { DESKTOP_THEMES } = await import('../shared/ui/themes.mjs');
const { panelAppearance, panelDetail } = await import('../shared/ui/panel-appearance.mjs');
const flatten = node => node && typeof node === 'object' ? [node, ...(node.children ?? []).flatMap(flatten)] : [];

test('panel variants derive shape, spacing and surfaces from all six immutable themes', () => {
  for (const theme of DESKTOP_THEMES) {
    const before = JSON.stringify(theme);
    for (const variant of ['card', 'dialog', 'menu', 'inset']) {
      const style = panelAppearance(theme, variant);
      assert.equal(style.borderRadius, variant === 'dialog' ? theme.window.radius : theme.button.radius);
      assert.equal(style.borderWidth, theme.layout.borderWidth);
      assert.equal(style.borderColor, theme.colors.border);
      assert.equal(style.backgroundColor, variant === 'dialog' ||
        theme.button.surfaceStyle === 'classic' && variant === 'card' ? theme.colors.body : theme.colors.surface);
      assert.equal(style.padding, variant === 'inset' ? 0 :
        variant === 'menu' ? theme.layout.compactPadding : theme.layout.contentPadding);
      assert.equal(style.gap, variant === 'inset' ? 0 :
        variant === 'menu' ? theme.layout.controlGap : theme.layout.contentGap);
      assert.deepEqual(panelAppearance({ ...theme, id: 'custom' }, variant), style, 'no preset-ID dispatch');
      const details = flatten(panelDetail(theme, variant));
      assert.equal(details.length > 0, theme.button.surfaceStyle === 'classic');
      for (const node of details) {
        assert.equal(node.props.style.pointerEvents, 'none');
        assert.equal(node.props['aria-hidden'], 'true');
        assert.equal(node.props.tabIndex, undefined);
        assert.equal(Object.keys(node.props).some(key => /^on[A-Z]/.test(key)), false);
      }
    }
    assert.equal(JSON.stringify(theme), before);
  }
});

test('custom theme tokens stay authoritative; neutral and invalid variants reject explicitly', () => {
  const theme = DESKTOP_THEMES[0], custom = { ...theme, window: { ...theme.window, radius: 17 },
    button: { ...theme.button, radius: 9 }, layout: { ...theme.layout, contentPadding: 19, contentGap: 13,
      compactPadding: 7, controlGap: 5, borderWidth: 2 } };
  assert.equal(panelAppearance(custom).borderRadius, 9);
  assert.equal(panelAppearance(custom, 'dialog').borderRadius, 17);
  assert.equal(panelAppearance(custom).padding, 19);
  assert.equal(panelAppearance(custom, 'menu').padding, 7);
  assert.equal(panelAppearance(custom, 'menu').gap, 5);
  assert.equal(panelAppearance(custom).borderWidth, 2);
  for (const helper of [panelAppearance, panelDetail]) {
    assert.throws(() => helper(null), /neutral consumers/);
    assert.throws(() => helper(theme, 'button'), /Unknown panel variant/);
  }
});
