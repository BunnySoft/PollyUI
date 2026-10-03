// naive.mjs — a Naive UI-flavored component library (themed, N-prefixed).
// Components are factories returning vnodes, so they compose with h()/the
// reconciler and Vue's createApp.
//
//   import { NCard, NButton, NSpace, NSwitch, NTag, NInput, NTabs, useTheme }
//     from './js/naive.mjs';

import { h, reactive } from './js/vue.mjs';
import { clampTextIndex, previousTextIndex, nextTextIndex, removeLastCodePoint } from './js/textindex.mjs';

// ---- themes -----------------------------------------------------------------

export const lightTheme = {
  name: 'light',
  primary: '#18a058', info: '#2080f0', success: '#18a058', warning: '#f0a020', error: '#d03050',
  text: '#333639', textSecondary: '#666a73', textDisabled: '#c2c2c2',
  border: '#e0e0e6', card: '#ffffff', body: '#f5f7fa',
  solidText: '#ffffff', railOff: '#dbdbdb', trackBg: '#eef0f2',
};
export const darkTheme = {
  name: 'dark',
  primary: '#63e2b7', info: '#70c0e8', success: '#63e2b7', warning: '#f2c97d', error: '#e88080',
  text: '#d6d6d8', textSecondary: '#9b9ba1', textDisabled: '#5b5b5f',
  border: '#2d2d33', card: '#18181c', body: '#101014',
  solidText: '#101014', railOff: '#3a3a40', trackBg: '#ffffff14',
};

// The live, mutable active theme (components read it at render time).
export const theme = { ...lightTheme };
export function useTheme(name) { Object.assign(theme, name === 'dark' ? darkTheme : lightTheme); return theme; }

const typeColor = (t) => ({ primary: theme.primary, info: theme.info, success: theme.success, warning: theme.warning, error: theme.error }[t]);
const lightTagBg = { primary: '#e8f5ee', info: '#e3effd', success: '#e8f5ee', warning: '#fdf2e3', error: '#fce8ee', default: '#fafafc' };

// Lighten (amt > 0, toward white) or darken (amt < 0, toward black) a #rrggbb
// color by a fraction in [-1, 1]. Used for hover/active shades.
export function shade(hex, amt) {
  if (typeof hex !== 'string' || hex[0] !== '#' || hex.length < 7) return hex;
  const to = amt < 0 ? 0 : 255, p = Math.min(1, Math.abs(amt));
  const ch = (i) => { const c = parseInt(hex.slice(i, i + 2), 16); return Math.round(c + (to - c) * p).toString(16).padStart(2, '0'); };
  return '#' + ch(1) + ch(3) + ch(5);
}

// Shared hover/focus border feedback for input-like control boxes (input,
// select, pickers, ...): hover -> light primary border, focus -> primary border.
const ctrlHover = () => ({ borderColor: shade(theme.primary, 0.35) });
const ctrlFocus = () => ({ borderColor: theme.primary });

// drop undefined/null so they don't stringify to "undefined"
const clean = (o) => { const r = {}; for (const k in o) if (o[k] !== undefined && o[k] !== null) r[k] = String(o[k]); return r; };

