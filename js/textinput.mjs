// textinput.mjs — a single-line text input with a movable caret, click-to-
// position, drag-to-select, and editing. Built entirely on the DOM + events +
// measureText (no native text-input widget).
//
//   import { createTextInput } from './js/textinput.mjs';
//   const input = createTextInput({ value: 'Hello', width: 280 });
//   document.body.appendChild(input.root);
// Pass document: handle.document when embedding in another native window.

import { previousTextIndex, nextTextIndex, clampTextIndex } from './js/textindex.mjs';
import { textGeometry } from './js/textgeometry.mjs';

const el = (owner, tag, style) => {
  const n = owner.createElement(tag);
  if (style) for (const k in style) n.style[k] = String(style[k]);
  return n;
};

export function createTextInput(opts = {}) {
  const owner = opts.document ?? document;
  let fontSize = opts.fontSize ?? 18;
  const padding  = opts.padding ?? 8;
  const width    = opts.width ?? 240;
  let color    = opts.color ?? '#0f172a';
  let selColor = opts.selectionColor ?? '#93c5fd';
  const purpose = opts.password ? 'password' : opts.purpose ?? 'text';
  const secure = purpose === 'password' || purpose === 'pin';
  const displayed = value => secure ? '\u2022'.repeat(Array.from(value).length) : value;

  const st = { value: String(opts.value ?? ''), caret: 0, anchor: null, focused: false, dragging: false, composition: null };
  st.caret = st.value.length;

  const root = el(owner, 'view', {
    width, height: fontSize + padding * 2, backgroundColor: opts.background ?? '#ffffff',
    borderRadius: 6, borderWidth: 1, borderColor: '#cbd5e1',
    position: 'relative', overflow: 'hidden', paddingLeft: padding, paddingTop: padding,
  });
  root.tabIndex = 0;

  const highlight = el(owner, 'view', { position: 'absolute', top: 0, left: 0, width, height: fontSize + padding * 2 });
  const textEl = el(owner, 'view', { color, fontSize });
  const textNode = owner.createTextNode(displayed(st.value));
  textEl.appendChild(textNode);
  const caret = el(owner, 'view', { position: 'absolute', top: padding, left: padding, width: 2, height: fontSize, backgroundColor: 'transparent' });
  const underline = el(owner, 'view', { position: 'absolute', top: 0, left: 0, width, height: fontSize + padding * 2 });

  root.appendChild(highlight);  // behind the text
  root.appendChild(textEl);
  root.appendChild(caret);
  root.appendChild(underline);

  const displayIndex = (value, i) => displayed(value.slice(0, i)).length;
  const xOf = (i, value = st.value) => textGeometry(displayed(value), fontSize).caret(displayIndex(value, i));

  // Map a text-local x (px from the text start) to the nearest caret index.
  function indexAtX(localX) {
    const index = textGeometry(displayed(st.value), fontSize).nearest(localX);
    return secure ? clampTextIndex(st.value, Array.from(st.value).slice(0, index).join('').length) : index;
  }

  function selRange() {
    if (st.anchor === null || st.anchor === st.caret) return null;
    return st.anchor < st.caret ? [st.anchor, st.caret] : [st.caret, st.anchor];
  }

  function paintRanges(container, ranges, y, height, color) {
    while (container.childNodes.length > ranges.length) container.removeChild(container.lastChild);
    while (container.childNodes.length < ranges.length) container.appendChild(el(owner, 'view', { position: 'absolute' }));
    ranges.forEach((range, index) => Object.assign(container.childNodes[index].style, {
      left: padding + range.x, top: y, width: range.width, height, backgroundColor: color,
    }));
  }
  function render() {
    const composition = st.composition;
    const value = composition ? st.value.slice(0, composition.start) + composition.text + st.value.slice(composition.end) : st.value;
    const cursor = composition ? composition.start + (composition.cursor < 0 ? composition.text.length : composition.cursor) : st.caret;
    textNode.textContent = displayed(value);
    caret.style.left = String(padding + xOf(cursor, value));
    caret.style.backgroundColor = st.focused && (!composition || composition.cursor >= 0) ? color : 'transparent';
    const geometry = textGeometry(displayed(value), fontSize);
    paintRanges(underline, composition ? geometry.ranges(displayIndex(value, composition.start),
      displayIndex(value, composition.start + composition.text.length)) : [], padding + fontSize, 1, color);
    const r = composition ? null : selRange();
    paintRanges(highlight, r && st.focused ? geometry.ranges(displayIndex(value, r[0]), displayIndex(value, r[1])) : [],
      padding, fontSize, selColor);
    if (st.focused && owner.activeElement === root)
      root.setInputMethod({ purpose, x: padding + xOf(cursor, value), y: padding, width: 2, height: fontSize });
  }

  const localXFrom = (clientX) => clientX - (root.offsetLeft + padding) + (parseFloat(root.scrollLeft) || 0);

  root.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (st.composition) root.cancelComposition();
    const i = indexAtX(localXFrom(e.clientX));
    st.caret = i; st.anchor = i; st.dragging = true; st.focused = true;
    root.focus();
    render();
  });
  root.addEventListener('mousemove', (e) => {
    if (!st.dragging) return;
    st.caret = indexAtX(localXFrom(e.clientX));
    render();
  });
  root.addEventListener('mouseup', e => {
    if (e.button !== 0) return;
    st.dragging = false;
    if (st.anchor === st.caret) st.anchor = null;
    const selection = selRange();
    if (!secure && selection && typeof clipboard !== 'undefined' && clipboard.supportsPrimary)
      clipboard.writePrimaryText(st.value.slice(selection[0], selection[1]));
    render();
  });
  root.addEventListener('auxclick', e => {
    if (e.button !== 1 || typeof clipboard === 'undefined' || !clipboard.supportsPrimary) return;
    e.preventDefault();
    if (st.composition) root.cancelComposition();
    st.caret = indexAtX(localXFrom(e.clientX)); st.anchor = null;
    root.focus();
    replaceSelection(clipboard.readPrimaryText());
    render();
  });
  root.addEventListener('focus', () => { st.focused = true; render(); });
  root.addEventListener('blur',  () => { st.focused = false; render(); });
  root.addEventListener('compositionstart', () => {
    const [start, end] = selRange() || [st.caret, st.caret];
    st.composition = { start, end, text: '', cursor: 0 };
  });
  root.addEventListener('compositionupdate', e => {
    if (!st.composition) return;
    st.composition.text = e.data;
    st.composition.cursor = e.selectionStart < 0 ? -1 : clampTextIndex(e.data, e.selectionStart);
    render();
  });
  root.addEventListener('compositionend', () => {
    if (!st.composition) return;
    st.anchor = st.composition.start; st.caret = st.composition.end;
    if (st.anchor === st.caret) st.anchor = null;
    st.composition = null;
    render();
  });

  function replaceSelection(insert) {
    const r = selRange();
    const [s, e] = r ? r : [st.caret, st.caret];
    st.value = st.value.slice(0, s) + insert + st.value.slice(e);
    st.caret = s + insert.length;
    st.anchor = null;
  }

  root.addEventListener('keydown', (e) => {
    const k = e.key;
    if (st.composition && (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Backspace', 'Delete'].includes(k) ||
      ((e.ctrlKey || e.metaKey) && !e.altKey && ['a', 'c', 'x', 'v'].includes(k.toLowerCase()))))
      root.cancelComposition();
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const key = k.toLowerCase();
      if (key === 'a') { e.preventDefault(); st.anchor = 0; st.caret = st.value.length; render(); return; }
      if (key === 'c' || key === 'x' || key === 'v') {
        e.preventDefault();
        if (secure && key !== 'v') return;
        if (typeof clipboard === 'undefined') throw new Error('Clipboard APIs are unavailable');
        const selected = selRange();
        if (key === 'v') replaceSelection(clipboard.readText());
        else if (selected) {
          clipboard.writeText(st.value.slice(selected[0], selected[1]));
          if (key === 'x') replaceSelection('');
        }
        render(); return;
      }
    }
    if (k === 'ArrowLeft')       { st.caret = previousTextIndex(st.value, st.caret); st.anchor = null; }
    else if (k === 'ArrowRight') { st.caret = nextTextIndex(st.value, st.caret); st.anchor = null; }
    else if (k === 'Home')       { st.caret = 0; st.anchor = null; }
    else if (k === 'End')        { st.caret = st.value.length; st.anchor = null; }
    else if (k === 'Backspace') {
      const r = selRange();
      if (r) { st.value = st.value.slice(0, r[0]) + st.value.slice(r[1]); st.caret = r[0]; st.anchor = null; }
      else if (st.caret > 0) {
        const start = previousTextIndex(st.value, st.caret);
        st.value = st.value.slice(0, start) + st.value.slice(st.caret); st.caret = start;
      }
    }
    else if (k === 'Delete') {
      const r = selRange();
      if (r) { st.value = st.value.slice(0, r[0]) + st.value.slice(r[1]); st.caret = r[0]; st.anchor = null; }
      else if (st.caret < st.value.length) { st.value = st.value.slice(0, st.caret) + st.value.slice(nextTextIndex(st.value, st.caret)); }
    }
    else return;
    e.preventDefault();
    render();
  });
  root.addEventListener('textinput', e => { replaceSelection(e.data); render(); });

  render();

  return {
    root,
    get value() { return st.value; },
    set value(v) { if (st.composition) root.cancelComposition(); st.value = String(v); st.caret = st.value.length; st.anchor = null; render(); },
    getCaret: () => st.caret,
    getSelection: () => selRange(),
    selectAll: () => { st.anchor = 0; st.caret = st.value.length; st.focused = true; render(); },
    setAppearance(values) {
      if (!values || typeof values !== 'object' || Array.isArray(values))
        throw new TypeError('Input appearance must be an object');
      for (const [key, value] of Object.entries(values)) {
        if (key === 'borderRadius' || key === 'fontSize') {
          if (!Number.isFinite(value) || value < (key === 'fontSize' ? 8 : 0) ||
            value > (key === 'fontSize' ? 64 : 256))
            throw new RangeError('Invalid input appearance metric: ' + key);
        } else if (!['color', 'selectionColor', 'background', 'borderColor'].includes(key) ||
          typeof value !== 'string' || !value.length || value.length > 64)
          throw new TypeError('Invalid input appearance field: ' + key);
      }
      if (Object.hasOwn(values, 'color')) { color = values.color; textEl.style.color = color; }
      if (Object.hasOwn(values, 'selectionColor')) selColor = values.selectionColor;
      if (Object.hasOwn(values, 'background')) root.style.backgroundColor = values.background;
      if (Object.hasOwn(values, 'borderColor')) root.style.borderColor = values.borderColor;
      if (Object.hasOwn(values, 'borderRadius')) root.style.borderRadius = values.borderRadius;
      if (Object.hasOwn(values, 'fontSize')) {
        fontSize = values.fontSize;
        textEl.style.fontSize = fontSize;
        root.style.height = highlight.style.height = underline.style.height = fontSize + padding * 2;
        caret.style.height = fontSize;
      }
      render();
    },
  };
}
