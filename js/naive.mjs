// naive.mjs — a Naive UI-flavored component library (themed, N-prefixed).
// Components are factories returning vnodes, so they compose with h()/the
// reconciler and Vue's createApp.
//
//   import { NCard, NButton, NSpace, NSwitch, NTag, NInput, theme } from './js/naive.mjs';
//   NCard({ title: 'Demo' },
//     NSpace({}, NButton({ type: 'primary' }, 'Save'), NButton({}, 'Cancel')));

import { h } from './js/vue.mjs';

// Naive UI default (light) theme tokens.
export const theme = {
  primary: '#18a058', info: '#2080f0', success: '#18a058', warning: '#f0a020', error: '#d03050',
  text: '#333639', textDisabled: '#c2c2c2',
  border: '#e0e0e6', card: '#ffffff', body: '#ffffff',
  radius: 3,
};

const typeColor = { primary: theme.primary, info: theme.info, success: theme.success, warning: theme.warning, error: theme.error };
const tagBg = { primary: '#e8f5ee', info: '#e3effd', success: '#e8f5ee', warning: '#fdf2e3', error: '#fce8ee', default: '#fafafc' };

const px = (n) => String(n);
// drop undefined values so they don't become the string "undefined"
const clean = (o) => { const r = {}; for (const k in o) if (o[k] !== undefined && o[k] !== null) r[k] = String(o[k]); return r; };

// ---- NButton ----------------------------------------------------------------

const BTN_SIZE = { small: { h: 28, fs: 14, px: 10 }, medium: { h: 34, fs: 14, px: 14 }, large: { h: 40, fs: 16, px: 18 } };

export function NButton(props = {}, label) {
  const { type = 'default', size = 'medium', round = false, ghost = false, disabled = false, onClick } = props;
  const sz = BTN_SIZE[size] || BTN_SIZE.medium;
  const color = typeColor[type];
  const style = {
    height: sz.h, paddingLeft: sz.px, paddingRight: sz.px,
    borderRadius: round ? sz.h / 2 : theme.radius,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    fontSize: sz.fs, fontWeight: '500', color: '#ffffff', opacity: disabled ? 0.5 : 1,
  };
  if (!color) {                          // default: white, bordered
    style.backgroundColor = ghost ? 'transparent' : '#ffffff';
    style.borderWidth = 1; style.borderColor = theme.border; style.color = theme.text;
  } else if (ghost) {                    // ghost: colored border + text
    style.backgroundColor = 'transparent'; style.borderWidth = 1; style.borderColor = color; style.color = color;
  } else {                               // solid: filled
    style.backgroundColor = color;
  }
  return h('view', { id: props.id, style: clean(style), onClick: disabled ? undefined : onClick }, label);
}

// ---- NTag -------------------------------------------------------------------

export function NTag(props = {}, label) {
  const { type = 'default', round = false } = props;
  const color = typeColor[type] || theme.text;
  return h('view', {
    id: props.id,
    style: clean({
      height: 24, paddingLeft: 9, paddingRight: 9, borderRadius: round ? 12 : 2,
      backgroundColor: tagBg[type] || tagBg.default, borderWidth: 1,
      borderColor: type === 'default' ? theme.border : color,
      alignItems: 'center', justifyContent: 'center', flexDirection: 'row',
    }),
  }, h('view', { style: { color, fontSize: '13' } }, label));
}

// ---- NSwitch ----------------------------------------------------------------

export function NSwitch(props = {}) {
  const { value = false, onUpdate, disabled = false } = props;
  const W = 40, H = 22, knob = 18, pad = 2;
  return h('view', {
    id: props.id,
    style: clean({
      width: W, height: H, borderRadius: H / 2, position: 'relative',
      backgroundColor: value ? theme.primary : '#dbdbdb', opacity: disabled ? 0.5 : 1,
    }),
    onClick: disabled ? undefined : () => onUpdate && onUpdate(!value),
  }, h('view', {
    style: clean({
      position: 'absolute', top: pad, left: value ? W - knob - pad : pad,
      width: knob, height: knob, borderRadius: knob / 2, backgroundColor: '#ffffff',
    }),
  }));
}

// ---- NSpace -----------------------------------------------------------------

const SPACE_SIZE = { small: 8, medium: 12, large: 16 };

export function NSpace(props = {}, ...children) {
  const { vertical = false, size = 'medium', align, justify } = props;
  const gap = typeof size === 'number' ? size : (SPACE_SIZE[size] || 12);
  return h('view', {
    style: clean({ flexDirection: vertical ? 'column' : 'row', gap, alignItems: align, justifyContent: justify }),
  }, ...children);
}

// ---- NCard ------------------------------------------------------------------

export function NCard(props = {}, ...children) {
  const { title, bordered = true, width } = props;
  const kids = [];
  if (title) {
    kids.push(h('view', { style: { paddingLeft: '20', paddingRight: '20', paddingTop: '15', paddingBottom: '15' } },
      h('view', { style: { fontSize: '18', fontWeight: 'bold', color: theme.text } }, title)));
    kids.push(h('view', { style: { height: '1', backgroundColor: theme.border } })); // divider
  }
  kids.push(h('view', { style: { padding: '20', gap: '12' } }, ...children));
  return h('view', {
    style: clean({ backgroundColor: theme.card, borderRadius: theme.radius, width, borderWidth: bordered ? 1 : 0, borderColor: theme.border }),
  }, ...kids);
}

// ---- NInput (controlled) ----------------------------------------------------

export function NInput(props = {}) {
  const { value = '', placeholder = '', onInput, width = 200, size = 'medium', id } = props;
  const fs = size === 'large' ? 16 : 14;
  const h0 = BTN_SIZE[size] ? BTN_SIZE[size].h : 34;
  const isPh = value.length === 0;
  return h('view', {
    id,
    tabIndex: 0,
    style: clean({
      width, height: h0, backgroundColor: '#ffffff', borderWidth: 1, borderColor: theme.border,
      borderRadius: theme.radius, paddingLeft: 12, paddingRight: 12, justifyContent: 'center', overflow: 'hidden',
    }),
    onKeydown: (e) => {
      if (!onInput) return;
      const k = e.key;
      if (k === 'Backspace') onInput(value.slice(0, -1));
      else if (k.length === 1) onInput(value + k);
    },
  }, h('view', { style: { color: isPh ? theme.textDisabled : theme.text, fontSize: String(fs) } }, isPh ? placeholder : value));
}