// ---- blinking text caret (shared by the text inputs) -----------------------
// Native focus isn't reactive, so focus/blur handlers set the active id and a
// reactive blink toggles re-renders. Inputs need a stable `id` for the caret.
const _caret = reactive({ on: true, tick: 0, activeId: null });
let _caretBlinking = false, _caretLast = 0;
function caretFocus(id) {
  if (!id) return;
  _caret.activeId = id; _caret.on = true; _caret.tick++;
  if (_caretBlinking) return;
  // Blink via rAF (not setInterval): a perpetual interval would keep the
  // headless run-loop alive forever; rAF is driven by the frame pump instead.
  _caretBlinking = true; _caretLast = 0;
  const loop = (ts) => {
    if (_caret.activeId === null) { _caretBlinking = false; return; }
    if (_caretLast === 0) _caretLast = ts;
    if (ts - _caretLast >= 530) { _caretLast = ts; _caret.on = !_caret.on; }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
function caretBlur(id) { if (_caret.activeId === id) { _caret.activeId = null; _caret.tick++; } }

// Per-input caret/selection state (the value is controlled; caret index is not).
const _inputs = {};
function inputState(id, len) {
  const st = _inputs[id] || (_inputs[id] = reactive({ caret: 0, anchor: null, dragging: false }));
  if (st.caret > len) st.caret = len;
  if (st.anchor != null && st.anchor > len) st.anchor = len;
  return st;
}
function indexAtX(value, fontSize, localX) {
  let best = 0, bestD = Infinity;
  for (let i = 0; ; i = nextTextIndex(value, i)) {
    const d = Math.abs(measureText(value.slice(0, i), fontSize) - localX);
    if (d < bestD) { bestD = d; best = i; }
    if (i === value.length) break;
  }
  return best;
}
// A caret vnode for a focused input (or null). Place inside a position:relative box.
function textCaret(id, value, fontSize, padLeft, color, boxHeight) {
  const on = _caret.on; void _caret.tick;            // track reactive deps
  if (!id || _caret.activeId !== id || !on) return null;
  const x = padLeft + measureText(String(value), fontSize);
  return h('view', { style: clean({ position: 'absolute', left: x, top: (boxHeight - fontSize) / 2, width: 1.5, height: fontSize + 2, backgroundColor: color }) });
}

// ---- NButton ----------------------------------------------------------------

const BTN_SIZE = { small: { h: 28, fs: 14, px: 10 }, medium: { h: 34, fs: 14, px: 14 }, large: { h: 40, fs: 16, px: 18 } };

export function NButton(props = {}, label) {
  const { type = 'default', size = 'medium', round = false, ghost = false, disabled = false, onClick, id } = props;
  const sz = BTN_SIZE[size] || BTN_SIZE.medium;
  const color = typeColor(type);
  const style = {
    height: sz.h, paddingLeft: sz.px, paddingRight: sz.px, borderRadius: round ? sz.h / 2 : 3,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    fontSize: sz.fs, fontWeight: '500', color: theme.solidText, opacity: disabled ? 0.5 : 1,
  };
  let hoverStyle;
  if (!color)        { style.backgroundColor = ghost ? 'transparent' : theme.card; style.borderWidth = 1; style.borderColor = theme.border; style.color = theme.text;
                       hoverStyle = { borderColor: theme.primary, color: theme.primary }; }
  else if (ghost)    { style.backgroundColor = 'transparent'; style.borderWidth = 1; style.borderColor = color; style.color = color;
                       hoverStyle = { backgroundColor: shade(color, 0.88), borderColor: shade(color, 0.2) }; }
  else               { style.backgroundColor = color;
                       hoverStyle = { backgroundColor: shade(color, 0.16) }; }
  return h('view', { id, style: clean(style), hoverStyle: disabled ? undefined : hoverStyle, onClick: disabled ? undefined : onClick }, label);
}

// ---- NTag -------------------------------------------------------------------

export function NTag(props = {}, label) {
  const { type = 'default', round = false, id } = props;
  const color = typeColor(type) || theme.text;
  const bg = type === 'default'
    ? (theme.name === 'dark' ? '#ffffff14' : lightTagBg.default)
    : (theme.name === 'dark' ? color + '2e' : (lightTagBg[type] || lightTagBg.default));
  return h('view', {
    id,
    style: clean({
      height: 24, paddingLeft: 9, paddingRight: 9, borderRadius: round ? 12 : 2,
      backgroundColor: bg, borderWidth: 1, borderColor: type === 'default' ? theme.border : color,
      alignItems: 'center', justifyContent: 'center', flexDirection: 'row',
    }),
  }, h('view', { style: { color, fontSize: '13' } }, label));
}

// ---- NSwitch ----------------------------------------------------------------

export function NSwitch(props = {}) {
  const { value = false, onUpdate, disabled = false, id } = props;
  const W = 40, H = 22, knob = 18, pad = 2;
  return h('view', {
    id,
    style: clean({ width: W, height: H, borderRadius: H / 2, position: 'relative', backgroundColor: value ? theme.primary : theme.railOff, opacity: disabled ? 0.5 : 1 }),
    onClick: disabled ? undefined : () => onUpdate && onUpdate(!value),
  }, h('view', { style: clean({ position: 'absolute', top: pad, left: value ? W - knob - pad : pad, width: knob, height: knob, borderRadius: knob / 2, backgroundColor: '#ffffff' }) }));
}

// ---- NCheckbox --------------------------------------------------------------

export function NCheckbox(props = {}, label) {
  const { checked = false, disabled = false, onChange, id } = props;
  return h('view', {
    id,
    style: clean({ flexDirection: 'row', alignItems: 'center', gap: 8, opacity: disabled ? 0.5 : 1 }),
    onClick: disabled ? undefined : () => onChange && onChange(!checked),
  },
    h('view', { style: clean({ width: 18, height: 18, borderRadius: 3, alignItems: 'center', justifyContent: 'center', backgroundColor: checked ? theme.primary : theme.card, borderWidth: checked ? 0 : 1, borderColor: theme.border }) },
      checked ? h('view', { style: { color: theme.solidText, fontSize: '13', fontWeight: 'bold' } }, '✓') : null),
    label ? h('view', { style: { color: theme.text, fontSize: '14' } }, label) : null);
}

// ---- NRadioGroup ------------------------------------------------------------

export function NRadioGroup(props = {}) {
  const { value, onUpdate, options = [], vertical = false } = props;
  return h('view', { style: { flexDirection: vertical ? 'column' : 'row', gap: '16' } },
    ...options.map(opt => {
      const on = opt.value === value;
      return h('view', { style: { flexDirection: 'row', alignItems: 'center', gap: '8' }, onClick: () => onUpdate && onUpdate(opt.value) },
        h('view', { style: clean({ width: 18, height: 18, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.card, borderWidth: 2, borderColor: on ? theme.primary : theme.border }) },
          on ? h('view', { style: { width: '8', height: '8', borderRadius: '4', backgroundColor: theme.primary } }) : null),
        h('view', { style: { color: theme.text, fontSize: '14' } }, opt.label));
    }));
}

// ---- NSlider (click + drag) -------------------------------------------------

export function NSlider(props = {}) {
  const { value = 0, min = 0, max = 100, width = 200, onUpdate, id } = props;
  const pct = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const setFromX = (e) => {
    const root = e.currentTarget;
    let v = min + ((e.clientX - root.offsetLeft) / root.offsetWidth) * (max - min);
    v = Math.max(min, Math.min(max, Math.round(v)));
    onUpdate && onUpdate(v);
  };
  return h('view', {
    id,
    style: clean({ width, height: 18, position: 'relative', justifyContent: 'center' }),
    onMousedown: (e) => { e.currentTarget.__drag = true; setFromX(e); },
    onMousemove: (e) => { if (e.currentTarget.__drag) setFromX(e); },
    onMouseup: (e) => { e.currentTarget.__drag = false; },
  },
    h('view', { style: clean({ position: 'absolute', top: 7, left: 0, width: '100%', height: 4, borderRadius: 2, backgroundColor: theme.railOff }) }),
    h('view', { style: clean({ position: 'absolute', top: 7, left: 0, width: pct * width, height: 4, borderRadius: 2, backgroundColor: theme.primary }) }),
    h('view', { style: clean({ position: 'absolute', top: 2, left: pct * width - 7, width: 14, height: 14, borderRadius: 7, backgroundColor: '#ffffff', borderWidth: 2, borderColor: theme.primary }) }));
}

// ---- NProgress --------------------------------------------------------------

export function NProgress(props = {}) {
  const { percentage = 0, type = 'primary', width } = props;
  const color = typeColor(type) || theme.primary;
  const p = Math.max(0, Math.min(100, percentage));
  return h('view', { style: clean({ width, flexDirection: 'row', alignItems: 'center', gap: 10 }) },
    h('view', { style: clean({ flexGrow: 1, height: 8, borderRadius: 4, backgroundColor: theme.trackBg }) },
      h('view', { style: clean({ width: p + '%', height: 8, borderRadius: 4, backgroundColor: color }) })),
    h('view', { style: clean({ width: 42, color: theme.textSecondary, fontSize: 13 }) }, p + '%'));
}

// ---- NAlert -----------------------------------------------------------------

export function NAlert(props = {}, content) {
  const { type = 'info', title, id } = props;
  const color = typeColor(type) || theme.info;
  return h('view', { id, style: clean({ flexDirection: 'row', gap: 10, padding: 14, borderRadius: 3, backgroundColor: color + '1f', borderWidth: 1, borderColor: color + '4d' }) },
    h('view', { style: clean({ width: 4, borderRadius: 2, backgroundColor: color }) }),
    h('view', { style: { gap: '4', flexGrow: '1' } },
      title ? h('view', { style: { color: theme.text, fontSize: '14', fontWeight: 'bold' } }, title) : null,
      content ? h('view', { style: { color: theme.textSecondary, fontSize: '13' } }, content) : null));
}

// ---- NTabs ------------------------------------------------------------------

export function NTabs(props = {}) {
  const { value, onUpdate, panes = [] } = props;
  const active = panes.find(p => p.name === value) || panes[0];
  return h('view', { style: { flexDirection: 'column' } },
    h('view', { style: clean({ flexDirection: 'row', gap: 24, borderBottomWidth: 0 }) },
      ...panes.map(p => {
        const on = active && p.name === active.name;
        return h('view', { style: { flexDirection: 'column', gap: '8', paddingTop: '10' }, onClick: () => onUpdate && onUpdate(p.name) },
          h('view', { style: clean({ color: on ? theme.primary : theme.text, fontSize: 14, fontWeight: on ? 'bold' : 'normal', paddingBottom: 8 }) }, p.label),
          h('view', { style: clean({ height: 2, borderRadius: 1, backgroundColor: on ? theme.primary : 'transparent' }) }));
      })),
    h('view', { style: { paddingTop: '16' } }, active ? (typeof active.content === 'function' ? active.content() : active.content) : null));
}

// ---- NModal -----------------------------------------------------------------

export function NModal(props = {}, ...children) {
  const { show = false, title, onClose, width = 440 } = props;
  if (!show) return h('view', { style: { width: '0', height: '0' } });
  return h('view', {
    style: clean({ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', backgroundColor: '#00000080', alignItems: 'center', justifyContent: 'center' }),
    onClick: onClose,
  }, h('view', { onClick: (e) => e.stopPropagation() }, NCard({ title, width }, ...children)));
}

// ---- NSpace -----------------------------------------------------------------

const SPACE_SIZE = { small: 8, medium: 12, large: 16 };

export function NSpace(props = {}, ...children) {
  const { vertical = false, size = 'medium', align, justify } = props;
  const gap = typeof size === 'number' ? size : (SPACE_SIZE[size] || 12);
  return h('view', { style: clean({ flexDirection: vertical ? 'column' : 'row', gap, alignItems: align, justifyContent: justify }) }, ...children);
}

// ---- NCard ------------------------------------------------------------------

export function NCard(props = {}, ...children) {
  const { title, bordered = true, width, id } = props;
  const kids = [];
  if (title) {
    kids.push(h('view', { style: { paddingLeft: '20', paddingRight: '20', paddingTop: '15', paddingBottom: '15' } },
      h('view', { style: { fontSize: '18', fontWeight: 'bold', color: theme.text } }, title)));
    kids.push(h('view', { style: { height: '1', backgroundColor: theme.border } }));
  }
  kids.push(h('view', { style: { padding: '20', gap: '12' } }, ...children));
  return h('view', { id, style: clean({ backgroundColor: theme.card, borderRadius: 3, width, borderWidth: bordered ? 1 : 0, borderColor: theme.border }) }, ...kids);
}

// ---- NInput (controlled) ----------------------------------------------------

export function NInput(props = {}) {
  const { value = '', placeholder = '', onInput, width = 200, size = 'medium', id, selectionColor = '#93c5fd' } = props;
  const fs = size === 'large' ? 16 : 14;
  const h0 = BTN_SIZE[size] ? BTN_SIZE[size].h : 34;
  const pad = 12;
  const isPh = value.length === 0;
  const st = id ? inputState(id, value.length) : null;
  if (st) {
    st.caret = clampTextIndex(value, st.caret);
    if (st.anchor != null) st.anchor = clampTextIndex(value, st.anchor);
  }
  const focused = id && _caret.activeId === id;
  const xOf = (i) => pad + measureText(value.slice(0, i), fs);
  const localX = (e) => e.clientX - (e.currentTarget.offsetLeft + pad);
  const sel = (st && st.anchor != null && st.anchor !== st.caret) ? [Math.min(st.anchor, st.caret), Math.max(st.anchor, st.caret)] : null;

  const kids = [];
  if (focused && sel) kids.push(h('view', { style: clean({ position: 'absolute', left: xOf(sel[0]), top: (h0 - fs) / 2 - 1, width: xOf(sel[1]) - xOf(sel[0]), height: fs + 2, backgroundColor: selectionColor }) }));
  kids.push(h('view', { style: { color: isPh ? theme.textDisabled : theme.text, fontSize: String(fs) } }, isPh ? placeholder : value));
  if (focused && _caret.on) kids.push(h('view', { style: clean({ position: 'absolute', left: xOf(st ? st.caret : value.length), top: (h0 - fs) / 2, width: 1.5, height: fs + 2, backgroundColor: theme.text }) }));

  const curSel = () => (st && st.anchor != null && st.anchor !== st.caret) ? [Math.min(st.anchor, st.caret), Math.max(st.anchor, st.caret)] : null;
  const replace = (ins) => { const [s0, e0] = curSel() || [st.caret, st.caret]; onInput && onInput(value.slice(0, s0) + ins + value.slice(e0)); st.caret = s0 + ins.length; st.anchor = null; };

  return h('view', {
    id, tabIndex: 0,
    style: clean({ width, height: h0, backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border, borderRadius: 3, paddingLeft: pad, paddingRight: pad, justifyContent: 'center', overflow: 'hidden', position: 'relative' }),
    hoverStyle: ctrlHover(), focusStyle: ctrlFocus(),
    onFocus: () => caretFocus(id), onBlur: () => { caretBlur(id); if (st) st.anchor = null; },
    onMousedown: (e) => { if (e.currentTarget.focus) e.currentTarget.focus(); if (!st) return; const i = indexAtX(value, fs, localX(e)); st.caret = i; st.anchor = i; st.dragging = true; _caret.on = true; _caret.tick++; },
    onMousemove: (e) => { if (st && st.dragging) { st.caret = indexAtX(value, fs, localX(e)); _caret.tick++; } },
    onMouseup: () => { if (st) { st.dragging = false; if (st.anchor === st.caret) st.anchor = null; _caret.tick++; } },
    onKeydown: (e) => {
      if (!st) { if (onInput && e.key === 'Backspace') onInput(removeLastCodePoint(value)); return; }
      const k = e.key;
      if (k === 'ArrowLeft') { st.caret = previousTextIndex(value, st.caret); st.anchor = null; }
      else if (k === 'ArrowRight') { st.caret = nextTextIndex(value, st.caret); st.anchor = null; }
      else if (k === 'Home') { st.caret = 0; st.anchor = null; }
      else if (k === 'End') { st.caret = value.length; st.anchor = null; }
      else if (k === 'Backspace') { const s = curSel(); if (s) { onInput && onInput(value.slice(0, s[0]) + value.slice(s[1])); st.caret = s[0]; st.anchor = null; } else if (st.caret > 0) { const start = previousTextIndex(value, st.caret); onInput && onInput(value.slice(0, start) + value.slice(st.caret)); st.caret = start; } }
      else if (k === 'Delete') { const s = curSel(); if (s) { onInput && onInput(value.slice(0, s[0]) + value.slice(s[1])); st.caret = s[0]; st.anchor = null; } else if (st.caret < value.length) { onInput && onInput(value.slice(0, st.caret) + value.slice(nextTextIndex(value, st.caret))); } }
      else return;
      _caret.on = true; _caret.tick++;
    },
    onTextinput: e => {
      if (st) replace(e.data); else if (onInput) onInput(value + e.data);
      _caret.on = true; _caret.tick++;
    },
  }, ...kids);
}

// ---- portal / overlay layer -------------------------------------------------
// Popups (Select dropdown, Tooltip) render into a top-level layer so they paint
// over everything and aren't clipped by parents. Put NOverlayHost() once at the
// end of your app root (which should fill the viewport). The layer is reactive,
// so opening/closing a popup re-renders via Vue/the reconciler.

const _overlays = reactive({ list: [] });
let _ovSeq = 0;

export function openPopup(render, opts = {}) {
  const id = ++_ovSeq;
  _overlays.list = _overlays.list.concat({ id, render, x: opts.x || 0, y: opts.y || 0, onClose: opts.onClose, backdrop: opts.backdrop !== false, fullWidth: !!opts.fullWidth, fullScreen: !!opts.fullScreen });
  return id;
}
export function closePopup(id) { _overlays.list = _overlays.list.filter(o => o.id !== id); }

export function NOverlayHost() {
  const active = _overlays.list.length > 0;
  // Flattened: backdrop + positioned popup are DIRECT children (a wrapper view
  // would be 0x0 since its children are absolute, and hit-testing prunes by box
  // — that would make popups paint but not be clickable).
  const kids = [];
  for (const o of _overlays.list) {
    if (o.backdrop) kids.push(h('view', { key: 'bd' + o.id, style: clean({ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', backgroundColor: 'transparent' }), onClick: () => o.onClose && o.onClose() }));
    kids.push(h('view', { key: 'pop' + o.id, style: clean({ position: 'absolute', top: o.y, left: o.x, width: (o.fullWidth || o.fullScreen) ? '100%' : undefined, height: o.fullScreen ? '100%' : undefined }) }, typeof o.render === 'function' ? o.render() : o.render));
  }
  // pointerEvents:none lets clicks fall through the (full-screen) host to the app
  // below; only the actual popups and modal backdrops (auto pointerEvents) catch
  // clicks. Without this a non-modal toast/loadingBar would freeze the whole UI.
  return h('view', { style: clean({ position: 'absolute', top: 0, left: 0, width: active ? '100%' : 0, height: active ? '100%' : 0, pointerEvents: 'none' }) }, ...kids);
}

// ---- NSelect ----------------------------------------------------------------

export function NSelect(props = {}) {
  const { value, options = [], onUpdate, placeholder = 'Select', width = 200, id } = props;
  const sel = options.find(o => o.value === value);

  const open = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    let pid;
    const dropdown = () => h('view', {
      style: clean({ width, backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border, borderRadius: 3, padding: 4, gap: 2 }),
    }, ...options.map(o => h('view', {
      style: clean({ height: 32, paddingLeft: 10, paddingRight: 10, borderRadius: 3, justifyContent: 'center',
        backgroundColor: o.value === value ? theme.primary + '1f' : 'transparent' }),
      onClick: () => { onUpdate && onUpdate(o.value); closePopup(pid); },
    }, h('view', { style: { color: o.value === value ? theme.primary : theme.text, fontSize: '14' } }, o.label))));
    pid = openPopup(dropdown, { x: r.left, y: r.bottom + 4, onClose: () => closePopup(pid) });
  };

  return h('view', {
    id, tabIndex: 0,
    style: clean({ width, height: 34, backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border, borderRadius: 3, paddingLeft: 12, paddingRight: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }),
    hoverStyle: ctrlHover(), focusStyle: ctrlFocus(),
    onClick: open,
  },
    h('view', { style: { color: sel ? theme.text : theme.textDisabled, fontSize: '14' } }, sel ? sel.label : placeholder),
    h('view', { style: { color: theme.textSecondary, fontSize: '12' } }, '▾'));
}

// ---- NTooltip ---------------------------------------------------------------

export function NTooltip(props = {}, trigger) {
  const { content, placement = 'top' } = props;
  // mouseenter doesn't bubble, so attach the hover handlers to the trigger
  // element itself (the node actually hovered) rather than a wrapper.
  trigger.props = trigger.props || {};
  trigger.props.onMouseenter = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const tip = () => h('view', {
      style: clean({ backgroundColor: theme.name === 'dark' ? '#ffffff' : '#000000e0', borderRadius: 4, paddingLeft: 10, paddingRight: 10, paddingTop: 6, paddingBottom: 6 }),
    }, h('view', { style: { color: theme.name === 'dark' ? '#000000' : '#ffffff', fontSize: '13' } }, content));
    const y = placement === 'bottom' ? r.bottom + 8 : r.top - 34;
    e.currentTarget.__tip = openPopup(tip, { x: r.left, y, backdrop: false });
  };
  trigger.props.onMouseleave = (e) => {
    if (e.currentTarget.__tip) { closePopup(e.currentTarget.__tip); e.currentTarget.__tip = 0; }
  };
  return trigger;
}

// ---- form validation --------------------------------------------------------

// Validate one value against an array of rules. Returns an error string or null.
export function validateField(value, rules) {
  for (const r of (rules || [])) {
    const empty = value == null || value === '';
    if (r.required && empty) return r.message || 'This field is required';
    if (!empty) {
      if (r.min != null && String(value).length < r.min) return r.message || `At least ${r.min} characters`;
      if (r.max != null && String(value).length > r.max) return r.message || `At most ${r.max} characters`;
      if (r.pattern && !r.pattern.test(String(value))) return r.message || 'Invalid format';
      if (r.validator) { const e = r.validator(value); if (e) return e; }
    }
  }
  return null;
}

// Validate a values object against a schema { field: rules[] }. Returns a map
// of field -> error (empty object means the form is valid).
export function validateForm(values, schema) {
  const errors = {};
  for (const key in schema) {
    const e = validateField(values[key], schema[key]);
    if (e) errors[key] = e;
  }
  return errors;
}

// ---- NFormItem --------------------------------------------------------------

export function NFormItem(props = {}, control) {
  const { label, error, form, path } = props;
  // When wired to a form (form + path), the error/required come from the form's
  // reactive validation state and declared rules; otherwise use explicit props.
  const err = error != null ? error : (form && path ? form.errors[path] : null);
  const required = props.required != null ? props.required
    : (form && path ? (Array.isArray(form.rules[path]) ? form.rules[path] : [form.rules[path]]).some(r => r && r.required) : false);
  return h('view', { style: { flexDirection: 'column', gap: '6' } },
    label ? h('view', { style: { flexDirection: 'row', gap: '3' } },
      h('view', { style: { color: theme.text, fontSize: '14', fontWeight: '500' } }, label),
      required ? h('view', { style: { color: theme.error, fontSize: '14' } }, '*') : null) : null,
    control,
    err ? h('view', { id: props.errorId, style: { color: theme.error, fontSize: '12' } }, err) : null);
}

// ---- NForm + createForm (validation orchestration) --------------------------
// createForm(model, rules) returns a reactive form instance:
//   { model, rules, errors, validate(), validateField(path), clearValidation() }
// A rule is { required, min, max, pattern, validator(value, model), message } or
// an array of them. validator returns true/undefined (ok) or false/string (fail).
export function createForm(model, rules = {}) {
  const state = reactive({ errors: {} });
  const setErr = (path, msg) => { const e = { ...state.errors }; if (msg) e[path] = msg; else delete e[path]; state.errors = e; };
  const validateField = (path) => {
    const raw = rules[path]; if (!raw) { setErr(path, null); return true; }
    const list = Array.isArray(raw) ? raw : [raw];
    const v = model[path];
    const empty = v == null || v === '' || (Array.isArray(v) && v.length === 0);
    for (const r of list) {
      let msg = null;
      if (r.required && empty) msg = r.message || 'This field is required';
      else if (!empty && r.min != null && String(v).length < r.min) msg = r.message || `At least ${r.min} characters`;
      else if (!empty && r.max != null && String(v).length > r.max) msg = r.message || `At most ${r.max} characters`;
      else if (!empty && r.pattern && !r.pattern.test(String(v))) msg = r.message || 'Invalid format';
      else if (r.validator) { const res = r.validator(v, model); if (res === false || typeof res === 'string') msg = typeof res === 'string' ? res : (r.message || 'Invalid value'); }
      if (msg) { setErr(path, msg); return false; }
    }
    setErr(path, null);
    return true;
  };
  const validate = () => { let ok = true; for (const p in rules) if (!validateField(p)) ok = false; return ok; };
  const clearValidation = () => { state.errors = {}; };
  // `errors` is a live getter so reads always see the current reactive object
  // (validate() reassigns it); reading form.errors[path] in NFormItem subscribes.
  return { model, rules, validate, validateField, clearValidation, get errors() { return state.errors; } };
}

export function NForm(props = {}, ...items) {
  const { id } = props;
  return h('view', { id, style: clean({ flexDirection: 'column', gap: props.gap != null ? props.gap : 18 }) }, ...items.filter(Boolean));
}

// ---- NAvatar ----------------------------------------------------------------

export function NAvatar(props = {}, fallback) {
  const { src, size = 40, round = true, color } = props;
  const style = clean({ width: size, height: size, borderRadius: round ? size / 2 : 6, overflow: 'hidden',
    alignItems: 'center', justifyContent: 'center', backgroundColor: color || theme.primary });
  if (src) style.backgroundImage = src;
  return h('view', { id: props.id, style },
    !src && fallback ? h('view', { style: clean({ color: theme.solidText, fontSize: Math.round(size * 0.4), fontWeight: 'bold' }) }, fallback) : null);
}

// ---- NBadge -----------------------------------------------------------------

export function NBadge(props = {}, child) {
  const { value, dot = false, max = 99 } = props;
  const show = dot || (value != null && value !== 0);
  const text = dot ? '' : (typeof value === 'number' && value > max ? max + '+' : String(value));
  return h('view', { id: props.id, style: { position: 'relative', flexDirection: 'row' } },
    child,
    show ? h('view', {
      style: clean({ position: 'absolute', top: dot ? 0 : -8, right: dot ? 0 : -10, minWidth: dot ? 8 : 18, height: dot ? 8 : 18,
        borderRadius: dot ? 4 : 9, backgroundColor: theme.error, paddingLeft: dot ? 0 : 5, paddingRight: dot ? 0 : 5,
        alignItems: 'center', justifyContent: 'center' }) },
      text ? h('view', { style: { color: '#ffffff', fontSize: '12', fontWeight: 'bold' } }, text) : null) : null);
}

// ---- NPagination ------------------------------------------------------------

export function NPagination(props = {}) {
  const { page = 1, pageCount = 1, onUpdate, id } = props;
  const btn = (lbl, target, opts = {}) => h('view', {
    style: clean({ minWidth: 32, height: 32, paddingLeft: 6, paddingRight: 6, borderRadius: 3, alignItems: 'center', justifyContent: 'center',
      flexDirection: 'row', borderWidth: 1, borderColor: opts.active ? theme.primary : theme.border,
      backgroundColor: opts.active ? theme.primary : theme.card, opacity: opts.disabled ? 0.5 : 1 }),
    onClick: opts.disabled || opts.active ? undefined : () => onUpdate && onUpdate(target),
  }, h('view', { style: clean({ color: opts.active ? theme.solidText : theme.text, fontSize: 14 }) }, lbl));
  const items = [btn('‹', page - 1, { disabled: page <= 1 })];
  for (let p = 1; p <= pageCount; p++) items.push(btn(String(p), p, { active: p === page }));
  items.push(btn('›', page + 1, { disabled: page >= pageCount }));
  return h('view', { id, style: { flexDirection: 'row', gap: '8' } }, ...items);
}

// ---- NDataTable -------------------------------------------------------------

export function NDataTable(props = {}) {
  const { columns = [], data = [], id, rowKey = (r, i) => i,
          selectable = false, selectedKeys = [], onSelectionChange,
          sortBy, sortOrder, onSort } = props;
  const sel = new Set(selectedKeys);
  const allKeys = data.map((r, i) => rowKey(r, i));

  const cell = (content, col, header) => {
    const inner = (content && typeof content === 'object')
      ? content
      : h('view', { style: clean({ color: header ? theme.textSecondary : theme.text, fontSize: 14, fontWeight: header ? 'bold' : 'normal' }) }, String(content));
    return h('view', { style: clean({ width: col.width, flexGrow: col.width ? undefined : 1, paddingLeft: 12, paddingRight: 12, paddingTop: 10, paddingBottom: 10, justifyContent: 'center', flexDirection: 'row', alignItems: 'center' }) }, inner);
  };
  const checkCell = (node) => h('view', { style: { width: '44', paddingLeft: '14', paddingTop: '10', paddingBottom: '10', justifyContent: 'center' } }, node);

  // header
  const headerCells = [];
  if (selectable) {
    const allOn = data.length > 0 && allKeys.every(k => sel.has(k));
    headerCells.push(checkCell(NCheckbox({ checked: allOn, onChange: () => onSelectionChange && onSelectionChange(allOn ? [] : allKeys.slice()) })));
  }
  columns.forEach(c => {
    if (c.sortable && onSort) {
      const active = sortBy === c.key;
      const indicator = active ? (sortOrder === 'asc' ? ' ▲' : ' ▼') : ' ↕';
      headerCells.push(h('view', {
        style: clean({ width: c.width, flexGrow: c.width ? undefined : 1, paddingLeft: 12, paddingRight: 12, paddingTop: 10, paddingBottom: 10, flexDirection: 'row', alignItems: 'center' }),
        onClick: () => onSort(c.key, active && sortOrder === 'asc' ? 'desc' : 'asc'),
      }, h('view', { style: clean({ color: active ? theme.primary : theme.textSecondary, fontSize: 14, fontWeight: 'bold' }) }, c.title + indicator)));
    } else {
      headerCells.push(cell(c.title, c, true));
    }
  });

  const rows = [
    h('view', { style: clean({ flexDirection: 'row', backgroundColor: theme.name === 'dark' ? '#ffffff08' : '#fafafc' }) }, ...headerCells),
    h('view', { style: { height: '1', backgroundColor: theme.border } }),
  ];
  data.forEach((row, i) => {
    const k = rowKey(row, i);
    const cells = [];
    if (selectable) cells.push(checkCell(NCheckbox({ checked: sel.has(k), onChange: () => {
      const next = sel.has(k) ? selectedKeys.filter(x => x !== k) : selectedKeys.concat(k);
      onSelectionChange && onSelectionChange(next);
    } })));
    columns.forEach(c => cells.push(cell(c.render ? c.render(row) : row[c.key], c, false)));
    rows.push(h('view', { style: clean({ flexDirection: 'row', backgroundColor: sel.has(k) ? theme.primary + '14' : 'transparent' }) }, ...cells));
    if (i < data.length - 1) rows.push(h('view', { style: { height: '1', backgroundColor: theme.border } }));
  });
  return h('view', { id, style: clean({ borderWidth: 1, borderColor: theme.border, borderRadius: 3, overflow: 'hidden', backgroundColor: theme.card, flexDirection: 'column' }) }, ...rows);
}

// ---- NTable (simple static table) -------------------------------------------
// Lightweight columns+data table (vs. the sortable/selectable NDataTable).
// columns: ['Name', ...] or [{ title, key, width, align, render(row, i) }].
export function NTable(props = {}) {
  const { columns = [], data = [], bordered = true, striped = false, size = 'medium', id } = props;
  const pad = size === 'small' ? 8 : size === 'large' ? 14 : 11;
  const cols = columns.map(c => (typeof c === 'string' ? { title: c, key: c } : c));
  const cell = (content, c, header) => h('view', {
    style: clean({ width: c.width, flexGrow: c.width ? undefined : 1, paddingLeft: 12, paddingRight: 12, paddingTop: pad, paddingBottom: pad,
      alignItems: c.align === 'right' ? 'flex-end' : c.align === 'center' ? 'center' : 'flex-start' }),
  }, (content && typeof content === 'object') ? content
    : h('view', { style: clean({ color: header ? theme.text : theme.textSecondary, fontSize: 14, fontWeight: header ? 'bold' : '400' }) }, String(content == null ? '' : content)));

  const rows = [
    h('view', { style: clean({ flexDirection: 'row', backgroundColor: theme.name === 'dark' ? '#ffffff08' : '#fafafc' }) }, ...cols.map(c => cell(c.title, c, true))),
    h('view', { style: { height: '1', backgroundColor: theme.border } }),
  ];
  data.forEach((row, i) => {
    const zebra = striped && i % 2 === 1;
    rows.push(h('view', { style: clean({ flexDirection: 'row', backgroundColor: zebra ? (theme.name === 'dark' ? '#ffffff05' : '#fafafc') : 'transparent' }) },
      ...cols.map(c => cell(c.render ? c.render(row, i) : row[c.key], c, false))));
    if (bordered && i < data.length - 1) rows.push(h('view', { style: { height: '1', backgroundColor: theme.border } }));
  });
  return h('view', { id, style: clean({ borderWidth: bordered ? 1 : 0, borderColor: theme.border, borderRadius: 3, overflow: 'hidden', backgroundColor: theme.card, flexDirection: 'column' }) }, ...rows);
}

// ---- NDropdown (menu on click) ----------------------------------------------

export function NDropdown(props = {}, trigger) {
  const { options = [], onSelect, width = 160 } = props;
  trigger.props = trigger.props || {};
  trigger.props.onClick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    let pid;
    const menu = () => h('view', { style: clean({ width, backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border, borderRadius: 3, padding: 4, gap: 2 }) },
      ...options.map(o => h('view', {
        style: clean({ height: 32, paddingLeft: 10, paddingRight: 10, borderRadius: 3, justifyContent: 'center' }),
        hoverStyle: { backgroundColor: theme.primary + '14' },
        onClick: () => { onSelect && onSelect(o.key); closePopup(pid); },
      }, h('view', { style: { color: theme.text, fontSize: '14' } }, o.label))));
    pid = openPopup(menu, { x: r.left, y: r.bottom + 4, onClose: () => closePopup(pid) });
  };
  return trigger;
}

// ---- NDatePicker ------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const pad2 = (n) => (n < 10 ? '0' + n : '' + n);
export const formatDate = (d) => d ? `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` : '';

function calendar(view, selected, onPick, onNav) {
  const startDow = new Date(view.year, view.month, 1).getDay();
  const daysInMonth = new Date(view.year, view.month + 1, 0).getDate();
  const header = h('view', { style: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingBottom: '8' } },
    h('view', { style: { width: '24', height: '24', alignItems: 'center', justifyContent: 'center' }, onClick: () => onNav(-1) }, h('view', { style: { color: theme.text } }, '‹')),
    h('view', { style: { color: theme.text, fontSize: '14', fontWeight: 'bold' } }, `${MONTHS[view.month]} ${view.year}`),
    h('view', { style: { width: '24', height: '24', alignItems: 'center', justifyContent: 'center' }, onClick: () => onNav(1) }, h('view', { style: { color: theme.text } }, '›')));
  const dow = h('view', { style: { flexDirection: 'row' } }, ...WEEKDAYS.map(w =>
    h('view', { style: { width: '32', height: '28', alignItems: 'center', justifyContent: 'center' } }, h('view', { style: { color: theme.textSecondary, fontSize: '12' } }, w))));
  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push(h('view', { style: { flexDirection: 'row' } }, ...cells.slice(i, i + 7).map(d => {
      const isSel = d && selected && selected.getFullYear() === view.year && selected.getMonth() === view.month && selected.getDate() === d;
      return h('view', {
        style: clean({ width: 32, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 3, backgroundColor: isSel ? theme.primary : 'transparent' }),
        onClick: d ? () => onPick(new Date(view.year, view.month, d)) : undefined,
      }, d ? h('view', { style: { color: isSel ? theme.solidText : theme.text, fontSize: '13' } }, String(d)) : null);
    })));
  }
  return h('view', { style: clean({ backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border, borderRadius: 3, padding: 12 }) }, header, dow, ...weeks);
}

export function NDatePicker(props = {}) {
  const { value, onUpdate, width = 200, id } = props;
  const open = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const base = value || new Date(2024, 0, 1);
    const view = { year: base.getFullYear(), month: base.getMonth() };
    let pid;
    const draw = () => calendar(view, value,
      (d) => { onUpdate && onUpdate(d); closePopup(pid); },
      (delta) => { view.month += delta; if (view.month < 0) { view.month = 11; view.year--; } if (view.month > 11) { view.month = 0; view.year++; } _overlays.list = _overlays.list.slice(); });
    pid = openPopup(draw, { x: r.left, y: r.bottom + 4, onClose: () => closePopup(pid) });
  };
  return h('view', {
    id, tabIndex: 0,
    style: clean({ width, height: 34, backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border, borderRadius: 3, paddingLeft: 12, paddingRight: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }),
    hoverStyle: ctrlHover(), focusStyle: ctrlFocus(),
    onClick: open,
  },
    h('view', { style: { color: value ? theme.text : theme.textDisabled, fontSize: '14' } }, value ? formatDate(value) : 'Select date'),
    h('view', { style: { color: theme.textSecondary, fontSize: '13' } }, '📅'));
}

// ---- NMessage (toasts) ------------------------------------------------------

export const message = {
  _show(type, text, duration = 3000) {
    const color = typeColor(type) || theme.info;
    const toast = () => h('view', { style: clean({ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border, borderRadius: 4, paddingLeft: 14, paddingRight: 14, paddingTop: 10, paddingBottom: 10, shadowColor: '#0000002e', shadowBlur: 16, shadowY: 4 }) },
      h('view', { style: clean({ width: 8, height: 8, borderRadius: 4, backgroundColor: color }) }),
      h('view', { style: { color: theme.text, fontSize: '14' } }, text));
    const id = openPopup(toast, { x: 300, y: 24, backdrop: false });
    if (duration > 0) setTimeout(() => closePopup(id), duration);
    return id;
  },
  info(t, d) { return this._show('info', t, d); },
  success(t, d) { return this._show('success', t, d); },
  warning(t, d) { return this._show('warning', t, d); },
  error(t, d) { return this._show('error', t, d); },
};

// ---- NCollapse (accordion) --------------------------------------------------

export function NCollapse(props = {}) {
  const { value = [], onUpdate, items = [], id } = props;
  const expanded = Array.isArray(value) ? value : [value];
  const toggle = (name) => onUpdate && onUpdate(expanded.includes(name) ? expanded.filter(n => n !== name) : expanded.concat(name));
  return h('view', { id, style: clean({ borderWidth: 1, borderColor: theme.border, borderRadius: 3, overflow: 'hidden', flexDirection: 'column', backgroundColor: theme.card }) },
    ...items.map((it, i) => {
      const open = expanded.includes(it.name);
      const parts = [
        h('view', { style: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingLeft: '16', paddingRight: '16', paddingTop: '14', paddingBottom: '14' }, onClick: () => toggle(it.name) },
          h('view', { style: { color: theme.text, fontSize: '14', fontWeight: '500' } }, it.title),
          h('view', { style: clean({ color: theme.textSecondary, fontSize: 13, rotate: open ? 90 : 0 }) }, '›')),
      ];
      if (open) parts.push(h('view', { style: { paddingLeft: '16', paddingRight: '16', paddingBottom: '14' } },
        (it.content && typeof it.content === 'object') ? it.content : h('view', { style: { color: theme.textSecondary, fontSize: '14' } }, String(it.content))));
      if (i < items.length - 1) parts.push(h('view', { style: { height: '1', backgroundColor: theme.border } }));
      return h('view', { style: { flexDirection: 'column' } }, ...parts);
    }));
}

// ---- NMenu ------------------------------------------------------------------

export function NMenu(props = {}) {
  const { value, onUpdate, items = [], mode = 'vertical', id } = props;
  const horizontal = mode === 'horizontal';
  return h('view', { id, style: clean({ flexDirection: horizontal ? 'row' : 'column', gap: horizontal ? 4 : 4, padding: horizontal ? 0 : 8, backgroundColor: theme.card }) },
    ...items.map(it => {
      const on = it.key === value;
      return h('view', {
        style: clean({ height: 40, paddingLeft: 16, paddingRight: 16, borderRadius: 3, flexDirection: 'row', alignItems: 'center', gap: 8,
          backgroundColor: on ? theme.primary + '1f' : 'transparent' }),
        onClick: () => onUpdate && onUpdate(it.key),
      },
        it.icon ? h('view', { style: clean({ color: on ? theme.primary : theme.textSecondary, fontSize: 15 }) }, it.icon) : null,
        h('view', { style: clean({ color: on ? theme.primary : theme.text, fontSize: 14, fontWeight: on ? 500 : 400 }) }, it.label));
    }));
}

// ---- NSteps -----------------------------------------------------------------

export function NSteps(props = {}) {
  const { current = 0, steps = [], id } = props;
  const items = [];
  steps.forEach((s, i) => {
    const done = i < current, active = i === current;
    if (i > 0) items.push(h('view', { style: clean({ flexGrow: 1, height: 2, marginLeft: 8, marginRight: 8, backgroundColor: i <= current ? theme.primary : theme.border }) }));
    items.push(h('view', { style: { flexDirection: 'row', alignItems: 'center', gap: '10' } },
      h('view', { style: clean({ width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: done || active ? theme.primary : theme.railOff }) },
        h('view', { style: clean({ color: done || active ? theme.solidText : theme.textSecondary, fontSize: 14, fontWeight: 'bold' }) }, done ? '✓' : String(i + 1))),
      h('view', { style: clean({ color: active ? theme.text : theme.textSecondary, fontSize: 14, fontWeight: active ? 600 : 400 }) }, s.title)));
  });
  return h('view', { id, style: { flexDirection: 'row', alignItems: 'center' } }, ...items);
}

// ---- NSpin (dot spinner; animate by passing rotation) -----------------------

export function NSpin(props = {}) {
  const { size = 28, rotation = 0, color, id } = props;
  const c = color || theme.primary;
  const n = 8, r = size / 2 - 3, dot = Math.max(3, Math.round(size / 8));
  const dots = [];
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * 2 * Math.PI;
    dots.push(h('view', { style: clean({ position: 'absolute',
      left: size / 2 + r * Math.cos(ang) - dot / 2, top: size / 2 + r * Math.sin(ang) - dot / 2,
      width: dot, height: dot, borderRadius: dot / 2, backgroundColor: c, opacity: (i + 1) / n }) }));
  }
  return h('view', { id, style: clean({ width: size, height: size, position: 'relative', rotate: rotation }) }, ...dots);
}

// ---- NPopconfirm ------------------------------------------------------------

export function NPopconfirm(props = {}, trigger) {
  const { title = 'Are you sure?', onConfirm, onCancel, confirmText = 'Yes', cancelText = 'No' } = props;
  trigger.props = trigger.props || {};
  trigger.props.onClick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    let pid; const close = () => closePopup(pid);
    const pop = () => h('view', { style: clean({ width: 240, backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border, borderRadius: 4, padding: 14, gap: 12, shadowColor: '#0000002e', shadowBlur: 16, shadowY: 4 }) },
      h('view', { style: { flexDirection: 'row', gap: '8', alignItems: 'center' } },
        h('view', { style: { width: '16', height: '16', borderRadius: '8', backgroundColor: theme.warning, alignItems: 'center', justifyContent: 'center' } }, h('view', { style: { color: '#ffffff', fontSize: '11', fontWeight: 'bold' } }, '!')),
        h('view', { style: { color: theme.text, fontSize: '14', flexGrow: '1' } }, title)),
      h('view', { style: { flexDirection: 'row', gap: '8', justifyContent: 'flex-end' } },
        NButton({ size: 'small', onClick: () => { onCancel && onCancel(); close(); } }, cancelText),
        NButton({ size: 'small', type: 'primary', onClick: () => { onConfirm && onConfirm(); close(); } }, confirmText)));
    pid = openPopup(pop, { x: r.left, y: r.bottom + 6, onClose: close });
  };
  return trigger;
}

