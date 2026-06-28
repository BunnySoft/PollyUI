// naive.mjs — a Naive UI-flavored component library (themed, N-prefixed).
// Components are factories returning vnodes, so they compose with h()/the
// reconciler and Vue's createApp.
//
//   import { NCard, NButton, NSpace, NSwitch, NTag, NInput, NTabs, useTheme }
//     from './js/naive.mjs';

import { h, reactive } from './js/vue.mjs';

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

// drop undefined/null so they don't stringify to "undefined"
const clean = (o) => { const r = {}; for (const k in o) if (o[k] !== undefined && o[k] !== null) r[k] = String(o[k]); return r; };

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
  if (!color)        { style.backgroundColor = ghost ? 'transparent' : theme.card; style.borderWidth = 1; style.borderColor = theme.border; style.color = theme.text; }
  else if (ghost)    { style.backgroundColor = 'transparent'; style.borderWidth = 1; style.borderColor = color; style.color = color; }
  else               { style.backgroundColor = color; }
  return h('view', { id, style: clean(style), onClick: disabled ? undefined : onClick }, label);
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
  const { value = '', placeholder = '', onInput, width = 200, size = 'medium', id } = props;
  const fs = size === 'large' ? 16 : 14;
  const h0 = BTN_SIZE[size] ? BTN_SIZE[size].h : 34;
  const isPh = value.length === 0;
  return h('view', {
    id, tabIndex: 0,
    style: clean({ width, height: h0, backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border, borderRadius: 3, paddingLeft: 12, paddingRight: 12, justifyContent: 'center', overflow: 'hidden' }),
    onKeydown: (e) => {
      if (!onInput) return;
      const k = e.key;
      if (k === 'Backspace') onInput(value.slice(0, -1));
      else if (k.length === 1) onInput(value + k);
    },
  }, h('view', { style: { color: isPh ? theme.textDisabled : theme.text, fontSize: String(fs) } }, isPh ? placeholder : value));
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
  _overlays.list = _overlays.list.concat({ id, render, x: opts.x || 0, y: opts.y || 0, onClose: opts.onClose, backdrop: opts.backdrop !== false });
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
    kids.push(h('view', { key: 'pop' + o.id, style: clean({ position: 'absolute', top: o.y, left: o.x }) }, typeof o.render === 'function' ? o.render() : o.render));
  }
  return h('view', { style: clean({ position: 'absolute', top: 0, left: 0, width: active ? '100%' : 0, height: active ? '100%' : 0 }) }, ...kids);
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
  const { label, error, required = false } = props;
  return h('view', { style: { flexDirection: 'column', gap: '6' } },
    label ? h('view', { style: { flexDirection: 'row', gap: '3' } },
      h('view', { style: { color: theme.text, fontSize: '14', fontWeight: '500' } }, label),
      required ? h('view', { style: { color: theme.error, fontSize: '14' } }, '*') : null) : null,
    control,
    error ? h('view', { id: props.errorId, style: { color: theme.error, fontSize: '12' } }, error) : null);
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
  return h('view', { id, tabIndex: 0, style: clean({ width, height: 34, backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border, borderRadius: 3, paddingLeft: 12, paddingRight: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }), onClick: open },
    h('view', { style: clean({ color: value.length ? theme.text : theme.textDisabled, fontSize: 14 }) }, value.length ? labelFor(value) : placeholder),
    h('view', { style: { color: theme.textSecondary, fontSize: '12' } }, '▾'));
}
