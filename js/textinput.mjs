// textinput.mjs — a single-line text input with a movable caret, click-to-
// position, drag-to-select, and editing. Built entirely on the DOM + events +
// measureText (no native text-input widget).
//
//   import { createTextInput } from './js/textinput.mjs';
//   const input = createTextInput({ value: 'Hello', width: 280 });
//   document.body.appendChild(input.root);
// Pass document: handle.document when embedding in another native window.

import { previousTextIndex, nextTextIndex } from './js/textindex.mjs';

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

  const st = { value: String(opts.value ?? ''), caret: 0, anchor: null, focused: false, dragging: false };
  st.caret = st.value.length;

  const root = el(owner, 'view', {
    width, height: fontSize + padding * 2, backgroundColor: opts.background ?? '#ffffff',
    borderRadius: 6, borderWidth: 1, borderColor: '#cbd5e1',
    position: 'relative', overflow: 'hidden', paddingLeft: padding, paddingTop: padding,
  });
  root.tabIndex = 0;

  const highlight = el(owner, 'view', { position: 'absolute', top: padding, left: padding, width: 0, height: fontSize, backgroundColor: 'transparent', borderRadius: 2 });
  const textEl = el(owner, 'view', { color, fontSize });
  const textNode = owner.createTextNode(st.value);
  textEl.appendChild(textNode);
  const caret = el(owner, 'view', { position: 'absolute', top: padding, left: padding, width: 2, height: fontSize, backgroundColor: 'transparent' });

  root.appendChild(highlight);  // behind the text
  root.appendChild(textEl);
  root.appendChild(caret);

  const xOf = (i) => measureText(st.value.slice(0, i), fontSize);

  // Map a text-local x (px from the text start) to the nearest caret index.
  function indexAtX(localX) {
    const v = st.value;
    let best = 0, bestD = Infinity;
    for (let i = 0; ; i = nextTextIndex(v, i)) {
      const d = Math.abs(measureText(v.slice(0, i), fontSize) - localX);
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
    textNode.textContent = st.value;
    caret.style.left = String(padding + xOf(st.caret));
    caret.style.backgroundColor = st.focused ? color : 'transparent';
    const r = selRange();
    if (r && st.focused) {
      highlight.style.left = String(padding + xOf(r[0]));
      highlight.style.width = String(xOf(r[1]) - xOf(r[0]));
      highlight.style.backgroundColor = selColor;
    } else {
      highlight.style.width = '0';
      highlight.style.backgroundColor = 'transparent';
    }
  }

  const localXFrom = (clientX) => clientX - (root.offsetLeft + padding) + (parseFloat(root.scrollLeft) || 0);

  root.addEventListener('mousedown', (e) => {
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
  root.addEventListener('mouseup', () => {
    st.dragging = false;
    if (st.anchor === st.caret) st.anchor = null;
    render();
  });
  root.addEventListener('focus', () => { st.focused = true; render(); });
  root.addEventListener('blur',  () => { st.focused = false; render(); });

  function replaceSelection(insert) {
    const r = selRange();
    const [s, e] = r ? r : [st.caret, st.caret];
    st.value = st.value.slice(0, s) + insert + st.value.slice(e);
    st.caret = s + insert.length;
    st.anchor = null;
  }

  root.addEventListener('keydown', (e) => {
    const k = e.key;
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
    render();
  });
  root.addEventListener('textinput', e => { replaceSelection(e.data); render(); });

  render();

  return {
    root,
    get value() { return st.value; },
    set value(v) { st.value = String(v); st.caret = st.value.length; st.anchor = null; render(); },
    getCaret: () => st.caret,
    getSelection: () => selRange(),
    selectAll: () => { st.anchor = 0; st.caret = st.value.length; st.focused = true; render(); },
  };
}
