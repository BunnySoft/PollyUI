// reconciler.mjs — a small React-style virtual DOM with diffing.
//
//   import { h, render } from './js/reconciler.mjs';
//   const App = ({ count }) => h('view', { style: { gap: '6' } },
//     h('view', { id: 'n' }, String(count)),
//     h('view', { onClick: () => {/* ... */} }, 'increment'));
//   render(h(App, { count: 0 }), document.body);
//
// Supports function components, an h() hyperscript (children may be strings,
// arrays, or null), `style` objects, `on<Event>` handlers, and plain
// attributes (id/className/tabIndex/...). Re-rendering diffs against the
// previous tree and applies the minimal DOM mutations.

// Custom-element registry: a string tag (e.g. 'button', 'date-picker') mapped to
// a component function. When h()'s first arg is a registered tag, it authors like
// a custom element and resolves to the component at call time:
//   h('button', { type: 'primary' }, 'Save')   ===   NButton({ type:'primary' }, 'Save')
const _tags = Object.create(null);
export function defineTag(name, fn) { _tags[name] = fn; }
export function defineTags(map) { for (const k in map) _tags[k] = map[k]; }
export function tagNames() { return Object.keys(_tags).sort(); }

export function h(type, props, ...children) {
  if (typeof type === 'string' && _tags[type]) return _tags[type](props || {}, ...children);
  const flat = [];
  const add = (c) => {
    if (c === null || c === undefined || c === false || c === true) return;
    if (Array.isArray(c)) { c.forEach(add); return; }
    flat.push(typeof c === 'object' ? c : { type: '#text', props: { nodeValue: String(c) }, children: [] });
  };
  children.forEach(add);
  return { type, props: props || {}, children: flat };
}

const eventName = (k) => k.slice(2).toLowerCase(); // onClick -> click
// Lifecycle hooks (used by <Transition>): onMount(el) fires after an element is
// created; onLeave(el, done) defers a removal until done() is called. They look
// like event handlers (`on*`) but are NOT addEventListener'd.
const isLifecycle = (k) => k === 'onMount' || k === 'onLeave';
// Unwrap function-component vnodes to the element vnode that actually carries a
// leave hook (so a removed <Transition> can animate out before detaching).
function leaveHookOf(v) { while (v && typeof v.type === 'function') v = v.__rendered; return v && v.props && v.props.onLeave; }

function setProp(el, k, v) {
  if (k === 'className')   el.className = v == null ? '' : v;
  else if (k === 'id')     el.id = v == null ? '' : v;
  else if (k === 'tabIndex') el.tabIndex = v == null ? -1 : v;
  else if (v == null)      el.removeAttribute(k);
  else                     el.setAttribute(k, String(v));
}

// State styles (hoverStyle/focusStyle) are flattened onto the node as
// `hover:KEY` / `focus:KEY` style entries; the native renderer applies them when
// the element is hovered/focused — no JS re-render needed (see render.c).
function applyStateStyle(el, prefix, oldS, newS) {
  oldS = oldS || {}; newS = newS || {};
  for (const k in oldS) if (!(k in newS)) el.style[prefix + k] = '';
  for (const k in newS) if (oldS[k] !== newS[k]) el.style[prefix + k] = String(newS[k]);
}

