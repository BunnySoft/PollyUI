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

export function h(type, props, ...children) {
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

function setProp(el, k, v) {
  if (k === 'className')   el.className = v == null ? '' : v;
  else if (k === 'id')     el.id = v == null ? '' : v;
  else if (k === 'tabIndex') el.tabIndex = v == null ? -1 : v;
  else if (v == null)      el.removeAttribute(k);
  else                     el.setAttribute(k, String(v));
}

function applyProps(el, oldP, newP) {
  const oldStyle = oldP.style || {}, newStyle = newP.style || {};
  for (const k in oldStyle) if (!(k in newStyle)) el.style[k] = '';
  for (const k in newStyle) if (oldStyle[k] !== newStyle[k]) el.style[k] = String(newStyle[k]);

  el.__listeners = el.__listeners || {};
  for (const k in oldP) {
    if (k.startsWith('on') && (!(k in newP) || oldP[k] !== newP[k])) {
      const ev = eventName(k);
      if (el.__listeners[ev]) { el.removeEventListener(ev, el.__listeners[ev]); delete el.__listeners[ev]; }
    }
  }
  for (const k in newP) {
    // only (re)add when the handler actually changed AND is a function; a prop
    // like `onClick: undefined` (conditional handler) must not be added.
    if (k.startsWith('on') && oldP[k] !== newP[k] && typeof newP[k] === 'function') {
      const ev = eventName(k);
      el.addEventListener(ev, newP[k]);
      el.__listeners[ev] = newP[k];
    }
  }
  for (const k in newP) {
    if (k === 'style' || k === 'key' || k.startsWith('on')) continue;
    if (oldP[k] !== newP[k]) setProp(el, k, newP[k]);
  }
  for (const k in oldP) {
    if (k === 'style' || k === 'key' || k.startsWith('on')) continue;
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
  return el;
}

function diff(parentDom, oldV, newV) {
  if (oldV == null) { const dom = createDom(newV); parentDom.appendChild(dom); return dom; }
  if (newV == null) { if (oldV.__dom) parentDom.removeChild(oldV.__dom); return null; }

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
    parentDom.replaceChild(dom, oldV.__dom);
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
