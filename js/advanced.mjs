// advanced.mjs — advanced PollyUI component patterns:
//   * self-contained internal state via a keyed store (survives re-renders)
//   * an overlay popup (openPopup / closePopup + NOverlayHost)
//   * keyboard behavior (focus + arrow/enter/escape)
//   * form validation gating an action
//
// Run it:
//   macOS:   ./build/mac-sdl/pollyui js/advanced.mjs
//   Windows: ./build/win-clang/pollyui.exe js/advanced.mjs

import {
  h, reactive, computed, createApp,
  NInput, NOverlayHost, openPopup, closePopup,
} from './js/pollyui.mjs';

// ===========================================================================
// KEYED STORE — the pattern for SELF-CONTAINED state.
//
// A component function is re-invoked on every render, so a `reactive()` created
// *inside* it would be wiped each time. Instead keep per-instance state in a
// module-level map keyed by a stable `id` prop (this is exactly how naive.mjs's
// inputs persist their caret). Because each store is reactive, mutating it
// re-renders the app.
// ===========================================================================
const _stores = {};
const useStore = (id, init) => (_stores[id] ||= reactive(init));

// ===========================================================================
// Select2 — a custom <select> with a popup list and full keyboard control.
// Controlled value (parent owns `value` + `onUpdate`), but OWNS its open/
// highlight state internally.
// ===========================================================================
export function Select2(props = {}) {
  const { id, value, options = [], onUpdate, width = 220, placeholder = 'Select…' } = props;
  const st = useStore(id, { openId: null, hi: -1 });   // internal state
  const sel = options.find(o => o.value === value);

  const close  = () => { if (st.openId != null) { closePopup(st.openId); st.openId = null; } };
  const choose = (i) => { const o = options[i]; if (o && onUpdate) onUpdate(o.value); close(); };

  // Build + open the overlay popup, anchored under the control.
  const openAt = (rect) => {
    st.hi = Math.max(0, options.findIndex(o => o.value === value));
    // The popup render fn reads st.hi, so keyboard highlight re-renders it live.
    const list = () => h('view', {
      style: { width, backgroundColor: '#ffffff', borderWidth: 1, borderColor: '#e5e7eb',
               borderRadius: 8, padding: 4, gap: 2 },
    }, ...options.map((o, i) => h('view', {
      key: o.value,
      style: { height: 32, paddingLeft: 10, borderRadius: 6, justifyContent: 'center',
               backgroundColor: i === st.hi ? '#eff6ff' : 'transparent' },
      hoverStyle: { backgroundColor: '#f1f5f9' },
      onClick: () => choose(i),
    }, h('view', { style: { fontSize: 14, color: i === st.hi ? '#2563eb' : '#111827' } }, o.label))));
    st.openId = openPopup(list, { x: rect.left, y: rect.bottom + 4, onClose: close });
  };

  return h('view', {
    id, tabIndex: 0,                                   // focusable -> gets key events
    style: { width, height: 36, flexDirection: 'row', alignItems: 'center',
             justifyContent: 'space-between', paddingLeft: 12, paddingRight: 12,
             backgroundColor: '#ffffff', borderWidth: 1, borderColor: '#d1d5db', borderRadius: 8 },
    hoverStyle: { borderColor: '#93c5fd' },
    focusStyle: { borderColor: '#3b82f6' },            // native focus ring, no re-render
    onClick: (e) => {
      if (st.openId != null) return close();
      if (e.currentTarget.focus) e.currentTarget.focus();
      openAt(e.currentTarget.getBoundingClientRect());
    },
    onKeydown: (e) => {
      const k = e.key;
      if (st.openId == null && (k === 'Enter' || k === 'ArrowDown')) {
        return openAt(e.currentTarget.getBoundingClientRect());
      }
      if (k === 'ArrowDown') st.hi = Math.min(options.length - 1, st.hi + 1);
      else if (k === 'ArrowUp') st.hi = Math.max(0, st.hi - 1);
      else if (k === 'Enter') choose(st.hi);
      else if (k === 'Escape') close();
    },
  },
    h('view', { style: { fontSize: 14, color: sel ? '#111827' : '#9ca3af' } }, sel ? sel.label : placeholder),
    h('view', { style: { fontSize: 12, color: '#6b7280' } }, st.openId != null ? '\u25B4' : '\u25BE'));
}

// ===========================================================================
// Demo app: Select2 + a validated email field gating a Submit action.
// ===========================================================================
const FRUITS = [
  { label: 'Apple',  value: 'apple' },
  { label: 'Banana', value: 'banana' },
  { label: 'Cherry', value: 'cherry' },
  { label: 'Durian', value: 'durian' },
];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const field = (label, control) => h('view', { style: { gap: 6 } },
  h('view', { style: { fontSize: 13, fontWeight: '600', color: '#334155' } }, label),
  control);

const App = {
  setup() {
    const s = reactive({ fruit: null, email: '' });
    // VALIDATION as derived state.
    const emailOk = computed(() => EMAIL_RE.test(s.email));
    const formOk  = computed(() => emailOk.value && s.fruit != null);

    return () => h('view', {
      style: { width: '100%', height: '100%', padding: 40, gap: 24, backgroundColor: '#f8fafc' },
    },
      h('view', { style: { fontSize: 24, fontWeight: '700', color: '#0f172a' } }, 'Advanced components'),

      field('Favorite fruit',
        Select2({ id: 'fruit', value: s.fruit, options: FRUITS, onUpdate: (v) => { s.fruit = v; } })),

      field('Email', h('view', { style: { gap: 6 } },
        NInput({ id: 'email', value: s.email, onInput: (v) => { s.email = v; }, width: 260,
                 placeholder: 'you@example.com' }),
        (s.email.length > 0 && !emailOk.value)
          ? h('view', { style: { color: '#dc2626', fontSize: 12 } }, 'Enter a valid email')
          : null)),

      // ACTION gated by validation: the button is disabled until the form is OK.
      h('view', {
        style: { marginTop: 8, width: 120, height: 38, borderRadius: 8,
                 alignItems: 'center', justifyContent: 'center',
                 backgroundColor: formOk.value ? '#16a34a' : '#cbd5e1' },
        hoverStyle: formOk.value ? { backgroundColor: '#15803d' } : undefined,
        onClick: formOk.value ? () => console.log('submit:', s.fruit, s.email) : undefined,
      }, h('view', { style: { color: '#ffffff', fontSize: 15, fontWeight: '600' } }, 'Submit')),

      // Required once, at the app root: popups render into this top layer so they
      // paint above everything and aren't clipped by parents.
      NOverlayHost());
  },
};

createApp(App).mount(document.body);
