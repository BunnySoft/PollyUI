import { h } from './gui/sdk/js/reconciler.mjs';
import { panelAppearance, panelDetail } from './desktop/shared/ui/panel-appearance.mjs';
import { scrollDesktop } from './desktop/shared/ui/presentation.mjs';
import { verticalScrollMetrics, createVerticalScrollbar } from './gui/sdk/js/scrollbar.mjs';
import { scrollbarAppearance } from './desktop/shared/ui/scrollbar-appearance.mjs';

const scrollAreas = new WeakMap();
// Removing an ancestor does not necessarily invoke descendant leave hooks.
function liveOwner(node) {
  const owner = node.ownerDocument;
  return owner && !owner.defaultView?.closed && contains(owner.body, node) ? owner : null;
}
function currentArea(node, state) {
  return scrollAreas.get(node) === state && !!liveOwner(node);
}
function updateArea(node) {
  const state = scrollAreas.get(node);
  if (!state) return;
  if (currentArea(node, state)) state.controller?.update();
  else releaseArea(node);
}
function bindArea(node, theme, leave) {
  let state = scrollAreas.get(node);
  if (!state) {
    state = { controller: null, frame: null, bindings: [], bound: new WeakSet() };
    scrollAreas.set(node, state);
  }
  state.appearance = scrollbarAppearance(theme, 'overlay');
  state.leave = leave;
  const weak = new WeakRef(node);
  state.bindings = state.bindings.filter(binding => binding.node.deref());
  const walk = target => {
    if (target.tabIndex >= 0 && !state.bound.has(target)) {
      const focused = () => { const area = weak.deref(); if (area) updateArea(area); };
      target.addEventListener('focus', focused);
      state.bound.add(target);
      state.bindings.push({ node: new WeakRef(target), focused });
    }
    for (const child of target.childNodes) walk(child);
  };
  walk(node.firstChild);
  if (state.controller) {
    if (!currentArea(node, state)) { releaseArea(node); return; }
    state.controller.setAppearance(state.appearance);
    state.controller.update();
  }
  if (state.frame !== null) return;
  state.frame = requestAnimationFrame(() => {
    state.frame = null;
    const area = weak.deref();
    if (!area || scrollAreas.get(area) !== state) return;
    if (!currentArea(area, state)) { releaseArea(area); return; }
    state.frame = requestAnimationFrame(() => {
      state.frame = null;
      const area = weak.deref();
      if (!area || scrollAreas.get(area) !== state) return;
      if (!currentArea(area, state)) { releaseArea(area); return; }
      const viewport = area.firstChild, track = area.childNodes[1];
      if (!state.controller) {
        state.controller = createVerticalScrollbar({
          viewport, track, thumb: track.firstChild, appearance: state.appearance,
          isCurrent: () => {
            const current = weak.deref();
            return !!current && currentArea(current, state);
          },
        });
        state.trackWheel = event => event.stopPropagation();
        track.addEventListener('wheel', state.trackWheel);
      }
      else state.controller.setAppearance(state.appearance);
      state.controller.update();
    });
  });
}
function releaseArea(node) {
  const state = scrollAreas.get(node);
  if (!state) return;
  scrollAreas.delete(node);
  if (state.frame !== null) cancelAnimationFrame(state.frame);
  state.frame = null;
  const controller = state.controller, leave = state.leave;
  state.controller = null; state.leave = null;
  try { controller?.stop(); }
  finally {
    if (state.trackWheel) node.childNodes[1].removeEventListener('wheel', state.trackWheel);
    for (const { node: target, focused } of state.bindings.splice(0)) target.deref()?.removeEventListener('focus', focused);
    leave?.(node.firstChild, () => {});
  }
}
export function updatePanelScrollbar(viewport) {
  if (viewport.parentNode) updateArea(viewport.parentNode);
}
export function releasePanelScrollbar(viewport) {
  if (viewport?.parentNode) releaseArea(viewport.parentNode);
}

// An existing list keeps its ID, direct command children and its own reveal policy.
export function withPanelScrollbar(theme, viewport) {
  if (typeof viewport?.props?.id !== 'string' || !viewport.props.id || viewport.props.style?.overflow !== 'scroll')
    throw new TypeError('A named scrolling viewport is required for an overlay scrollbar');
  const id = viewport.props.id, original = { ...viewport.props };
  const wheel = original.onWheel;
  viewport.props.onWheel = event => {
    if (wheel) wheel(event); else scrollDesktop(event);
    updateArea(event.currentTarget.parentNode);
    event.stopPropagation();
  };
  for (const name of ['onMount', 'onUpdate']) viewport.props[name] = node => {
    original[name]?.(node);
    if (node.parentNode) updateArea(node.parentNode);
  };
  const track = h('view', { id: id + '-scrollbar', role: 'scrollbar', tabIndex: -1,
    'aria-label': 'Scroll list', 'aria-orientation': 'vertical', 'aria-controls': id,
    style: { position: 'absolute', right: 0, top: 0, bottom: 0,
      width: scrollbarAppearance(theme, 'overlay').metrics.width, opacity: 0, pointerEvents: 'none' },
  }, h('view', { id: id + '-scroll-thumb', style: { position: 'absolute', left: 2, right: 2, top: 0, height: 0,
    pointerEvents: 'none' } }));
  return h('view', { id: id + '-scroll-area', style: {
    position: 'relative', flexGrow: original.style.flexGrow, flexShrink: original.style.flexShrink,
    flexBasis: original.style.flexBasis, minHeight: 0, minWidth: 0, overflow: 'hidden',
  },
  onMount: node => bindArea(node, theme, original.onLeave), onUpdate: node => bindArea(node, theme, original.onLeave),
  onLeave: (node, done) => { releaseArea(node); done(); },
  }, viewport, track);
}