// --- Declarative transitions -------------------------------------------------
// A `transition` prop animates style changes that flow through the reconciler
// (state-driven, not engine hover/focus). Forms:
//   transition: 200                                  // 200ms, easeOutCubic, all props
//   transition: { duration: 250, easing: 'easeOutQuad' }
//   transition: { duration: 250, props: ['opacity','translateX'] }
// Animatable values: plain numbers ('0', '1.5'), pixel lengths ('12px'), and
// hex colors ('#0067C0'). Everything else (auto, %, named colors) sets instantly.
const easings = {
  linear: t => t,
  easeInQuad: t => t * t,
  easeOutQuad: t => 1 - (1 - t) * (1 - t),
  easeInOutCubic: t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  easeOutCubic: t => 1 - Math.pow(1 - t, 3),
  easeOutBack: t => { const c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); },
};
const _numRe = /^-?\d*\.?\d+(px)?$/;
const _colRe = /^#([0-9a-fA-F]{6})$/;
function _parseColor(v) { const m = _colRe.exec(String(v).trim()); if (!m) return null; const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
const _hex2 = (n) => { const s = Math.max(0, Math.min(255, Math.round(n))).toString(16); return s.length < 2 ? '0' + s : s; };

function transitionFor(tr, key) {
  if (tr == null) return null;
  if (typeof tr === 'number') return { duration: tr, ease: easings.easeOutCubic };
  if (tr.props && !tr.props.includes(key)) return null;
  const e = tr.easing;
  return { duration: tr.duration ?? 200, ease: typeof e === 'function' ? e : (easings[e] || easings.easeOutCubic) };
}

// Start a rAF tween of el.style[key] from its live value to `target`. Returns
// true if it took over the write, false if the values aren't interpolatable
// (caller then sets the value instantly).
function tweenStyle(el, key, target, t) {
  const fc = _parseColor(el.style[key]), tc = _parseColor(target);
  let from, to, color = false, unit = '';
  if (fc && tc) { from = fc; to = tc; color = true; }
  else {
    const fs = String(el.style[key]).trim(), ts = String(target).trim();
    if (!_numRe.test(fs) || !_numRe.test(ts)) return false;
    if (fs.endsWith('px') || ts.endsWith('px')) unit = 'px';
    from = parseFloat(fs); to = parseFloat(ts);
    if (from === to) return false;
  }
  el.__tw = el.__tw || {};
  const token = el.__tw[key] = (el.__tw[key] || 0) + 1; // newer target supersedes
  const dur = t.duration, ease = t.ease;
  let start = null;
  const step = (now) => {
    if (el.__tw[key] !== token) return;
    if (start === null) start = now;
    const p = dur > 0 ? Math.min(1, (now - start) / dur) : 1;
    const e = ease(p);
    if (color) el.style[key] = '#' + _hex2(from[0] + (to[0] - from[0]) * e) + _hex2(from[1] + (to[1] - from[1]) * e) + _hex2(from[2] + (to[2] - from[2]) * e);
    else el.style[key] = (from + (to - from) * e) + unit;
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  return true;
}

function applyProps(el, oldP, newP) {
  const oldStyle = oldP.style || {}, newStyle = newP.style || {}, tr = newP.transition;
  for (const k in oldStyle) if (!(k in newStyle)) el.style[k] = '';
  for (const k in newStyle) {
    if (oldStyle[k] === newStyle[k]) continue;
    // transition only on update (key existed before) so first mount is instant
    const t = (tr != null && (k in oldStyle)) ? transitionFor(tr, k) : null;
    if (t && tweenStyle(el, k, newStyle[k], t)) continue;
    el.style[k] = String(newStyle[k]);
  }
  applyStateStyle(el, 'hover:', oldP.hoverStyle, newP.hoverStyle);
  applyStateStyle(el, 'focus:', oldP.focusStyle, newP.focusStyle);

  el.__listeners = el.__listeners || {};
  for (const k in oldP) {
    if (k.startsWith('on') && !isLifecycle(k) && (!(k in newP) || oldP[k] !== newP[k])) {
      const ev = eventName(k);
      if (el.__listeners[ev]) { el.removeEventListener(ev, el.__listeners[ev]); delete el.__listeners[ev]; }
    }
  }
  for (const k in newP) {
    // only (re)add when the handler actually changed AND is a function; a prop
    // like `onClick: undefined` (conditional handler) must not be added.
    if (k.startsWith('on') && !isLifecycle(k) && oldP[k] !== newP[k] && typeof newP[k] === 'function') {
      const ev = eventName(k);
      el.addEventListener(ev, newP[k]);
      el.__listeners[ev] = newP[k];
    }
  }
  for (const k in newP) {
    if (k === 'style' || k === 'hoverStyle' || k === 'focusStyle' || k === 'transition' || k === 'key' || k.startsWith('on')) continue;
    if (oldP[k] !== newP[k]) setProp(el, k, newP[k]);
  }
  for (const k in oldP) {
    if (k === 'style' || k === 'hoverStyle' || k === 'focusStyle' || k === 'transition' || k === 'key' || k.startsWith('on')) continue;
    if (!(k in newP)) setProp(el, k, null);
  }
}

function createDom(vnode) {
  if (typeof vnode.type === 'function') {
    const rendered = vnode.type(vnode.props);
    vnode.__rendered = rendered;
    return (vnode.__dom = rendered ? createDom(rendered) : document.createTextNode(''));
  }
  if (vnode.type === '#text') {
    return (vnode.__dom = document.createTextNode(vnode.props.nodeValue));
  }
  const el = document.createElement(vnode.type);
  vnode.__dom = el;
  applyProps(el, {}, vnode.props);
  vnode.children.forEach(c => el.appendChild(createDom(c)));
  // Enter hook: fire synchronously so the element's first paint reflects the
  // 'from' style the hook sets (no flicker), then it animates to natural.
  if (typeof vnode.props.onMount === 'function') vnode.props.onMount(el);
  return el;
}

function diff(parentDom, oldV, newV) {
  if (oldV == null) { const dom = createDom(newV); parentDom.appendChild(dom); return dom; }
  if (newV == null) {
    if (oldV.__dom) {
      const leave = leaveHookOf(oldV), el = oldV.__dom;
      if (leave) leave(el, () => { if (el.parentNode === parentDom) parentDom.removeChild(el); });
      else parentDom.removeChild(el);
    }
    return null;
  }

  if (typeof newV.type === 'function') {
    const rendered = newV.type(newV.props);
    const dom = oldV.__rendered ? diff(parentDom, oldV.__rendered, rendered) : createDom(rendered);
    if (!oldV.__rendered) parentDom.appendChild(dom);
    newV.__rendered = rendered;
    newV.__dom = dom;
    return dom;
  }
  if (oldV.type !== newV.type) {
    const dom = createDom(newV);
    parentDom.insertBefore(dom, oldV.__dom);   // replace = insert-before + remove
    parentDom.removeChild(oldV.__dom);
    return dom;
  }

  const dom = (newV.__dom = oldV.__dom);
  if (newV.type === '#text') {
    if (oldV.props.nodeValue !== newV.props.nodeValue) dom.textContent = newV.props.nodeValue;
    return dom;
  }
  applyProps(dom, oldV.props, newV.props);
  const oldCh = oldV.children, newCh = newV.children;
  const n = Math.max(oldCh.length, newCh.length);
  for (let i = 0; i < n; i++) diff(dom, oldCh[i] || null, newCh[i] || null);
  return dom;
}

// Mount or update `vnode` into `container`, diffing against the previous render.
export function render(vnode, container) {
  const old = container.__vnode || null;
  if (old == null) { if (vnode) container.appendChild(createDom(vnode)); }
  else             { diff(container, old, vnode); }
  container.__vnode = vnode || null;
}

// Convenience: a self-re-rendering app. `component` is called with a `setState`
// that merges into state and re-renders. Returns { state }.
export function mount(component, container, initial = {}) {
  const app = { state: { ...initial } };
  const setState = (patch) => { Object.assign(app.state, patch); rerender(); };
  const rerender = () => render(component(app.state, setState), container);
  rerender();
  return app;
}
