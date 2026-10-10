// vue.mjs — a Vue 3-style reactivity system + Composition API, rendering through
// the reconciler. (Proxy-based reactive(), ref(), computed(), watch/watchEffect,
// and createApp(component).mount(el) with setup()-returns-render components.)
//
//   import { ref, computed, createApp, h } from './gui/sdk/js/vue.mjs';
//   const App = {
//     setup() {
//       const count = ref(0);
//       const doubled = computed(() => count.value * 2);
//       return () => h('view', { onClick: () => count.value++ },
//         `count ${count.value} (x2 = ${doubled.value})`);
//     }
//   };
//   createApp(App).mount(document.body);

import { h, render as reconcile } from './gui/sdk/js/reconciler.mjs';
export { h };

// ---- dependency tracking ----------------------------------------------------

let activeEffect = null;
const targetMap = new WeakMap();   // target -> Map<key, Set<effect>>

function track(target, key) {
  if (!activeEffect) return;
  let deps = targetMap.get(target);
  if (!deps) targetMap.set(target, deps = new Map());
  let dep = deps.get(key);
  if (!dep) deps.set(key, dep = new Set());
  dep.add(activeEffect);
  activeEffect.deps.push(dep);
}

function trigger(target, key) {
  const deps = targetMap.get(target);
  if (!deps) return;
  const dep = deps.get(key);
  if (dep) [...dep].forEach(e => (e.scheduler ? e.scheduler() : e()));
}

function cleanup(runner) { runner.deps.forEach(d => d.delete(runner)); runner.deps.length = 0; }

export function effect(fn, options = {}) {
  const runner = () => {
    cleanup(runner);
    const prev = activeEffect;
    activeEffect = runner;
    try { return fn(); } finally { activeEffect = prev; }
  };
  runner.deps = [];
  runner.scheduler = options.scheduler;
  if (!options.lazy) runner();
  return runner;
}

// ---- reactive / ref / computed ----------------------------------------------

const proxyMap = new WeakMap();
const handlers = {
  get(t, key, recv) {
    if (key === '__v_raw') return t;
    const res = Reflect.get(t, key, recv);
    track(t, key);
    return (res && typeof res === 'object') ? reactive(res) : res;
  },
  set(t, key, val, recv) {
    const had = Object.prototype.hasOwnProperty.call(t, key);
    const old = t[key];
    const res = Reflect.set(t, key, val, recv);
    if (!had || old !== val) trigger(t, key);
    return res;
  },
  deleteProperty(t, key) {
    const had = Object.prototype.hasOwnProperty.call(t, key);
    const res = Reflect.deleteProperty(t, key);
    if (had) trigger(t, key);
    return res;
  },
};

export function reactive(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (obj.__v_raw) return obj;                 // already reactive
  if (proxyMap.has(obj)) return proxyMap.get(obj);
  const p = new Proxy(obj, handlers);
  proxyMap.set(obj, p);
  return p;
}

export function ref(value) {
  const r = {
    __v_isRef: true,
    get value() { track(r, 'value'); return value; },
    set value(v) { if (v !== value) { value = v; trigger(r, 'value'); } },
  };
  return r;
}

export function computed(getter) {
  let value, dirty = true;
  const runner = effect(getter, { lazy: true, scheduler: () => { if (!dirty) { dirty = true; trigger(c, 'value'); } } });
  const c = {
    __v_isRef: true,
    get value() { if (dirty) { value = runner(); dirty = false; } track(c, 'value'); return value; },
  };
  return c;
}

// ---- watch ------------------------------------------------------------------

export function watchEffect(fn) { return effect(fn); }

export function watch(source, cb) {
  const getter = typeof source === 'function' ? source : () => source.value;
  let oldValue;
  const runner = effect(getter, {
    lazy: true,
    scheduler: () => { const n = runner(); cb(n, oldValue); oldValue = n; },
  });
  oldValue = runner();
  return runner;
}

// ---- scheduler (batch re-renders into a microtask) --------------------------

const queue = new Set();
let flushing = false;
function queueJob(job) {
  queue.add(job);
  if (!flushing) { flushing = true; Promise.resolve().then(flushJobs); }
}
function flushJobs() {
  queue.forEach(j => j());
  queue.clear();
  flushing = false;
}

// ---- component model + createApp --------------------------------------------

export function defineComponent(c) { return c; }

function resolveRender(component, props) {
  if (typeof component === 'function') return () => component(props);     // functional
  if (component.setup) {
    const r = component.setup(props);
    if (typeof r === 'function') return r;                                // setup returns render
    return component.render ? () => component.render(r, props) : () => null;
  }
  if (component.render) return () => component.render(props);
  return () => null;
}

export function createApp(rootComponent, rootProps = {}) {
  return {
    mount(container) {
      const renderFn = resolveRender(rootComponent, rootProps);
      const update = () => reconcile(renderFn(), container);
      // Re-run render whenever a reactive dep used in it changes (batched).
      effect(update, { scheduler: () => queueJob(update) });
      return this;
    },
  };
}