// ---- NDrawer ----------------------------------------------------------------

export function NDrawer(props = {}, ...children) {
  const { show = false, placement = 'right', width = 320, title, onClose } = props;
  if (!show) return h('view', { style: { width: '0', height: '0' } });
  const panelStyle = clean({ position: 'absolute', top: 0, bottom: 0, width, height: '100%', backgroundColor: theme.card, flexDirection: 'column' });
  panelStyle[placement] = '0';
  const panel = h('view', { onClick: (e) => e.stopPropagation(), style: panelStyle },
    title ? h('view', { style: { paddingLeft: '20', paddingRight: '20', paddingTop: '16', paddingBottom: '16', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' } },
      h('view', { style: { color: theme.text, fontSize: '16', fontWeight: 'bold' } }, title),
      h('view', { style: { color: theme.textSecondary, fontSize: '16' }, onClick: onClose }, '✕')) : null,
    title ? h('view', { style: { height: '1', backgroundColor: theme.border } }) : null,
    h('view', { style: { padding: '20', gap: '12', flexDirection: 'column' } }, ...children));
  return h('view', { style: clean({ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', backgroundColor: '#00000080' }), onClick: onClose }, panel);
}

// ---- NTree ------------------------------------------------------------------

export function NTree(props = {}) {
  const { data = [], expandedKeys = [], selectedKeys = [], onExpand, onSelect, id } = props;
  const exp = new Set(expandedKeys), sel = new Set(selectedKeys);
  const rows = [];
  const walk = (nodes, depth) => nodes.forEach(node => {
    const hasKids = node.children && node.children.length;
    const open = exp.has(node.key), isSel = sel.has(node.key);
    rows.push(h('view', { style: clean({ flexDirection: 'row', alignItems: 'center', height: 32, paddingLeft: 8 + depth * 20, borderRadius: 3, backgroundColor: isSel ? theme.primary + '1f' : 'transparent' }) },
      hasKids
        ? h('view', { style: clean({ width: 18, height: 18, alignItems: 'center', justifyContent: 'center', rotate: open ? 90 : 0 }), onClick: () => onExpand && onExpand(open ? expandedKeys.filter(k => k !== node.key) : expandedKeys.concat(node.key)) },
            h('view', { style: { color: theme.textSecondary, fontSize: '11' } }, '▶'))
        : h('view', { style: { width: '18' } }),
      h('view', { style: { flexGrow: '1', paddingLeft: '4', flexDirection: 'row', alignItems: 'center' }, onClick: () => onSelect && onSelect([node.key]) },
        h('view', { style: clean({ color: isSel ? theme.primary : theme.text, fontSize: 14 }) }, node.label))));
    if (hasKids && open) walk(node.children, depth + 1);
  });
  walk(data, 0);
  return h('view', { id, style: { flexDirection: 'column', gap: '2', padding: '4' } }, ...rows);
}

// ---- NTransfer --------------------------------------------------------------

export function NTransfer(props = {}) {
  const { data = [], targetKeys = [], onChange, titles = ['Source', 'Target'], id } = props;
  const tgt = new Set(targetKeys);
  const panel = (title, items, onItem) => h('view', { style: clean({ width: 200, borderWidth: 1, borderColor: theme.border, borderRadius: 3, flexDirection: 'column', backgroundColor: theme.card }) },
    h('view', { style: { paddingLeft: '12', paddingTop: '8', paddingBottom: '8' } }, h('view', { style: { color: theme.text, fontSize: '13', fontWeight: 'bold' } }, `${title} (${items.length})`)),
    h('view', { style: { height: '1', backgroundColor: theme.border } }),
    h('view', { style: { flexDirection: 'column', padding: '4', gap: '2', height: '160' } },
      ...items.map(it => h('view', { style: { height: '30', paddingLeft: '8', justifyContent: 'center', borderRadius: '3' }, onClick: () => onItem(it.key) },
        h('view', { style: { color: theme.text, fontSize: '14' } }, it.label)))));
  return h('view', { id, style: { flexDirection: 'row', gap: '12', alignItems: 'center' } },
    panel(titles[0], data.filter(d => !tgt.has(d.key)), (k) => onChange && onChange(targetKeys.concat(k))),
    h('view', { style: { color: theme.textSecondary, fontSize: '16' } }, '⇄'),
    panel(titles[1], data.filter(d => tgt.has(d.key)), (k) => onChange && onChange(targetKeys.filter(x => x !== k))));
}

// ---- NCalendar (standalone month grid) --------------------------------------

export function NCalendar(props = {}) {
  const { value, onUpdate, view, onNav, id } = props;
  const v = view || { year: (value || new Date(2024, 0, 1)).getFullYear(), month: (value || new Date(2024, 0, 1)).getMonth() };
  return h('view', { id, style: clean({ width: 320, borderWidth: 1, borderColor: theme.border, borderRadius: 3, backgroundColor: theme.card }) },
    calendar(v, value, (d) => onUpdate && onUpdate(d), (delta) => onNav && onNav(delta)));
}

// ---- NUpload ----------------------------------------------------------------

export function NUpload(props = {}) {
  const { fileList = [], onTrigger, onRemove, id } = props;
  return h('view', { id, style: { flexDirection: 'column', gap: '10' } },
    h('view', { style: clean({ borderWidth: 1, borderColor: theme.border, borderRadius: 3, paddingTop: 24, paddingBottom: 24, alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: theme.name === 'dark' ? '#ffffff08' : '#fafafc' }), onClick: () => onTrigger && onTrigger() },
      h('view', { style: { color: theme.primary, fontSize: '26' } }, '⬆'),
      h('view', { style: { color: theme.text, fontSize: '14' } }, 'Click to upload'),
      h('view', { style: { color: theme.textSecondary, fontSize: '12' } }, 'or drag a file here')),
    ...fileList.map(f => h('view', { style: { flexDirection: 'row', alignItems: 'center', gap: '8', paddingLeft: '4', paddingTop: '4', paddingBottom: '4' } },
      h('view', { style: { color: theme.textSecondary, fontSize: '13' } }, '📄'),
      h('view', { style: { color: theme.text, fontSize: '13', flexGrow: '1' } }, f.name),
      h('view', { style: { color: theme.error, fontSize: '13' }, onClick: () => onRemove && onRemove(f) }, '✕'))));
}

// ---- NCascader (column drill-down) ------------------------------------------

export function NCascader(props = {}) {
  const { value = [], options = [], onUpdate, width = 220, placeholder = 'Select', id } = props;
  const labelFor = (path) => {
    let opts = options, labels = [];
    for (const k of path) { const o = opts.find(x => x.value === k); if (!o) break; labels.push(o.label); opts = o.children || []; }
    return labels.join(' / ');
  };
  const open = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    let pid, activePath = value.slice();
    const draw = () => {
      const cols = []; let opts = options;
      for (let level = 0; opts && opts.length; level++) {
        const selKey = activePath[level];
        cols.push(h('view', { style: clean({ width: 160, flexDirection: 'column', padding: 4, gap: 2 }) },
          ...opts.map(o => h('view', {
            style: clean({ height: 32, paddingLeft: 10, paddingRight: 8, borderRadius: 3, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: o.value === selKey ? theme.primary + '1f' : 'transparent' }),
            hoverStyle: { backgroundColor: o.value === selKey ? theme.primary + '2e' : theme.primary + '14' },
            onClick: () => {
              activePath = activePath.slice(0, level); activePath.push(o.value);
              if (o.children && o.children.length) _overlays.list = _overlays.list.slice();
              else { onUpdate && onUpdate(activePath.slice()); closePopup(pid); }
            },
          },
            h('view', { style: clean({ color: o.value === selKey ? theme.primary : theme.text, fontSize: 14 }) }, o.label),
            o.children && o.children.length ? h('view', { style: { color: theme.textSecondary, fontSize: '12' } }, '›') : null))));
        const sel = opts.find(x => x.value === selKey);
        if (sel && sel.children && sel.children.length) opts = sel.children; else break;
      }
      return h('view', { style: clean({ flexDirection: 'row', backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border, borderRadius: 3 }) }, ...cols);
    };
    pid = openPopup(draw, { x: r.left, y: r.bottom + 4, onClose: () => closePopup(pid) });
  };
  return h('view', { id, tabIndex: 0, style: clean({ width, height: 34, backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border, borderRadius: 3, paddingLeft: 12, paddingRight: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }), hoverStyle: ctrlHover(), focusStyle: ctrlFocus(), onClick: open },
    h('view', { style: clean({ color: value.length ? theme.text : theme.textDisabled, fontSize: 14 }) }, value.length ? labelFor(value) : placeholder),
    h('view', { style: { color: theme.textSecondary, fontSize: '12' } }, '▾'));
}

// ===== Wave 1: static layout / display ======================================

export function NDivider(props = {}, title) {
  const { vertical = false } = props;
  if (vertical) return h('view', { style: clean({ width: 1, height: 14, marginLeft: 8, marginRight: 8, backgroundColor: theme.border }) });
  if (title) return h('view', { id: props.id, style: { flexDirection: 'row', alignItems: 'center', gap: '12', paddingTop: '12', paddingBottom: '12' } },
    h('view', { style: { height: '1', backgroundColor: theme.border, flexGrow: '1' } }),
    h('view', { style: { color: theme.text, fontSize: '14', fontWeight: '500' } }, title),
    h('view', { style: { height: '1', backgroundColor: theme.border, flexGrow: '1' } }));
  return h('view', { id: props.id, style: { height: '1', backgroundColor: theme.border, marginTop: '8', marginBottom: '8' } });
}

export function NButtonGroup(props = {}, ...buttons) {
  return h('view', { id: props.id, style: { flexDirection: 'row', gap: '0' } }, ...buttons);
}

export function NFlex(props = {}, ...children) {
  const { vertical = false, gap = 12, align, justify, wrap = false } = props;
  return h('view', { id: props.id, style: clean({ flexDirection: vertical ? 'column' : 'row', gap, alignItems: align, justifyContent: justify, flexWrap: wrap ? 'wrap' : undefined }) }, ...children);
}

// items: [{ span, content }]; span is out of `cols`.
export function NGrid(props = {}) {
  const { cols = 24, items = [], id } = props;
  return h('view', { id, style: { flexDirection: 'row', flexWrap: 'wrap' } },
    ...items.map(it => h('view', { style: clean({ width: ((it.span / cols) * 100) + '%' }) }, it.content)));
}

export function NText(props = {}, content) {
  const { type, strong = false, italic = false, depth, fontSize = 14 } = props;
  const color = typeColor(type) || (depth === 3 ? theme.textDisabled : depth === 2 ? theme.textSecondary : theme.text);
  return h('view', { id: props.id, style: clean({ color, fontSize, fontWeight: strong ? 'bold' : 'normal', fontStyle: italic ? 'italic' : undefined }) }, content);
}

export function NTitle(props = {}, content) {
  const { level = 1 } = props;
  const sizes = { 1: 30, 2: 24, 3: 20, 4: 16, 5: 14, 6: 13 };
  return h('view', { id: props.id, style: clean({ color: theme.text, fontSize: sizes[level] || 24, fontWeight: 'bold' }) }, content);
}

export function NEmpty(props = {}, ...extra) {
  const { description = 'No Data' } = props;
  return h('view', { id: props.id, style: { flexDirection: 'column', alignItems: 'center', gap: '12', paddingTop: '28', paddingBottom: '28' } },
    h('view', { style: { fontSize: '40' } }, '📭'),
    h('view', { style: { color: theme.textSecondary, fontSize: '14' } }, description),
    ...extra);
}

const RESULT_ICON = { success: ['✓', '#18a058'], error: ['✕', '#d03050'], warning: ['!', '#f0a020'], info: ['i', '#2080f0'], '404': ['?', '#909399'] };
export function NResult(props = {}, ...actions) {
  const { status = 'info', title, description } = props;
  const [icon, baseColor] = RESULT_ICON[status] || RESULT_ICON.info;
  const color = typeColor(status) || baseColor;
  return h('view', { id: props.id, style: { flexDirection: 'column', alignItems: 'center', gap: '12', padding: '32' } },
    h('view', { style: clean({ width: 64, height: 64, borderRadius: 32, backgroundColor: color + '1f', alignItems: 'center', justifyContent: 'center' }) },
      h('view', { style: clean({ color, fontSize: 32, fontWeight: 'bold' }) }, icon)),
    title ? h('view', { style: { color: theme.text, fontSize: '20', fontWeight: 'bold' } }, title) : null,
    description ? h('view', { style: { color: theme.textSecondary, fontSize: '14' } }, description) : null,
    actions.length ? h('view', { style: { flexDirection: 'row', gap: '12', paddingTop: '8' } }, ...actions) : null);
}

export function NStatistic(props = {}) {
  const { label, value, prefix, suffix, id } = props;
  return h('view', { id, style: { flexDirection: 'column', gap: '6' } },
    label ? h('view', { style: { color: theme.textSecondary, fontSize: '14' } }, label) : null,
    h('view', { style: { flexDirection: 'row', alignItems: 'flex-end', gap: '3' } },
      prefix ? h('view', { style: { color: theme.textSecondary, fontSize: '16' } }, prefix) : null,
      h('view', { style: { color: theme.text, fontSize: '28', fontWeight: 'bold' } }, String(value)),
      suffix ? h('view', { style: { color: theme.textSecondary, fontSize: '16' } }, suffix) : null));
}

export function NListItem(props = {}, ...content) {
  return h('view', { id: props.id, style: { paddingLeft: '14', paddingRight: '14', paddingTop: '12', paddingBottom: '12', flexDirection: 'row', alignItems: 'center', gap: '12' } }, ...content);
}
export function NList(props = {}, ...items) {
  const { bordered = true, id } = props;
  const kids = [];
  items.forEach((it, i) => { kids.push(it); if (i < items.length - 1) kids.push(h('view', { style: { height: '1', backgroundColor: theme.border } })); });
  return h('view', { id, style: clean({ borderWidth: bordered ? 1 : 0, borderColor: theme.border, borderRadius: 3, backgroundColor: theme.card, flexDirection: 'column' }) }, ...kids);
}

// items: [{ label, value }]
export function NDescriptions(props = {}) {
  const { column = 2, items = [], title, id } = props;
  const rows = [];
  for (let i = 0; i < items.length; i += column) rows.push(items.slice(i, i + column));
  const labelBg = theme.name === 'dark' ? '#ffffff08' : '#fafafc';
  return h('view', { id, style: clean({ flexDirection: 'column', borderWidth: 1, borderColor: theme.border, borderRadius: 3, overflow: 'hidden' }) },
    title ? h('view', { style: { paddingLeft: '12', paddingTop: '10', paddingBottom: '10', color: theme.text, fontWeight: 'bold', fontSize: '15' } }, title) : null,
    title ? h('view', { style: { height: '1', backgroundColor: theme.border } }) : null,
    ...rows.map((row, ri) => h('view', { style: clean({ flexDirection: 'row', borderTopWidth: ri > 0 ? 0 : 0 }) },
      ...row.map(it => h('view', { style: { flexGrow: '1', flexDirection: 'row' } },
        h('view', { style: clean({ width: 110, backgroundColor: labelBg, paddingLeft: 12, paddingTop: 10, paddingBottom: 10 }) }, h('view', { style: { color: theme.textSecondary, fontSize: '14' } }, it.label)),
        h('view', { style: { flexGrow: '1', paddingLeft: '12', paddingTop: '10', paddingBottom: '10' } }, h('view', { style: { color: theme.text, fontSize: '14' } }, String(it.value))))))));
}

// items: [{ label, onClick? }]
export function NBreadcrumb(props = {}) {
  const { items = [], separator = '/', id } = props;
  const kids = [];
  items.forEach((it, i) => {
    if (i > 0) kids.push(h('view', { style: { color: theme.textDisabled, fontSize: '14' } }, separator));
    const last = i === items.length - 1;
    kids.push(h('view', { style: clean({ color: last ? theme.text : theme.textSecondary, fontSize: 14 }), onClick: it.onClick }, it.label));
  });
  return h('view', { id, style: { flexDirection: 'row', alignItems: 'center', gap: '8' } }, ...kids);
}

// items: [{ title, content?, time?, type? }]
export function NTimeline(props = {}) {
  const { items = [], id } = props;
  return h('view', { id, style: { flexDirection: 'column' } }, ...items.map((it, i) => {
    const color = typeColor(it.type) || theme.primary;
    return h('view', { style: { flexDirection: 'row', gap: '12' } },
      h('view', { style: { flexDirection: 'column', alignItems: 'center', width: '14' } },
        h('view', { style: clean({ width: 12, height: 12, borderRadius: 6, backgroundColor: 'transparent', borderWidth: 2, borderColor: color }) }),
        i < items.length - 1 ? h('view', { style: { width: '2', flexGrow: '1', minHeight: '24', backgroundColor: theme.border } }) : null),
      h('view', { style: { flexDirection: 'column', gap: '2', paddingBottom: '20', flexGrow: '1' } },
        h('view', { style: { color: theme.text, fontSize: '14', fontWeight: '500' } }, it.title),
        it.content ? h('view', { style: { color: theme.textSecondary, fontSize: '13' } }, it.content) : null,
        it.time ? h('view', { style: { color: theme.textDisabled, fontSize: '12' } }, it.time) : null));
  }));
}

// ===== Wave 2: data entry + simple display ==================================

export function NInputNumber(props = {}) {
  const { value = 0, onUpdate, min = -Infinity, max = Infinity, step = 1, width = 120, id } = props;
  const set = (v) => onUpdate && onUpdate(Math.max(min, Math.min(max, v)));
  const btn = (label, delta) => h('view', { style: clean({ width: 30, height: '100%', alignItems: 'center', justifyContent: 'center', backgroundColor: theme.name === 'dark' ? '#ffffff08' : '#fafafc' }), onClick: () => set(value + delta) }, h('view', { style: { color: theme.text, fontSize: '16' } }, label));
  return h('view', { id, style: clean({ width, height: 34, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: theme.border, borderRadius: 3, overflow: 'hidden', backgroundColor: theme.card }) },
    btn('−', -step),
    h('view', { style: { flexGrow: '1', alignItems: 'center', justifyContent: 'center' } }, h('view', { style: { color: theme.text, fontSize: '14' } }, String(value))),
    btn('+', step));
}

export function NRate(props = {}) {
  const { value = 0, onUpdate, count = 5, id } = props;
  return h('view', { id, style: { flexDirection: 'row', gap: '4' } }, ...Array.from({ length: count }, (_, i) => {
    const on = i < value;
    return h('view', { style: clean({ fontSize: 20, color: on ? theme.warning : theme.railOff }), onClick: () => onUpdate && onUpdate(i + 1) }, on ? '★' : '☆');
  }));
}

export function NDynamicTags(props = {}) {
  const { value = [], onChange, onAdd, id } = props;
  return h('view', { id, style: { flexDirection: 'row', gap: '8', flexWrap: 'wrap', alignItems: 'center' } },
    ...value.map((t, i) => h('view', { style: clean({ height: 24, paddingLeft: 9, paddingRight: 6, borderRadius: 2, backgroundColor: theme.name === 'dark' ? '#ffffff14' : '#fafafc', borderWidth: 1, borderColor: theme.border, flexDirection: 'row', alignItems: 'center', gap: 6 }) },
      h('view', { style: { color: theme.text, fontSize: '13' } }, t),
      h('view', { style: { color: theme.textSecondary, fontSize: '12' }, onClick: () => onChange && onChange(value.filter((_, j) => j !== i)) }, '✕'))),
    h('view', { style: clean({ height: 24, paddingLeft: 9, paddingRight: 9, borderRadius: 2, borderWidth: 1, borderColor: theme.border, flexDirection: 'row', alignItems: 'center' }), onClick: () => onAdd && onAdd() },
      h('view', { style: { color: theme.textSecondary, fontSize: '13' } }, '+ Add')));
}

export function NDynamicInput(props = {}) {
  const { value = [], onChange, id } = props;
  return h('view', { id, style: { flexDirection: 'column', gap: '8' } },
    ...value.map((v, i) => h('view', { style: { flexDirection: 'row', gap: '8', alignItems: 'center' } },
      h('view', { tabIndex: 0, style: clean({ flexGrow: 1, height: 34, borderWidth: 1, borderColor: theme.border, borderRadius: 3, paddingLeft: 12, justifyContent: 'center', backgroundColor: theme.card, overflow: 'hidden' }),
        onKeydown: (e) => { if (e.key !== 'Backspace') return; const nv = value.slice(); nv[i] = removeLastCodePoint(v); onChange && onChange(nv); },
        onTextinput: (e) => { const nv = value.slice(); nv[i] = v + e.data; onChange && onChange(nv); } },
        h('view', { style: { color: theme.text, fontSize: '14' } }, v || '')),
      h('view', { style: { color: theme.error, fontSize: '14' }, onClick: () => onChange && onChange(value.filter((_, j) => j !== i)) }, '✕'))),
    h('view', { style: clean({ height: 32, borderWidth: 1, borderColor: theme.border, borderRadius: 3, alignItems: 'center', justifyContent: 'center' }), onClick: () => onChange && onChange(value.concat('')) },
      h('view', { style: { color: theme.textSecondary, fontSize: '14' } }, '+ Add')));
}

export function NAvatarGroup(props = {}, ...avatars) {
  const { size = 36, max = 99 } = props;
  const shown = avatars.slice(0, max), extra = avatars.length - shown.length;
  return h('view', { id: props.id, style: { flexDirection: 'row' } },
    ...shown.map((av, i) => h('view', { style: clean({ marginLeft: i === 0 ? 0 : -(size / 3), borderWidth: 2, borderColor: theme.card, borderRadius: size / 2 }) }, av)),
    extra > 0 ? h('view', { style: clean({ marginLeft: -(size / 3), width: size, height: size, borderRadius: size / 2, backgroundColor: theme.railOff, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: theme.card }) }, h('view', { style: { color: theme.text, fontSize: '12' } }, '+' + extra)) : null);
}

export function NTime(props = {}) {
  const { time = new Date(2024, 0, 1), type = 'datetime', id } = props;
  const d = time instanceof Date ? time : new Date(time);
  const fmt = type === 'date' ? formatDate(d)
    : type === 'time' ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
    : `${formatDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return h('view', { id, style: clean({ color: theme.text, fontSize: 14 }) }, fmt);
}

export function NEllipsis(props = {}, text) {
  const { width = 160, fontSize = 14, id } = props;
  text = String(text);
  let display = text;
  if (measureText(text, fontSize) > width) {
    let lo = 0, hi = text.length;
    while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (measureText(text.slice(0, mid) + '…', fontSize) <= width) lo = mid; else hi = mid - 1; }
    display = text.slice(0, lo) + '…';
  }
  return h('view', { id, style: clean({ width, overflow: 'hidden' }) }, h('view', { style: clean({ color: theme.text, fontSize }) }, display));
}

export function NThing(props = {}, ...content) {
  const { title, description, avatar, id } = props;
  return h('view', { id, style: { flexDirection: 'row', gap: '12' } },
    avatar ? h('view', {}, avatar) : null,
    h('view', { style: { flexDirection: 'column', gap: '4', flexGrow: '1' } },
      title ? h('view', { style: { color: theme.text, fontSize: '15', fontWeight: 'bold' } }, title) : null,
      description ? h('view', { style: { color: theme.textSecondary, fontSize: '13' } }, description) : null,
      ...content));
}

export function NImage(props = {}) {
  const { src, width = 120, height = 120, round = false, id } = props;
  return h('view', { id, style: clean({ width, height, borderRadius: round ? height / 2 : 6, backgroundColor: theme.railOff, backgroundImage: src, overflow: 'hidden' }) });
}

// ===== Wave 3: popovers, navigation, feedback ===============================

export function NPopover(props = {}, trigger) {
  const { content, trigger: mode = 'click', width } = props;
  trigger.props = trigger.props || {};
  const open = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    let pid;
    const pop = () => h('view', { style: clean({ width, backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border, borderRadius: 6, padding: 14, shadowColor: '#0000002e', shadowBlur: 16, shadowY: 4 }) },
      (content && typeof content === 'object') ? content : h('view', { style: { color: theme.text, fontSize: '14' } }, content));
    pid = openPopup(pop, { x: r.left, y: r.bottom + 8, backdrop: mode === 'click', onClose: () => closePopup(pid) });
    e.currentTarget.__pop = pid;
  };
  if (mode === 'hover') {
    trigger.props.onMouseenter = open;
    trigger.props.onMouseleave = (e) => { if (e.currentTarget.__pop) { closePopup(e.currentTarget.__pop); e.currentTarget.__pop = 0; } };
  } else {
    trigger.props.onClick = open;
  }
  return trigger;
}

export function NPopselect(props = {}, trigger) {
  const { value, options = [], onUpdate, width = 160 } = props;
  trigger.props = trigger.props || {};
  trigger.props.onClick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    let pid;
    const menu = () => h('view', { style: clean({ width, backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border, borderRadius: 3, padding: 4, gap: 2 }) },
      ...options.map(o => h('view', { style: clean({ height: 32, paddingLeft: 10, borderRadius: 3, justifyContent: 'center', backgroundColor: o.value === value ? theme.primary + '1f' : 'transparent' }), hoverStyle: { backgroundColor: o.value === value ? theme.primary + '2e' : theme.primary + '14' }, onClick: () => { onUpdate && onUpdate(o.value); closePopup(pid); } },
        h('view', { style: clean({ color: o.value === value ? theme.primary : theme.text, fontSize: 14 }) }, o.label))));
    pid = openPopup(menu, { x: r.left, y: r.bottom + 4, onClose: () => closePopup(pid) });
  };
  return trigger;
}

export function NBackTop(props = {}) {
  const { onClick, visible = true, id } = props;
  if (!visible) return h('view', { style: { width: '0', height: '0' } });
  return h('view', { id, style: clean({ position: 'absolute', right: 40, bottom: 40, width: 40, height: 40, borderRadius: 20, backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border, alignItems: 'center', justifyContent: 'center', shadowColor: '#0000002e', shadowBlur: 12, shadowY: 2 }), onClick },
    h('view', { style: { color: theme.textSecondary, fontSize: '16' } }, '↑'));
}

export function NAnchor(props = {}) {
  const { links = [], active, onSelect, id } = props;
  return h('view', { id, style: { flexDirection: 'column', gap: '4', paddingLeft: '12' } },
    ...links.map(l => {
      const on = l.key === active;
      return h('view', { style: { paddingTop: '6', paddingBottom: '6' }, onClick: () => onSelect && onSelect(l.key) },
        h('view', { style: clean({ color: on ? theme.primary : theme.textSecondary, fontSize: 14, fontWeight: on ? 500 : 400 }) }, l.label));
    }));
}

export function NAffix(props = {}, child) {
  const { affixed = false, id } = props;
  return h('view', { id, style: affixed ? clean({ position: 'absolute', top: 0, left: 0, right: 0, backgroundColor: theme.body, shadowColor: '#0000001f', shadowBlur: 8, shadowY: 2 }) : {} }, child);
}

// ---- notification (stacked toast cards) ----
let _notifyY = 0;
export const notification = {
  _show(type, opts) {
    const o = typeof opts === 'string' ? { content: opts } : (opts || {});
    const { title, content, duration = 4500 } = o;
    const color = typeColor(type) || theme.info;
    let id;
    const card = () => h('view', { style: clean({ width: 340, backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border, borderRadius: 6, padding: 16, gap: 6, flexDirection: 'column', shadowColor: '#0000002e', shadowBlur: 20, shadowY: 6 }) },
      h('view', { style: { flexDirection: 'row', gap: '8', alignItems: 'center' } },
        h('view', { style: clean({ width: 8, height: 8, borderRadius: 4, backgroundColor: color }) }),
        h('view', { style: { color: theme.text, fontSize: '15', fontWeight: 'bold', flexGrow: '1' } }, title || ''),
        h('view', { style: { color: theme.textSecondary, fontSize: '14' }, onClick: () => closePopup(id) }, '✕')),
      content ? h('view', { style: { color: theme.textSecondary, fontSize: '14' } }, content) : null);
    const myY = 24 + _notifyY;
    _notifyY += 96;
    id = openPopup(card, { x: 440, y: myY, backdrop: false });
    if (duration > 0) setTimeout(() => { closePopup(id); _notifyY = Math.max(0, _notifyY - 96); }, duration);
    return id;
  },
  info(o) { return this._show('info', o); }, success(o) { return this._show('success', o); },
  warning(o) { return this._show('warning', o); }, error(o) { return this._show('error', o); },
};

// ---- loadingBar (thin top progress bar) ----
let _lbWidth = 0, _lbId = 0, _lbTimer = null;
export const loadingBar = {
  start() {
    if (_lbTimer) clearInterval(_lbTimer);
    _lbWidth = 15;
    if (!_lbId) _lbId = openPopup(() => h('view', { style: clean({ width: '100%', height: 3 }) }, h('view', { style: clean({ width: _lbWidth + '%', height: 3, backgroundColor: theme.primary }) })), { x: 0, y: 0, backdrop: false, fullWidth: true });
    else _overlays.list = _overlays.list.slice();
    _lbTimer = setInterval(() => { _lbWidth = Math.min(90, _lbWidth + 12); _overlays.list = _overlays.list.slice(); }, 120);
  },
  finish() {
    if (_lbTimer) { clearInterval(_lbTimer); _lbTimer = null; }
    _lbWidth = 100; _overlays.list = _overlays.list.slice();
    const id = _lbId;
    setTimeout(() => { closePopup(id); if (_lbId === id) _lbId = 0; }, 300);
  },
  error() { this.finish(); },
};

// ---- dialog (preset confirm / alert modals) ---------------------------------
// dialog.warning({ title, content, positiveText, negativeText, onPositiveClick,
//   onNegativeClick, maskClosable }). Handlers may return false to keep it open.
const _dialogIcon = { info: 'i', success: '✓', warning: '!', error: '✕' };
export const dialog = {
  _show(type, opts) {
    const o = opts || {};
    const { title, content, positiveText = 'OK', negativeText, onPositiveClick, onNegativeClick, onClose, maskClosable = true, positiveId, negativeId } = o;
    const color = typeColor(type) || theme.primary;
    let id;
    const close = () => closePopup(id);
    const render = () => h('view', {
        style: clean({ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', backgroundColor: '#00000080', alignItems: 'center', justifyContent: 'center' }),
        onClick: () => { if (maskClosable) { if (onClose) onClose(); close(); } },
      },
      h('view', { onClick: (e) => e.stopPropagation(),
          style: clean({ width: 446, backgroundColor: theme.card, borderRadius: 8, padding: 24, flexDirection: 'column', gap: 16, shadowColor: '#00000040', shadowBlur: 28, shadowY: 10 }) },
        h('view', { style: { flexDirection: 'row', gap: '12', alignItems: 'center' } },
          type ? h('view', { style: clean({ width: 24, height: 24, borderRadius: 12, backgroundColor: color, alignItems: 'center', justifyContent: 'center' }) },
            h('view', { style: clean({ color: theme.solidText, fontSize: 15, fontWeight: 'bold' }) }, _dialogIcon[type] || '!')) : null,
          h('view', { style: { color: theme.text, fontSize: '16', fontWeight: 'bold', flexGrow: '1' } }, title || '')),
        content ? h('view', { style: { color: theme.textSecondary, fontSize: '14', lineHeight: '20' } }, content) : null,
        h('view', { style: { flexDirection: 'row', gap: '10', justifyContent: 'flex-end' } },
          negativeText ? NButton({ id: negativeId, onClick: () => { const r = onNegativeClick && onNegativeClick(); if (r !== false) close(); } }, negativeText) : null,
          NButton({ id: positiveId, type: type === 'error' ? 'error' : 'primary', onClick: () => { const r = onPositiveClick && onPositiveClick(); if (r !== false) close(); } }, positiveText))));
    id = openPopup(render, { x: 0, y: 0, fullScreen: true, backdrop: false });
    return { destroy: close };
  },
  info(o) { return this._show('info', o); }, success(o) { return this._show('success', o); },
  warning(o) { return this._show('warning', o); }, error(o) { return this._show('error', o); },
  create(o) { return this._show((o && o.type) || null, o); },
};

// ===== Wave 4: animated display + layout ====================================

export function NCountdown(props = {}) {
  const { value = 0, format = 'MM:SS', fontSize = 24, id } = props;
  const total = Math.max(0, Math.floor(value / 1000));
  const hh = Math.floor(total / 3600), mm = Math.floor((total % 3600) / 60), ss = total % 60;
  const disp = format === 'HH:MM:SS' ? `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}` : `${pad2(mm)}:${pad2(ss)}`;
  return h('view', { id, style: clean({ color: theme.text, fontSize, fontWeight: 'bold' }) }, disp);
}

export function NNumberAnimation(props = {}) {
  const { value = 0, precision = 0, prefix = '', suffix = '', fontSize = 28, id } = props;
  const n = Number(value).toFixed(precision);
  const parts = n.split('.');
  const grouped = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return h('view', { id, style: clean({ color: theme.text, fontSize, fontWeight: 'bold' }) }, prefix + grouped + (parts[1] ? '.' + parts[1] : '') + suffix);
}

export function NSkeleton(props = {}) {
  const { rows = 3, width, height = 16, round = false, text = true, id } = props;
  const bg = theme.name === 'dark' ? '#ffffff14' : '#eef0f2';
  if (!text) return h('view', { id, style: clean({ width: width || 40, height, borderRadius: round ? height / 2 : 4, backgroundColor: bg }) });
  return h('view', { id, style: { flexDirection: 'column', gap: '10' } }, ...Array.from({ length: rows }, (_, i) =>
    h('view', { style: clean({ height, borderRadius: 4, width: i === rows - 1 ? '60%' : '100%', backgroundColor: bg }) })));
}

export function NCarousel(props = {}) {
  const { index = 0, slides = [], onUpdate, height = 200, id } = props;
  return h('view', { id, style: clean({ height, borderRadius: 6, overflow: 'hidden', position: 'relative', backgroundColor: theme.railOff }) },
    slides[index] || null,
    h('view', { style: { position: 'absolute', bottom: '12', left: '0', right: '0', flexDirection: 'row', justifyContent: 'center', gap: '8' } },
      ...slides.map((_, i) => h('view', { style: clean({ width: i === index ? 18 : 8, height: 8, borderRadius: 4, backgroundColor: i === index ? '#ffffff' : '#ffffff80' }), onClick: () => onUpdate && onUpdate(i) }))));
}

export function NWatermark(props = {}, child) {
  const { content = 'PollyUI', rows = 5, cols = 4, id } = props;
  const marks = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++)
    marks.push(h('view', { style: clean({ position: 'absolute', left: c * 160, top: r * 100, rotate: -20, opacity: 0.08 }) }, h('view', { style: { color: theme.text, fontSize: '16' } }, content)));
  return h('view', { id, style: { position: 'relative' } }, child, ...marks);
}

export function NLayout(props = {}, ...children) {
  const { hasSider = false, id } = props;
  return h('view', { id, style: clean({ flexDirection: hasSider ? 'row' : 'column', flexGrow: 1, backgroundColor: theme.body }) }, ...children);
}
export function NLayoutHeader(props = {}, ...children) {
  return h('view', { id: props.id, style: clean({ height: props.height || 64, backgroundColor: theme.card, flexDirection: 'row', alignItems: 'center', paddingLeft: 20, paddingRight: 20 }) }, ...children);
}
export function NLayoutSider(props = {}, ...children) {
  return h('view', { id: props.id, style: clean({ width: props.width || 200, backgroundColor: theme.card, padding: 12, flexDirection: 'column' }) }, ...children);
}
export function NLayoutContent(props = {}, ...children) {
  return h('view', { id: props.id, style: clean({ flexGrow: 1, padding: props.padding != null ? props.padding : 24 }) }, ...children);
}
export function NLayoutFooter(props = {}, ...children) {
  return h('view', { id: props.id, style: clean({ backgroundColor: theme.card, padding: 16, alignItems: 'center' }) }, ...children);
}

// Pass children as a function so they're built AFTER the theme is applied
// (h() evaluates eager args before the call, so a plain child would use the
// previous theme): NConfigProvider({ theme: 'dark' }, () => NButton(...)).
export function NConfigProvider(props = {}, content) {
  if (props.theme) useTheme(props.theme);
  const built = typeof content === 'function' ? content() : content;
  const kids = Array.isArray(built) ? built : [built];
  return h('view', { id: props.id, style: { flexGrow: '1' } }, ...kids);
}

export function NIcon(props = {}, glyph) {
  const { size = 18, color, id } = props;
  return h('view', { id, style: clean({ fontSize: size, color: color || theme.text }) }, glyph);
}

// ===== Wave 5a: custom scroll (wheel deltaY) ================================

export function NScrollbar(props = {}, content) {
  const { height = 200, width, scrollTop = 0, contentHeight = 0, onScroll, id } = props;
  const maxS = Math.max(0, contentHeight - height);
  const st = Math.max(0, Math.min(maxS, scrollTop));
  const thumbH = contentHeight > height ? Math.max(20, (height / contentHeight) * height) : 0;
  const thumbTop = maxS > 0 ? (st / maxS) * (height - thumbH) : 0;
  return h('view', { id, style: clean({ height, width, position: 'relative', overflow: 'hidden' }),
    onWheel: (e) => { if (onScroll) onScroll(Math.max(0, Math.min(maxS, st + e.deltaY))); } },
    h('view', { style: clean({ position: 'absolute', top: -st, left: 0, right: 0 }) }, content),
    thumbH > 0 ? h('view', { style: clean({ position: 'absolute', right: 2, top: thumbTop, width: 6, height: thumbH, borderRadius: 3, backgroundColor: theme.name === 'dark' ? '#ffffff33' : '#00000026' }) }) : null);
}

export function NVirtualList(props = {}) {
  const { items = [], itemHeight = 34, height = 300, width, scrollTop = 0, onScroll, renderItem, id } = props;
  const total = items.length * itemHeight;
  const maxS = Math.max(0, total - height);
  const st = Math.max(0, Math.min(maxS, scrollTop));
  const start = Math.max(0, Math.floor(st / itemHeight) - 2);
  const end = Math.min(items.length, Math.ceil((st + height) / itemHeight) + 2);
  const vis = [];
  for (let i = start; i < end; i++) vis.push(h('view', { key: i, style: clean({ position: 'absolute', top: i * itemHeight, left: 0, right: 0, height: itemHeight, paddingLeft: 10, justifyContent: 'center' }) }, renderItem(items[i], i)));
  return h('view', { id, style: clean({ height, width, position: 'relative', overflow: 'hidden' }),
    onWheel: (e) => { if (onScroll) onScroll(Math.max(0, Math.min(maxS, st + e.deltaY))); } },
    h('view', { style: clean({ position: 'absolute', top: -st, left: 0, right: 0, height: total }) }, ...vis),
    maxS > 0 ? h('view', { style: clean({ position: 'absolute', right: 2, top: (st / maxS) * (height - Math.max(20, height / total * height)), width: 6, height: Math.max(20, height / total * height), borderRadius: 3, backgroundColor: theme.name === 'dark' ? '#ffffff33' : '#00000026' }) }) : null);
}

// ===== Wave 5b: popover-driven inputs =======================================

export function NTimePicker(props = {}) {
  const { value, onUpdate, width = 150, id } = props;
  const cur0 = value || { h: 0, m: 0, s: 0 };
  const disp = `${pad2(cur0.h)}:${pad2(cur0.m)}:${pad2(cur0.s)}`;
  const open = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    let pid, cur = { ...cur0 };
    const col = (unit, count) => h('view', { style: clean({ width: 48, height: 200, overflow: 'scroll' }) },
      h('view', { style: { flexDirection: 'column' } }, ...Array.from({ length: count }, (_, n) =>
        h('view', { style: clean({ height: 30, alignItems: 'center', justifyContent: 'center', borderRadius: 3, backgroundColor: cur[unit] === n ? theme.primary + '1f' : 'transparent' }), onClick: () => { cur = { ...cur, [unit]: n }; onUpdate && onUpdate(cur); _overlays.list = _overlays.list.slice(); } },
          h('view', { style: clean({ color: cur[unit] === n ? theme.primary : theme.text, fontSize: 14 }) }, pad2(n))))));
    const panel = () => h('view', { style: clean({ flexDirection: 'row', backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border, borderRadius: 3 }) }, col('h', 24), col('m', 60), col('s', 60));
    pid = openPopup(panel, { x: r.left, y: r.bottom + 4, onClose: () => closePopup(pid) });
  };
  return h('view', { id, tabIndex: 0, style: clean({ width, height: 34, backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border, borderRadius: 3, paddingLeft: 12, flexDirection: 'row', alignItems: 'center' }), hoverStyle: ctrlHover(), focusStyle: ctrlFocus(), onClick: open },
    h('view', { style: { color: value ? theme.text : theme.textDisabled, fontSize: '14' } }, value ? disp : 'Select time'));
}

export function NTreeSelect(props = {}) {
  const { value, options = [], onUpdate, width = 220, id } = props;
  const labelFor = (key) => { let f = null; const walk = (ns) => ns.forEach(n => { if (n.key === key) f = n.label; if (n.children) walk(n.children); }); walk(options); return f; };
  const open = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    let pid, exp = [];
    const draw = () => h('view', { style: clean({ width, backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border, borderRadius: 3, maxHeight: 260, overflow: 'scroll' }) },
      NTree({ data: options, expandedKeys: exp, selectedKeys: value ? [value] : [],
        onExpand: e2 => { exp = e2; _overlays.list = _overlays.list.slice(); },
        onSelect: s => { onUpdate && onUpdate(s[0]); closePopup(pid); } }));
    pid = openPopup(draw, { x: r.left, y: r.bottom + 4, onClose: () => closePopup(pid) });
  };
  return h('view', { id, tabIndex: 0, style: clean({ width, height: 34, backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border, borderRadius: 3, paddingLeft: 12, paddingRight: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }), hoverStyle: ctrlHover(), focusStyle: ctrlFocus(), onClick: open },
    h('view', { style: clean({ color: value ? theme.text : theme.textDisabled, fontSize: 14 }) }, value ? labelFor(value) : 'Select'),
    h('view', { style: { color: theme.textSecondary, fontSize: '12' } }, '▾'));
}

let _acLive = null;
export function NAutoComplete(props = {}) {
  const { value = '', options = [], onInput, onSelect, width = 240, placeholder = '', id } = props;
  _acLive = { value, options, onInput, onSelect, width };
  const open = (e) => {
    const inputNode = e.currentTarget;
    if (inputNode.__ac) return;
    const r = inputNode.getBoundingClientRect();
    let pid;
    const menu = () => {
      const st = _acLive; if (!st) return h('view', { style: { width: '0', height: '0' } });
      const f = st.options.filter(o => { const s = typeof o === 'string' ? o : o.label; return st.value && s.toLowerCase().indexOf(st.value.toLowerCase()) >= 0; });
      if (!f.length) return h('view', { style: { width: '0', height: '0' } });
      return h('view', { style: clean({ width: st.width, backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border, borderRadius: 3, padding: 4, gap: 2 }) },
        ...f.map(o => { const lbl = typeof o === 'string' ? o : o.label; const val = typeof o === 'string' ? o : o.value;
          return h('view', { style: clean({ height: 32, paddingLeft: 10, borderRadius: 3, justifyContent: 'center' }), onClick: () => { st.onSelect && st.onSelect(val); st.onInput && st.onInput(lbl); closePopup(pid); inputNode.__ac = 0; } }, h('view', { style: { color: theme.text, fontSize: '14' } }, lbl)); }));
    };
    pid = openPopup(menu, { x: r.left, y: r.bottom + 4, backdrop: false, onClose: () => { closePopup(pid); inputNode.__ac = 0; } });
    inputNode.__ac = pid;
  };
  return h('view', { id, tabIndex: 0, style: clean({ width, height: 34, backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border, borderRadius: 3, paddingLeft: 12, paddingRight: 12, justifyContent: 'center', overflow: 'hidden' }), hoverStyle: ctrlHover(), focusStyle: ctrlFocus(),
    onClick: open,
    onKeydown: (e) => { if (e.key !== 'Backspace') return; onInput && onInput(removeLastCodePoint(value)); if (!e.currentTarget.__ac) open(e); },
    onTextinput: (e) => { onInput && onInput(value + e.data); if (!e.currentTarget.__ac) open(e); } },
    h('view', { style: { color: value ? theme.text : theme.textDisabled, fontSize: '14' } }, value || placeholder));
}

let _mLive = null;
export function NMention(props = {}) {
  const { value = '', options = [], onInput, width = 280, id } = props;
  _mLive = { value, options, onInput, width };
  const open = (e) => {
    const inputNode = e.currentTarget;
    if (inputNode.__m) return;
    const r = inputNode.getBoundingClientRect();
    let pid;
    const menu = () => {
      const st = _mLive; const at = st.value.lastIndexOf('@');
      if (at < 0) return h('view', { style: { width: '0', height: '0' } });
      const q = st.value.slice(at + 1).toLowerCase();
      const f = st.options.filter(o => { const s = typeof o === 'string' ? o : o.value; return s.toLowerCase().indexOf(q) >= 0; });
      if (!f.length) return h('view', { style: { width: '0', height: '0' } });
      return h('view', { style: clean({ width: 180, backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border, borderRadius: 3, padding: 4, gap: 2 }) },
        ...f.map(o => { const s = typeof o === 'string' ? o : o.value;
          return h('view', { style: clean({ height: 30, paddingLeft: 10, borderRadius: 3, justifyContent: 'center' }), onClick: () => { const nv = st.value.slice(0, at) + '@' + s + ' '; st.onInput && st.onInput(nv); closePopup(pid); inputNode.__m = 0; } }, h('view', { style: { color: theme.text, fontSize: '14' } }, '@' + s)); }));
    };
    pid = openPopup(menu, { x: r.left, y: r.bottom + 4, backdrop: false, onClose: () => { closePopup(pid); inputNode.__m = 0; } });
    inputNode.__m = pid;
  };
  return h('view', { id, tabIndex: 0, style: clean({ width, height: 34, backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border, borderRadius: 3, paddingLeft: 12, paddingRight: 12, justifyContent: 'center', overflow: 'hidden' }), hoverStyle: ctrlHover(), focusStyle: ctrlFocus(),
    onKeydown: (e) => { if (e.key !== 'Backspace') return; const nv = removeLastCodePoint(value); onInput && onInput(nv); if (nv.indexOf('@') >= 0 && !e.currentTarget.__m) open(e); },
    onTextinput: (e) => { const nv = value + e.data; onInput && onInput(nv); if (nv.indexOf('@') >= 0 && !e.currentTarget.__m) open(e); } },
    h('view', { style: { color: value ? theme.text : theme.textDisabled, fontSize: '14' } }, value || 'Type @ to mention'));
}

function hsvToHex(hh, s, v) {
  hh = ((hh % 360) + 360) % 360;
  const c = v * s, x = c * (1 - Math.abs((hh / 60) % 2 - 1)), m = v - c;
  let r, g, b;
  if (hh < 60) { r = c; g = x; b = 0; } else if (hh < 120) { r = x; g = c; b = 0; }
  else if (hh < 180) { r = 0; g = c; b = x; } else if (hh < 240) { r = 0; g = x; b = c; }
  else if (hh < 300) { r = x; g = 0; b = c; } else { r = c; g = 0; b = x; }
  const to = (n) => ('0' + Math.round((n + m) * 255).toString(16)).slice(-2);
  return '#' + to(r) + to(g) + to(b);
}

export function NColorPicker(props = {}) {
  const { value = '#2080f0', onUpdate, width = 200, id } = props;
  const open = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    let pid, hue = 210, sat = 0.85, val = 0.94;
    const apply = () => onUpdate && onUpdate(hsvToHex(hue, sat, val));
    const SVW = 180, SVH = 120, HUEW = 180;
    const hueSegs = [['#ff0000', '#ffff00'], ['#ffff00', '#00ff00'], ['#00ff00', '#00ffff'], ['#00ffff', '#0000ff'], ['#0000ff', '#ff00ff'], ['#ff00ff', '#ff0000']];
    const draw = () => h('view', { style: clean({ width: 200, backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border, borderRadius: 6, padding: 10, gap: 10, shadowColor: '#0000002e', shadowBlur: 16, shadowY: 4 }) },
      h('view', { style: clean({ width: SVW, height: SVH, position: 'relative', borderRadius: 3, overflow: 'hidden', backgroundColor: hsvToHex(hue, 1, 1) }),
        onMousedown: (e2) => { const rr = e2.currentTarget.getBoundingClientRect(); sat = Math.max(0, Math.min(1, (e2.clientX - rr.left) / SVW)); val = Math.max(0, Math.min(1, 1 - (e2.clientY - rr.top) / SVH)); apply(); _overlays.list = _overlays.list.slice(); } },
        h('view', { style: clean({ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', gradientFrom: '#ffffffff', gradientTo: '#ffffff00', gradientDir: 'horizontal' }) }),
        h('view', { style: clean({ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', gradientFrom: '#00000000', gradientTo: '#000000ff' }) })),
      h('view', { style: clean({ width: HUEW, height: 14, flexDirection: 'row', borderRadius: 3, overflow: 'hidden' }),
        onMousedown: (e2) => { const rr = e2.currentTarget.getBoundingClientRect(); hue = Math.max(0, Math.min(359, ((e2.clientX - rr.left) / HUEW) * 360)); apply(); _overlays.list = _overlays.list.slice(); } },
        ...hueSegs.map(([a, b]) => h('view', { style: clean({ flexGrow: 1, height: 14, gradientFrom: a, gradientTo: b, gradientDir: 'horizontal' }) }))),
      h('view', { style: { flexDirection: 'row', alignItems: 'center', gap: '8' } },
        h('view', { style: clean({ width: 24, height: 24, borderRadius: 3, backgroundColor: hsvToHex(hue, sat, val), borderWidth: 1, borderColor: theme.border }) }),
        h('view', { style: { color: theme.text, fontSize: '13' } }, hsvToHex(hue, sat, val))));
    pid = openPopup(draw, { x: r.left, y: r.bottom + 4, onClose: () => closePopup(pid) });
  };
  return h('view', { id, tabIndex: 0, style: clean({ width, height: 34, backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border, borderRadius: 3, paddingLeft: 12, flexDirection: 'row', alignItems: 'center', gap: 8 }), hoverStyle: ctrlHover(), focusStyle: ctrlFocus(), onClick: open },
    h('view', { style: clean({ width: 18, height: 18, borderRadius: 3, backgroundColor: value, borderWidth: 1, borderColor: theme.border }) }),
    h('view', { style: { color: theme.text, fontSize: '14' } }, value));
}

// ===== Wave 6: native font-family + gradient text ===========================

export function NCode(props = {}, code) {
  const { inline = false, fontSize = 13, id } = props;
  const bg = theme.name === 'dark' ? '#ffffff0d' : '#f5f5f7';
  return h('view', { id, style: clean({ backgroundColor: bg, borderWidth: 1, borderColor: theme.border, borderRadius: 4, paddingLeft: inline ? 6 : 14, paddingRight: inline ? 6 : 14, paddingTop: inline ? 2 : 12, paddingBottom: inline ? 2 : 12, fontFamily: 'monospace' }) },
    h('view', { style: clean({ color: theme.text, fontSize, fontFamily: 'monospace' }) }, code));
}

export function NGradientText(props = {}, content) {
  const { from = '#2080f0', to = '#d03050', fontSize = 28, fontWeight = 'bold', id } = props;
  return h('view', { id, style: clean({ textGradientFrom: from, textGradientTo: to, fontSize, fontWeight }) }, content);
}
