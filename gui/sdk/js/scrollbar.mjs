import { scrollbarAppearance, scrollbarStyles } from './gui/sdk/js/scrollbar-appearance.mjs';

// Geometry is unscrolled absolute layout, matching the native overflow contract.
export function verticalScrollMetrics(viewport, trackHeight = viewport.offsetHeight,
  { minThumbHeight = 28, startInset = 0, endInset = 0 } = {}) {
  if (![minThumbHeight, startInset, endInset].every(Number.isFinite) ||
      minThumbHeight <= 0 || startInset < 0 || endInset < 0)
    throw new RangeError('Invalid vertical scrollbar geometry');
  const height = viewport.offsetHeight;
  const content = viewport.childNodes.reduce((end, child) =>
    Math.max(end, child.offsetTop + child.offsetHeight - viewport.offsetTop), height);
  const maximum = Math.max(0, content - height);
  const value = Math.max(0, Math.min(maximum, Number(viewport.scrollTop)));
  const lane = Math.max(0, trackHeight - startInset - endInset);
  const thumbHeight = Math.min(lane, Math.max(minThumbHeight, content > 0 ? lane * height / content : lane));
  const travel = Math.max(0, lane - thumbHeight);
  return { height, content, maximum, value, thumbHeight, travel,
    top: startInset + (maximum ? value / maximum * travel : 0) };
}

