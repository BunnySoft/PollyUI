import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
register('./root-loader.mjs', import.meta.url);
const { getDesktopTheme } = await import('../shared/ui/themes.mjs');
const { panelViewport, withPanelScrollbar } = await import('../shared/ui/panel-viewport.mjs');
const { h } = await import('../../gui/sdk/js/reconciler.mjs');
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

test('vertical overlay is explicit and existing-list attachment preserves the viewport and command slots', () => {
  const list = h('view', { id: 'existing-list', style: {
    flexGrow: 1, flexBasis: 0, minHeight: 0, overflow: 'scroll', gap: 7,
  } }, h('view', { id: 'original-command', tabIndex: 0 }));
  const area = withPanelScrollbar(theme, list);
  assert.strictEqual(area.children[0], list);
  assert.equal(list.children[0].props.id, 'original-command');
  assert.equal(area.children[1].props.role, 'scrollbar');
  assert.equal(area.children[1].props['aria-controls'], 'existing-list');
  assert.equal(list.props.style.paddingRight, undefined, 'overlay does not shrink command widths');
  const panel = panelViewport(theme, { id: 'overlay', scrollbar: true }, 'Original content');
  assert.equal(panel.children[0].children[0].props.id, 'overlay-viewport');
  assert.equal(panel.children.at(-1).props.className, 'theme-bevel');
  for (const options of [{ scrollbar: 'overlay' }, { scrollbar: true, axis: 'horizontal' },
    { scrollbar: true, sizing: 'content' }])
    assert.throws(() => panelViewport(theme, { id: 'invalid', ...options }), TypeError);
  assert.throws(() => withPanelScrollbar(theme, h('view', { id: 'not-scrollable' })), TypeError);
});
