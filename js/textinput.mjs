// textinput.mjs — a single-line text input with a movable caret, click-to-
// position, drag-to-select, and editing. Built entirely on the DOM + events +
// measureText (no native text-input widget).
//
//   import { createTextInput } from './js/textinput.mjs';
//   const input = createTextInput({ value: 'Hello', width: 280 });
//   document.body.appendChild(input.root);
// Pass document: handle.document when embedding in another native window.

import { previousTextIndex, nextTextIndex, clampTextIndex } from './js/textindex.mjs';

const el = (owner, tag, style) => {
  const n = owner.createElement(tag);
  if (style) for (const k in style) n.style[k] = String(style[k]);
  return n;
};

export function createTextInput(opts = {}) {
  const owner = opts.document ?? document;
  const fontSize = opts.fontSize ?? 18;
  const padding  = opts.padding ?? 8;
  const width    = opts.width ?? 240;
  const color    = opts.color ?? '#0f172a';
  const selColor = opts.selectionColor ?? '#93c5fd';
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

  const highlight = el(owner, 'view', { position: 'absolute', top: padding, left: padding, width: 0, height: fontSize, backgroundColor: 'transparent', borderRadius: 2 });
  const textEl = el(owner, 'view', { color, fontSize });
  const textNode = owner.createTextNode(displayed(st.value));
  textEl.appendChild(textNode);
  const caret = el(owner, 'view', { position: 'absolute', top: padding, left: padding, width: 2, height: fontSize, backgroundColor: 'transparent' });
  const underline = el(owner, 'view', { position: 'absolute', top: padding + fontSize, left: padding, width: 0, height: 1, backgroundColor: color });

  root.appendChild(highlight);  // behind the text
  root.appendChild(textEl);
  root.appendChild(caret);
  root.appendChild(underline);

  const xOf = (i, value = st.value) => measureText(displayed(value.slice(0, i)), fontSize);

  // Map a text-local x (px from the text start) to the nearest caret index.
  function indexAtX(localX) {
    const v = st.value;
    let best = 0, bestD = Infinity;
    for (let i = 0; ; i = nextTextIndex(v, i)) {
      const d = Math.abs(xOf(i, v) - localX);
      if (d < bestD) { bestD = d; best = i; }
      if (i === v.length) break;
    }
    return best;
  }

  function selRange() {
    if (st.anchor === null || st.anchor === st.caret) return null;
    return st.anchor < st.caret ? [st.anchor, st.caret] : [st.caret, st.anchor];
  }

  function render() {
    const composition = st.composition;
    const value = composition ? st.value.slice(0, composition.start) + composition.text + st.value.slice(composition.end) : st.value;
    const cursor = composition ? composition.start + (composition.cursor < 0 ? composition.text.length : composition.cursor) : st.caret;
    textNode.textContent = displayed(value);
    caret.style.left = String(padding + xOf(cursor, value));
    caret.style.backgroundColor = st.focused && (!composition || composition.cursor >= 0) ? color : 'transparent';
    underline.style.left = String(padding + xOf(composition ? composition.start : 0, value));
    underline.style.width = String(composition ? xOf(composition.start + composition.text.length, value) - xOf(composition.start, value) : 0);
    const r = composition ? null : selRange();
    if (r && st.focused) {
      highlight.style.left = String(padding + xOf(r[0]));
      highlight.style.width = String(xOf(r[1]) - xOf(r[0]));
      highlight.style.backgroundColor = selColor;
    } else {
      highlight.style.width = '0';
      highlight.style.backgroundColor = 'transparent';
    }
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
  };
}