export function createVerticalScrollbar({ viewport, track, thumb, isCurrent = () => true, appearance }) {
  let drag = null, stopped = false, skin = null, source, cleanup = null, parts = null;
  let hovered = null, held = null, enabled = false, lastMetrics = null, lastPaint = '';
  let focused = track.ownerDocument.activeElement === track;
  const originals = new Map();
  const listeners = [];
  const listen = (type, callback) => {
    track.addEventListener(type, callback);
    listeners.push([type, callback]);
  };
  function write(node, style, remember = false) {
    for (const [key, value] of Object.entries(style)) {
      if (remember) {
        if (!originals.has(node)) originals.set(node, new Map());
        const saved = originals.get(node);
        if (!saved.has(key)) saved.set(key, node.style[key]);
      }
      if (node.style[key] !== String(value)) node.style[key] = String(value);
    }
  }
  function paint() {
    if (!skin || stopped) return;
    const state = { hovered: enabled ? hovered : null, held: enabled ? held : null,
      dragging: enabled && !!drag, focused: enabled && focused,
      disabled: !enabled, overflow: !!lastMetrics?.maximum,
      atStart: !lastMetrics || lastMetrics.value <= 0, atEnd: !lastMetrics || lastMetrics.value >= lastMetrics.maximum };
    const signature = JSON.stringify(state);
    if (signature === lastPaint) return;
    if (skin.paint)
      for (const [node, style] of scrollbarStyles(skin.paint({ ...state, metrics: skin.metrics }, parts), parts))
        write(node, style, true);
    lastPaint = signature;
  }
  function arrowSize() { return skin ? Math.min(skin.metrics.arrowSize, Math.max(0, track.offsetHeight / 2)) : 0; }
  function hit(event) {
    const box = track.getBoundingClientRect(), x = event.clientX - box.x, y = event.clientY - box.y;
    if (x < 0 || x >= box.width || y < 0 || y >= box.height) return null;
    const arrow = arrowSize();
    return arrow && y < arrow ? 'decrement' : arrow && y >= box.height - arrow ? 'increment' :
      lastMetrics && y >= lastMetrics.top && y <= lastMetrics.top + lastMetrics.thumbHeight ? 'thumb' : 'track';
  }
  function cancel(release = false) {
    const capture = drag;
    drag = null;
    clearHeld();
    if (release && capture) track.releaseMouseCapture();
  }
  function clearHeld() { held = null; paint(); }
  function update() {
    if (stopped) return null;
    focused = track.ownerDocument.activeElement === track;
    if (!isCurrent()) {
      enabled = false;
      cancel(true);
      if (track.tabIndex !== -1) track.tabIndex = -1;
      write(track, { pointerEvents: 'none', opacity: 0 });
      if (track.getAttribute('aria-disabled') !== 'true') track.setAttribute('aria-disabled', 'true');
      paint();
      return null;
    }
    const arrow = arrowSize();
    if (skin) {
      if (skin.metrics.width !== undefined) write(track, { width: skin.metrics.width }, true);
      if (skin.metrics.thumbInset !== undefined)
        write(thumb, { left: skin.metrics.thumbInset, right: skin.metrics.thumbInset, width: 'auto' }, true);
      if (parts.decrement) {
        write(parts.decrement, { top: 0, height: arrow });
        write(parts.increment, { bottom: 0, height: arrow });
      }
    }
    const metrics = verticalScrollMetrics(viewport, track.offsetHeight, skin ?
      { minThumbHeight: skin.metrics.minThumbHeight, startInset: arrow, endInset: arrow } : undefined);
    if (skin) write(thumb, { display: metrics.thumbHeight > 0 ? '' : 'none' }, true);
    lastMetrics = metrics;
    if (Number(viewport.scrollTop) !== metrics.value) viewport.scrollTop = metrics.value;
    enabled = metrics.maximum > 0 && metrics.height > 0 && (skin ? track.offsetHeight > 0 : metrics.travel > 0);
    if (!enabled) cancel(true);
    const style = { top: String(metrics.top), height: String(metrics.thumbHeight) };
    for (const [key, value] of Object.entries(style)) if (thumb.style[key] !== value) thumb.style[key] = value;
    const tabIndex = enabled ? 0 : -1;
    if (track.tabIndex !== tabIndex) track.tabIndex = tabIndex;
    for (const [key, value] of Object.entries({ 'aria-valuemin': '0', 'aria-valuemax': String(metrics.maximum),
      'aria-valuenow': String(metrics.value), 'aria-disabled': String(!enabled) }))
      if (track.getAttribute(key) !== value) track.setAttribute(key, value);
    paint();
    const visibility = enabled ? '1' : '0';
    if (track.style.opacity !== visibility) track.style.opacity = visibility;
    const hit = enabled ? 'auto' : 'none';
    if (track.style.pointerEvents !== hit) track.style.pointerEvents = hit;
    return metrics;
  }
  function scrollTo(value) {
    const metrics = update();
    if (!metrics) { cancel(true); return null; }
    viewport.scrollTop = Math.max(0, Math.min(metrics.maximum, value));
    update();
    return Number(viewport.scrollTop);
  }
  function step(direction) {
    if (direction !== -1 && direction !== 1) throw new RangeError('Scrollbar step direction must be -1 or 1');
    const metrics = update();
    return metrics ? scrollTo(metrics.value + direction * (skin?.metrics.stepSize ?? 42)) : null;
  }
  listen('mousedown', event => {
    if (event.button !== 0) return;
    const metrics = update();
    if (!metrics || !metrics.maximum) return;
    const part = hit(event);
    if (!metrics.travel && (!skin || !['decrement', 'increment'].includes(part))) return;
    event.preventDefault(); event.stopPropagation();
    track.focus();
    if (skin) { hovered = part; held = part; }
    if (part === 'decrement' || part === 'increment') {
      step(part === 'decrement' ? -1 : 1); paint(); return;
    }
    const y = event.clientY - track.getBoundingClientRect().y;
    if (y < metrics.top || y > metrics.top + metrics.thumbHeight) {
      scrollTo(metrics.value + (y < metrics.top ? -1 : 1) * metrics.height);
      paint();
      return;
    }
    track.setMouseCapture();
    drag = { grab: y - metrics.top };
    paint();
  });
  function move(event) {
    if (skin) { hovered = hit(event); paint(); }
    if (!drag) return;
    const metrics = update();
    if (!metrics || !drag) { cancel(true); return; }
    const top = event.clientY - track.getBoundingClientRect().y - drag.grab;
    scrollTo(metrics.travel ? top / metrics.travel * metrics.maximum : 0);
  }
  listen('mousemove', move);
  listen('mouseup', event => {
    if (event.button !== 0) return;
    if (drag) move(event);
    cancel(true);
  });
  listen('mouseenter', event => { if (skin) { hovered = hit(event); paint(); } });
  listen('mouseleave', () => { hovered = null; if (!drag) held = null; paint(); });
  listen('mousecancel', () => { hovered = null; cancel(); });
  listen('lostmousecapture', () => cancel());
  listen('blur', () => { focused = false; cancel(true); });
  listen('focus', () => { focused = true; paint(); });
  listen('wheel', event => { event.preventDefault(); const metrics = update(); if (metrics) scrollTo(metrics.value + event.deltaY); });
  listen('keydown', event => {
    const metrics = update();
    if (!metrics) return;
    const delta = { ArrowUp: -42, ArrowDown: 42, PageUp: -metrics.height, PageDown: metrics.height };
    if (event.key === 'Home' || event.key === 'End' || Object.hasOwn(delta, event.key)) {
      event.preventDefault(); event.stopPropagation();
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') step(event.key === 'ArrowUp' ? -1 : 1);
      else scrollTo(event.key === 'Home' ? 0 : event.key === 'End' ? metrics.maximum : metrics.value + delta[event.key]);
    } else if (event.key === 'Escape') cancel(true);
  });
  function removeSkin() {
    if (cleanup) cleanup();
    cleanup = null;
    if (parts) for (const key of ['trackDetail', 'trackFocus', 'thumbDetail', 'decrement', 'increment']) {
      const node = parts[key];
      if (node?.parentNode) node.parentNode.removeChild(node);
    }
    for (const [node, style] of originals) for (const [key, value] of style) node.style[key] = value ?? '';
    originals.clear(); parts = null;
  }
  function setAppearance(value) {
    if (stopped) throw new Error('Scrollbar is stopped');
    if (source === value) return;
    const next = scrollbarAppearance(value);
    removeSkin(); source = value; skin = next; lastPaint = '';
    if (skin) {
      const add = (parent, name, first = false) => {
        const node = track.ownerDocument.createElement('view');
        node.className = 'scrollbar-' + name; node.setAttribute('aria-hidden', 'true');
        write(node, { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, pointerEvents: 'none' });
        parent.insertBefore(node, first ? parent.firstChild : null); return node;
      };
      const trackDetail = add(track, 'track-detail', true), thumbDetail = add(thumb, 'thumb-detail');
      const decrement = skin.metrics.arrowSize ? add(track, 'decrement') : null;
      const increment = skin.metrics.arrowSize ? add(track, 'increment') : null;
      if (decrement) { decrement.style.bottom = ''; increment.style.top = ''; }
      parts = Object.freeze({ track, thumb, trackDetail, thumbDetail, decrement, increment,
        decrementDetail: decrement ? add(decrement, 'decrement-detail') : null,
        incrementDetail: increment ? add(increment, 'increment-detail') : null,
        trackFocus: add(track, 'track-focus') });
      const result = skin.decorate?.(parts);
      if (result !== undefined && typeof result !== 'function')
        throw new TypeError('Scrollbar decoration must return a cleanup function or undefined');
      cleanup = result || null;
      if (!skin.metrics.arrowSize) {
        if (['decrement', 'increment'].includes(hovered)) hovered = null;
        if (['decrement', 'increment'].includes(held)) held = null;
      }
    }
    update();
  }
  if (appearance !== undefined) setAppearance(appearance);
  return { update, cancel, step, setAppearance,
    stop() {
      cancel(true); stopped = true;
      for (const [type, callback] of listeners) track.removeEventListener(type, callback);
      removeSkin();
    },
  };
}