const viewports = new WeakMap();
const contains = (parent, node) => {
  for (let current = node; current; current = current.parentNode) if (current === parent) return true;
  return false;
};
function reveal(viewport, force = false) {
  const state = viewports.get(viewport);
  if (!state) return;
  const owner = liveOwner(viewport), node = owner?.activeElement;
  if (!owner) { retireViewport(viewport); return; }
  if (!node || node === viewport || !contains(viewport, node)) return;
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
  if (scrollAreas.has(viewport.parentNode)) updateArea(viewport.parentNode);
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
    const node = weak.deref();
    if (!node || viewports.get(node) !== state) return;
    const owner = liveOwner(node);
    if (!owner) { retireViewport(node); return; }
    if (!contains(node, owner.activeElement)) return;
    reveal(node, state.force); state.force = false;
    // Native rAF runs before layout. These two bounded callbacks observe the
    // intervening layout without retaining a document or a stale focus target.
    state.frame = requestAnimationFrame(() => {
      state.frame = null;
      const node = weak.deref();
      if (!node || viewports.get(node) !== state) return;
      if (!liveOwner(node)) { retireViewport(node); return; }
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
  viewports.delete(viewport);
  if (state.frame !== null) cancelAnimationFrame(state.frame);
  state.frame = null;
  for (const { node, focused } of state.bindings.splice(0)) node.deref()?.removeEventListener('focus', focused);
}
function retireViewport(viewport) {
  releaseViewport(viewport);
  if (scrollAreas.has(viewport.parentNode)) releaseArea(viewport.parentNode);
}

// Chrome and content scrolling are separate surfaces. Embedded pages use
// their existing spacing/body but never acquire another window/dialog frame.
export function panelViewport(theme, { id, framed = true, variant = 'dialog', sizing = 'fixed', axis = 'vertical',
  scrollbar = false }, ...children) {
  if (!['fixed', 'content'].includes(sizing)) throw new RangeError('Unknown panel viewport sizing: ' + sizing);
  if (!['vertical', 'horizontal'].includes(axis)) throw new RangeError('Unknown panel viewport axis: ' + axis);
  if (typeof scrollbar !== 'boolean' || scrollbar && (axis !== 'vertical' || sizing !== 'fixed'))
    throw new TypeError('Panel overlay scrollbar requires fixed vertical sizing');
  const horizontal = axis === 'horizontal', content = sizing === 'content';
  const appearance = framed ? panelAppearance(theme, variant) :
    { padding: theme.layout.contentPadding, gap: theme.layout.contentGap, backgroundColor: theme.colors.body };
  const viewport = h('view', { id: id + '-viewport', className: 'theme-panel-viewport',
    style: { flexGrow: content ? 0 : 1, flexShrink: 1, flexBasis: content ? 'auto' : 0, minHeight: 0, minWidth: 0,
      gap: appearance.gap, overflow: 'scroll', ...(horizontal ? { flexDirection: 'row', alignItems: 'center' } : {}) },
    onMount: node => bindViewport(node, axis), onUpdate: node => bindViewport(node, axis),
    onKeydown: event => { if (event.key === 'Tab' && !event.isComposing) queueReveal(event.currentTarget, true); },
    onLeave: (node, done) => { releaseViewport(node); done(); },
  }, children);
  return h('view', { id, style: { ...appearance, gap: 0, width: '100%', height: content ? 'auto' : '100%',
    minHeight: 0, minWidth: 0, overflow: 'hidden' },
    onWheel: event => {
      const content = scrollbar ? event.currentTarget.firstChild.firstChild : event.currentTarget.firstChild;
      scrollDesktop({ currentTarget: content, deltaX: event.deltaX, deltaY: event.deltaY,
        preventDefault: () => event.preventDefault() }, horizontal);
      if (scrollbar) updateArea(event.currentTarget.firstChild);
      event.stopPropagation();
    },
    onLeave: (node, done) => {
      releaseViewport(scrollbar ? node.firstChild.firstChild : node.firstChild);
      if (scrollbar) releaseArea(node.firstChild);
      done();
    },
  }, scrollbar ? withPanelScrollbar(theme, viewport) : viewport, framed ? panelDetail(theme, variant) : null);
}
