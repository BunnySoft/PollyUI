import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
register('./root-loader.mjs', import.meta.url);
const { getDesktopTheme } = await import('../shared/ui/themes.mjs');
const { panelViewport } = await import('../shared/ui/panel-viewport.mjs');
const theme = getDesktopTheme('server2003');

test('fixed viewport defaults and passive outer-frame ownership stay unchanged', () => {
  const panel = panelViewport(theme, { id: 'fixed' }, 'Original content');
  assert.equal(panel.props.style.height, '100%');
  assert.equal(panel.props.style.overflow, 'hidden');
  assert.equal(panel.children[0].props.style.flexBasis, 0);
  assert.equal(panel.children[0].props.style.flexGrow, 1);
  assert.equal(panel.children[0].props.style.flexShrink, 1);
  assert.equal(panel.children[0].props.style.minHeight, 0);
  assert.equal(panel.children[0].props.style.overflow, 'scroll');
  assert.equal(panel.children.at(-1).props.className, 'theme-bevel');
  assert.equal(panel.children[0].children[0].props.nodeValue, 'Original content');
});

test('content sizing preserves intrinsic basis and horizontal reveal is an explicit axis', () => {
  const panel = panelViewport(theme, { id: 'content', sizing: 'content' }, 'Natural content');
  assert.equal(panel.props.style.height, 'auto');
  assert.equal(panel.children[0].props.style.flexBasis, 'auto');
  assert.equal(panel.children[0].props.style.flexGrow, 0);
  assert.equal(panel.children[0].props.style.flexShrink, 1);
  assert.equal(panel.props.style.maxHeight, undefined, 'Consumer geometry owns maximum height');
  const crumbs = panelViewport(theme, { id: 'crumbs', variant: 'inset', axis: 'horizontal' });
  assert.equal(crumbs.children[0].props.style.flexDirection, 'row');
  assert.equal(crumbs.children[0].props.style.alignItems, 'center');
  assert.equal(crumbs.props.style.padding, theme.layout.borderWidth);
  assert.throws(() => panelViewport(theme, { id: 'bad', sizing: 'fill-and-measure' }), RangeError);
  assert.throws(() => panelViewport(theme, { id: 'bad', axis: 'both' }), RangeError);
});
