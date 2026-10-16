import { h } from './gui/sdk/js/reconciler.mjs';
import { panelAppearance, panelDetail } from './desktop/shared/ui/panel-appearance.mjs';
import { scrollDesktop } from './desktop/shared/ui/presentation.mjs';
import { verticalScrollMetrics } from './gui/sdk/js/scrollbar.mjs';

const viewports = new WeakMap();
const contains = (parent, node) => {
  for (let current = node; current; current = current.parentNode) if (current === parent) return true;
  return false;
};
function reveal(viewport, force = false) {
  const state = viewports.get(viewport);
  const owner = viewport.ownerDocument, node = owner?.activeElement;
  if (!state || !owner || !contains(owner.body, viewport) || !node || node === viewport || !contains(viewport, node)) return;
  const target = node.getBoundingClientRect(), clip = viewport.getBoundingClientRect();
  const horizontal = state.axis === 'horizontal';
  if ((horizontal ? clip.width : clip.height) <= 0 || (horizontal ? target.width : target.height) <= 0) return;
  const geometry = [state.axis, viewport.offsetWidth, viewport.offsetHeight,
    horizontal ? node.offsetLeft - viewport.offsetLeft : node.offsetTop - viewport.offsetTop,
    node.offsetWidth, node.offsetHeight].join(':');
  const unchanged = state.focus?.deref() === node && state.geometry === geometry;
  state.focus = new WeakRef(node); state.geometry = geometry;
  // Repainting unchanged content must not undo an intentional wheel scroll.
  if (unchanged && !force) return;
  if (horizontal) {
    const delta = target.left < clip.left ? target.left - clip.left : target.right > clip.right ? target.right - clip.right : 0;
    if (delta) scrollDesktop({ currentTarget: viewport, deltaX: delta, preventDefault() {} }, true);
  } else {
    const delta = target.top < clip.top ? target.top - clip.top : target.bottom > clip.bottom ? target.bottom - clip.bottom : 0;
    if (delta) viewport.scrollTop = Math.max(0, Math.min(verticalScrollMetrics(viewport).maximum, viewport.scrollTop + delta));
  }
}
function queueReveal(viewport, force = false) {
  const state = viewports.get(viewport);
  if (!state) return;
  state.force = state.force || force;
  if (state.queued || state.frame !== null) return;
  state.queued = true;
  const weak = new WeakRef(viewport);
  Promise.resolve().then(() => {
    state.queued = false;
    const node = weak.deref(), owner = node?.ownerDocument;
    if (!owner || viewports.get(node) !== state || !contains(owner.body, node) || !contains(node, owner.activeElement)) return;
    reveal(node, state.force); state.force = false;
    // Native rAF runs before layout. These two bounded callbacks observe the
    // intervening layout without retaining a document or a stale focus target.
    state.frame = requestAnimationFrame(() => {
      if (!weak.deref() || viewports.get(weak.deref()) !== state) return;
      state.frame = requestAnimationFrame(() => {
        state.frame = null;
        const current = weak.deref();
        if (current && viewports.get(current) === state) {
          reveal(current, state.force); state.force = false;
        }
      });
    });
  });
}
function bindViewport(viewport, axis) {
  let state = viewports.get(viewport);
  if (!state) {
    state = { frame: null, queued: false, bindings: [], bound: new WeakSet() };
    viewports.set(viewport, state);
  }
  state.axis = axis;
  state.bindings = state.bindings.filter(({ node }) => node.deref());
  const weak = new WeakRef(viewport);
  const walk = node => {
    if (node.tabIndex >= 0 && !state.bound.has(node)) {
      const focused = () => { const current = weak.deref(); if (current) queueReveal(current, true); };
      node.addEventListener('focus', focused);
      state.bound.add(node);
      state.bindings.push({ node: new WeakRef(node), focused });
    }
    for (const child of node.childNodes) walk(child);
  };
  walk(viewport);
  queueReveal(viewport);
}
function releaseViewport(viewport) {
  const state = viewports.get(viewport);
  if (!state) return;
  if (state.frame !== null) cancelAnimationFrame(state.frame);
  for (const { node, focused } of state.bindings) node.deref()?.removeEventListener('focus', focused);
  viewports.delete(viewport);
}

// Chrome and content scrolling are separate surfaces. Embedded pages use
// their existing spacing/body but never acquire another window/dialog frame.
export function panelViewport(theme, { id, framed = true, variant = 'dialog', sizing = 'fixed', axis = 'vertical' }, ...children) {
  if (!['fixed', 'content'].includes(sizing)) throw new RangeError('Unknown panel viewport sizing: ' + sizing);
  if (!['vertical', 'horizontal'].includes(axis)) throw new RangeError('Unknown panel viewport axis: ' + axis);
  const horizontal = axis === 'horizontal', content = sizing === 'content';
  const appearance = framed ? panelAppearance(theme, variant) :
    { padding: theme.layout.contentPadding, gap: theme.layout.contentGap, backgroundColor: theme.colors.body };
  return h('view', { id, style: { ...appearance, gap: 0, width: '100%', height: content ? 'auto' : '100%',
    minHeight: 0, minWidth: 0, overflow: 'hidden' },
    onWheel: event => {
      scrollDesktop({ currentTarget: event.currentTarget.firstChild, deltaX: event.deltaX, deltaY: event.deltaY,
        preventDefault: () => event.preventDefault() }, horizontal);
      event.stopPropagation();
    },
    onLeave: (node, done) => { releaseViewport(node.firstChild); done(); },
  }, h('view', { id: id + '-viewport', className: 'theme-panel-viewport',
    style: { flexGrow: content ? 0 : 1, flexShrink: 1, flexBasis: content ? 'auto' : 0, minHeight: 0, minWidth: 0,
      gap: appearance.gap, overflow: 'scroll', ...(horizontal ? { flexDirection: 'row', alignItems: 'center' } : {}) },
    onMount: node => bindViewport(node, axis), onUpdate: node => bindViewport(node, axis),
    onKeydown: event => { if (event.key === 'Tab') queueReveal(event.currentTarget, true); },
    onLeave: (node, done) => { releaseViewport(node); done(); },
  }, children), framed ? panelDetail(theme, variant) : null);
}
