// counter.mjs — a worked example of defining your own PollyUI component:
// styles (incl. hover), behavior (reactive state), and actions (event handlers).
//
// Run it:
//   macOS:   ./build/mac-sdl/pollyui gui/examples/playground/counter.mjs
//   Windows: ./build/win-clang/pollyui.exe gui/examples/playground/counter.mjs

import { h, reactive, computed, createApp, defineTag } from './gui/sdk/js/pollyui.mjs';

// ===========================================================================
// 1) A COMPONENT is just a function: (props, ...children) -> a vnode via h().
//    `view` is the single native primitive (a styled, flex-laid-out box); text
//    is a view's child string. You build every widget by composing views.
//
//    This Counter is "controlled": the parent owns `value` and passes an
//    `onChange` action — the same convention the built-in naive.mjs uses.
// ===========================================================================
export function Counter(props = {}) {
  const { value = 0, min = -Infinity, max = Infinity, step = 1, onChange } = props;

  // --- ACTION: clamp to [min,max] and notify the parent -------------------
  const set = (v) => {
    v = Math.max(min, Math.min(max, v));
    if (v !== value && onChange) onChange(v);
  };

  // --- a reusable styled + interactive sub-view (STYLES + HOVER + CLICK) ---
  const btn = (glyph, delta, enabled) => h('view', {
    style: {
      width: 34, height: 34, borderRadius: 8,
      alignItems: 'center', justifyContent: 'center',
      backgroundColor: enabled ? '#3b82f6' : '#cbd5e1',   // faded when disabled
    },
    // hoverStyle is applied natively (in render.c) — no JS re-render needed.
    hoverStyle: enabled ? { backgroundColor: '#2563eb' } : undefined,
    // an `on*` prop becomes an event listener; undefined = no handler (disabled).
    onClick: enabled ? () => set(value + delta) : undefined,
  }, h('view', { style: { color: '#ffffff', fontSize: 20, fontWeight: 'bold' } }, glyph));

  return h('view', { style: { flexDirection: 'row', alignItems: 'center', gap: 12 } },
    btn('\u2212', -step, value > min),                     // −
    h('view', {
      style: { minWidth: 44, fontSize: 20, fontWeight: '600', color: '#0f172a',
               alignItems: 'center' },
    }, String(value)),
    btn('+', +step, value < max));
}

// (optional) register it as a custom TAG so you can write h('counter', {...})
// or <counter/> — exactly like the built-in components.
defineTag('counter', Counter);

// ===========================================================================
// 2) USING IT. The app owns reactive STATE; reading it during render creates a
//    dependency, so mutating it re-renders automatically (createApp batches it).
// ===========================================================================
const row = (label, control) => h('view',
  { style: { flexDirection: 'row', alignItems: 'center', gap: 16 } },
  h('view', { style: { width: 90, fontSize: 16, color: '#475569' } }, label),
  control);

const App = {
  setup() {
    const s = reactive({ apples: 1, oranges: 2 });
    const total = computed(() => s.apples + s.oranges);   // derived state

    // setup() returns the render function; it re-runs when s.* changes.
    return () => h('view', {
      style: { width: '100%', height: '100%', padding: 40, gap: 20,
               backgroundColor: '#f8fafc' },
    },
      h('view', { style: { fontSize: 24, fontWeight: '700', color: '#0f172a' } }, 'Fruit basket'),

      row('Apples',  h('counter', { value: s.apples,  min: 0, max: 9,
                                    onChange: (v) => { s.apples = v; } })),
      row('Oranges', h('counter', { value: s.oranges, min: 0, max: 9,
                                    onChange: (v) => { s.oranges = v; } })),

      h('view', { style: { marginTop: 8, fontSize: 16, color: '#334155' } },
        `Total: ${total.value}`));
  },
};

createApp(App).mount(document.body);
