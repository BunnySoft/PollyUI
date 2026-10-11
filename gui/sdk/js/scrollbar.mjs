// Geometry is unscrolled absolute layout, matching the native overflow contract.
export function verticalScrollMetrics(viewport, trackHeight = viewport.offsetHeight) {
  const height = viewport.offsetHeight;
  const content = viewport.childNodes.reduce((end, child) =>
    Math.max(end, child.offsetTop + child.offsetHeight - viewport.offsetTop), height);
  const maximum = Math.max(0, content - height);
  const value = Math.max(0, Math.min(maximum, Number(viewport.scrollTop)));
  const thumbHeight = Math.min(trackHeight, Math.max(28, content > 0 ? trackHeight * height / content : trackHeight));
  const travel = Math.max(0, trackHeight - thumbHeight);
  return { height, content, maximum, value, thumbHeight, travel, top: maximum ? value / maximum * travel : 0 };
}

export function createVerticalScrollbar({ viewport, track, thumb, isCurrent = () => true }) {
  let drag = null, stopped = false;
  const listeners = [];
  const listen = (type, callback) => {
    track.addEventListener(type, callback);
    listeners.push([type, callback]);
  };
  function cancel(release = false) {
    const held = drag;
    drag = null;
    if (release && held) track.releaseMouseCapture();
  }
  function update() {
    if (stopped) return null;
    if (!isCurrent()) {
      cancel(true);
      track.tabIndex = -1; track.style.pointerEvents = 'none'; track.style.opacity = '0';
      track.setAttribute('aria-disabled', 'true');
      return null;
    }
    const metrics = verticalScrollMetrics(viewport, track.offsetHeight);
    if (Number(viewport.scrollTop) !== metrics.value) viewport.scrollTop = metrics.value;
    const enabled = metrics.maximum > 0 && metrics.travel > 0 && metrics.height > 0;
    if (!enabled) cancel(true);
    const style = { top: String(metrics.top), height: String(metrics.thumbHeight) };
    for (const [key, value] of Object.entries(style)) if (thumb.style[key] !== value) thumb.style[key] = value;
    track.tabIndex = enabled ? 0 : -1;
    for (const [key, value] of Object.entries({ 'aria-valuemin': '0', 'aria-valuemax': String(metrics.maximum),
      'aria-valuenow': String(metrics.value), 'aria-disabled': String(!enabled) }))
      if (track.getAttribute(key) !== value) track.setAttribute(key, value);
    const visibility = enabled ? '1' : '0';
    if (track.style.opacity !== visibility) track.style.opacity = visibility;
    const hit = enabled ? 'auto' : 'none';
    if (track.style.pointerEvents !== hit) track.style.pointerEvents = hit;
    return metrics;
  }
  function scrollTo(value) {
    const metrics = update();
    if (!metrics) { cancel(true); return; }
    viewport.scrollTop = Math.max(0, Math.min(metrics.maximum, value));
    update();
  }
  listen('mousedown', event => {
    if (event.button !== 0) return;
    const metrics = update();
    if (!metrics || !metrics.maximum || !metrics.travel) return;
    event.preventDefault(); event.stopPropagation();
    track.focus();
    const y = event.clientY - track.getBoundingClientRect().y;
    if (y < metrics.top || y > metrics.top + metrics.thumbHeight) {
      scrollTo(metrics.value + (y < metrics.top ? -1 : 1) * metrics.height);
      return;
    }
    track.setMouseCapture();
    drag = { grab: y - metrics.top };
  });
  function move(event) {
    if (!drag) return;
    const metrics = update();
    if (!metrics || !drag) { cancel(true); return; }
    const top = event.clientY - track.getBoundingClientRect().y - drag.grab;
    scrollTo(metrics.travel ? top / metrics.travel * metrics.maximum : 0);
  }
  listen('mousemove', move);
  listen('mouseup', event => { if (event.button === 0 && drag) { move(event); cancel(true); } });
  listen('mousecancel', () => cancel());
  listen('lostmousecapture', () => cancel());
  listen('blur', () => cancel(true));
  listen('wheel', event => { event.preventDefault(); const metrics = update(); if (metrics) scrollTo(metrics.value + event.deltaY); });
  listen('keydown', event => {
    const metrics = update();
    if (!metrics) return;
    const delta = { ArrowUp: -42, ArrowDown: 42, PageUp: -metrics.height, PageDown: metrics.height };
    if (event.key === 'Home' || event.key === 'End' || Object.hasOwn(delta, event.key)) {
      event.preventDefault(); event.stopPropagation();
      scrollTo(event.key === 'Home' ? 0 : event.key === 'End' ? metrics.maximum : metrics.value + delta[event.key]);
    } else if (event.key === 'Escape') cancel(true);
  });
  return { update, cancel,
    stop() {
      cancel(true); stopped = true;
      for (const [type, callback] of listeners) track.removeEventListener(type, callback);
    },
  };
}
