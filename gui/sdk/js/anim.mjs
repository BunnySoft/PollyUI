// anim.mjs — a small tween/animation library built on requestAnimationFrame.
//
//   import { animate, easings } from './gui/sdk/js/anim.mjs';
//   animate(box, { opacity: [0, 1], translateX: [0, 120] },
//           { duration: 400, easing: 'easeOutCubic' }).then(() => console.log('done'));
//
// Each property value is either `to` (the `from` is read from the element's
// current style) or `[from, to]`. Numeric style props are interpolated and
// written back as strings, so anything the renderer reads numerically works:
// opacity, translateX/Y, rotate, scale, width/height, borderRadius, ...

export const easings = {
  linear:        t => t,
  easeInQuad:    t => t * t,
  easeOutQuad:   t => 1 - (1 - t) * (1 - t),
  easeInOutQuad: t => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  easeInCubic:   t => t * t * t,
  easeOutCubic:  t => 1 - Math.pow(1 - t, 3),
  easeInOutCubic:t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  // a gentle overshoot
  easeOutBack:   t => { const c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); },
};

// Animate `el`'s style props. Returns a Promise that resolves on completion.
// Options: { duration=300, easing='easeOutCubic', delay=0, onUpdate, onComplete }.
export function animate(el, props, opts = {}) {
  const duration = opts.duration ?? 300;
  const delay    = opts.delay ?? 0;
  const ease     = typeof opts.easing === 'function'
    ? opts.easing
    : (easings[opts.easing] || easings.easeOutCubic);

  const from = {}, to = {};
  for (const k in props) {
    const spec = props[k];
    if (Array.isArray(spec)) { from[k] = spec[0]; to[k] = spec[1]; }
    else { from[k] = parseFloat(el.style[k]) || 0; to[k] = spec; }
  }

  let startTs = null;
  return new Promise(resolve => {
    function frame(ts) {
      if (startTs === null) startTs = ts + delay;
      const elapsed = ts - startTs;
      if (elapsed < 0) { requestAnimationFrame(frame); return; }   // still in the delay
      const p = duration > 0 ? Math.min(1, elapsed / duration) : 1;
      const e = ease(p);
      for (const k in to) el.style[k] = String(from[k] + (to[k] - from[k]) * e);
      if (opts.onUpdate) opts.onUpdate(p, e);
      if (p < 1) {
        requestAnimationFrame(frame);
      } else {
        if (opts.onComplete) opts.onComplete();
        resolve(el);
      }
    }
    requestAnimationFrame(frame);
  });
}

// Convenience wrappers.
export const fadeIn  = (el, o = {}) => animate(el, { opacity: [0, 1] }, o);
export const fadeOut = (el, o = {}) => animate(el, { opacity: [1, 0] }, o);
