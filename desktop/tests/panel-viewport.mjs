import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
register('./root-loader.mjs', import.meta.url);
const { getDesktopTheme } = await import('../shared/ui/themes.mjs');
const { panelViewport, withPanelScrollbar } = await import('../shared/ui/panel-viewport.mjs');
const { h, render } = await import('../../gui/sdk/js/reconciler.mjs');
const { applicationHost } = await import('./application-host.mjs');
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

test('ancestor removal retires ownerless pending and active panel scrollbars without descendant leave hooks', async t => {
  applicationHost(t);
  const previous = { requestAnimationFrame, cancelAnimationFrame }, frames = new Map();
  let serial = 0, captured = null;
  globalThis.requestAnimationFrame = callback => { frames.set(++serial, callback); return serial; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  const flush = () => {
    const ready = [...frames.values()]; frames.clear();
    for (const callback of ready) callback(0);
  };
  const descendants = node => [node, ...node.childNodes.flatMap(descendants)];
  try {
    for (const stage of [0, 1, 2, 3]) {
      const panel = panelViewport(getDesktopTheme('modern'), { id: 'retired', scrollbar: true },
        h('view', { id: 'retired-command', tabIndex: 0 }));
      render(h('view', {}, panel), document.body);
      const viewport = document.getElementById('retired-viewport');
      const area = viewport.parentNode, track = area.childNodes[1], command = viewport.firstChild;
      viewport.offsetHeight = track.offsetHeight = 200;
      command.offsetHeight = 600;
      track.offsetWidth = 10;
      track.setMouseCapture = () => { captured = track; };
      track.releaseMouseCapture = () => {
        captured = null;
        for (const callback of track.listeners.get('lostmousecapture') || []) callback({ currentTarget: track });
      };
      for (let i = 0; i < Math.min(stage, 2); i++) flush();
      if (stage >= 2) {
        const down = track.listeners.get('mousedown')[0];
        down({ currentTarget: track, button: 0, clientX: 5, clientY: 10, preventDefault() {}, stopPropagation() {} });
        assert.equal(captured, track);
      }
      const retained = track.listeners.get('keydown')?.[0];
      const oldNodes = descendants(area);
      render(null, document.body);
      for (const node of oldNodes) {
        if (stage !== 1 && stage !== 3) node.ownerDocument = null;
        // Native detached nodes still support child cleanup without a document.
        node.removeChild = child => {
          const index = node.childNodes.indexOf(child);
          assert.ok(index >= 0);
          node.childNodes.splice(index, 1); child.parentNode = null; return child;
        };
      }
      if (stage === 3) document.defaultView = { closed: true };
      if (stage >= 2) {
        const focused = command.listeners.get('focus');
        for (const callback of [...focused]) callback({ currentTarget: command });
      } else flush();
      await Promise.resolve();
      assert.equal(frames.size, 0, 'Retirement cancels all remaining bounded frames');
      assert.equal(captured, null);
      assert.ok([...track.listeners.values()].every(list => list.length === 0), 'Controller and track-wheel listeners are removed');
      assert.equal((command.listeners.get('focus') || []).length, 0, 'Both focus/reveal subscriptions are removed');
      assert.equal(track.childNodes.length, 1, 'Controller-owned decoration is disposed');
      const offset = viewport.scrollTop;
      retained?.({ currentTarget: track, key: 'End', preventDefault() {}, stopPropagation() {} });
      assert.equal(viewport.scrollTop, offset, 'Retained handlers cannot scroll a retired panel');
      let left = 0;
      panel.children[0].props.onLeave(area, () => left++);
      assert.equal(left, 1, 'A later explicit leave is idempotent');
      delete document.defaultView;
    }
  } finally { Object.assign(globalThis, previous); }
});
