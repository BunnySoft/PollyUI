// textinput.mjs — a single-line text input with a movable caret, click-to-
// position, drag-to-select, and editing. Built entirely on the DOM + events +
// measureText (no native text-input widget).
//
//   import { createTextInput } from './js/textinput.mjs';
//   const input = createTextInput({ value: 'Hello', width: 280 });
//   document.body.appendChild(input.root);

const el = (tag, style) => {
  const n = document.createElement(tag);
  if (style) for (const k in style) n.style[k] = String(style[k]);
  return n;
};

export function createTextInput(opts = {}) {
  const fontSize = opts.fontSize ?? 18;
  const padding  = opts.padding ?? 8;
  const width    = opts.width ?? 240;
  const color    = opts.color ?? '#0f172a';
  const selColor = opts.selectionColor ?? '#93c5fd';

  const st = {
    value: String(opts.value ?? ''), caret: 0, anchor: null,
    focused: false, dragging: false, composition: null,
  };
  st.caret = st.value.length;

  const root = el('view', {
    width, height: fontSize + padding * 2, backgroundColor: opts.background ?? '#ffffff',
    borderRadius: 6, borderWidth: 1, borderColor: '#cbd5e1',
    position: 'relative', overflow: 'hidden', paddingLeft: padding, paddingTop: padding,
  });
  root.tabIndex = 0;

  const highlight = el('view', { position: 'absolute', top: padding, left: padding, width: 0, height: fontSize, backgroundColor: 'transparent', borderRadius: 2 });
  const textEl = el('view', { color, fontSize });
  const textNode = document.createTextNode(st.value);
  textEl.appendChild(textNode);
  const caret = el('view', { position: 'absolute', top: padding, left: padding, width: 2, height: fontSize, backgroundColor: 'transparent' });

  root.appendChild(highlight);  // behind the text
  root.appendChild(textEl);
  root.appendChild(caret);

  const xOf = (text, i) => measureText(text.slice(0, i), fontSize);
  const utf16Index = (text, characters) =>
    Array.from(text).slice(0, Math.max(0, characters)).join('').length;
  const prevIndex = (text, i) => {
    if (i <= 0) return 0;
    const low = text.charCodeAt(i - 1);
    return low >= 0xdc00 && low <= 0xdfff && i >= 2 ? i - 2 : i - 1;
  };
  const nextIndex = (text, i) => {
    if (i >= text.length) return text.length;
    const high = text.charCodeAt(i);
    return high >= 0xd800 && high <= 0xdbff && i + 1 < text.length ? i + 2 : i + 1;
  };

  // Map a text-local x (px from the text start) to the nearest caret index.
  function indexAtX(localX) {
    const v = st.value;
    let best = 0, bestD = Infinity;
    for (let i = 0; i <= v.length; i = nextIndex(v, i)) {
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
    let shown = st.value;
    let shownCaret = st.caret;
    const comp = st.composition;
    if (comp) {
      shown = st.value.slice(0, comp.baseStart) + comp.data +
              st.value.slice(comp.baseEnd);
      shownCaret = comp.baseStart +
                   utf16Index(comp.data, comp.start);
    }
    textNode.textContent = shown;
    const cursorX = padding + xOf(shown, shownCaret);
    caret.style.left = String(cursorX);
    caret.style.backgroundColor = st.focused ? color : 'transparent';
    root.setAttribute('textInputCursor', String(cursorX));
    const r = selRange();
    if (comp && st.focused) {
      const selectedStart = comp.baseStart + utf16Index(comp.data, comp.start);
      const selectedEnd = comp.baseStart +
                          utf16Index(comp.data, comp.start + comp.length);
      const visualStart = comp.length > 0 ? selectedStart : comp.baseStart;
      const visualEnd = comp.length > 0 ? selectedEnd :
                        comp.baseStart + comp.data.length;
      highlight.style.left = String(padding + xOf(shown, visualStart));
      highlight.style.width = String(Math.max(
        1, xOf(shown, visualEnd) - xOf(shown, visualStart)));
      highlight.style.backgroundColor = selColor;
    } else if (r && st.focused) {
      highlight.style.left = String(padding + xOf(st.value, r[0]));
      highlight.style.width = String(xOf(st.value, r[1]) - xOf(st.value, r[0]));
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
  root.addEventListener('blur',  () => { st.focused = false; st.composition = null; render(); });

  root.addEventListener('compositionstart', () => {
    const r = selRange();
    const [baseStart, baseEnd] = r || [st.caret, st.caret];
    st.composition = { data: '', start: 0, length: 0, baseStart, baseEnd };
    render();
  });
  root.addEventListener('compositionupdate', (e) => {
    if (!st.composition) {
      const r = selRange();
      const [baseStart, baseEnd] = r || [st.caret, st.caret];
      st.composition = { data: '', start: 0, length: 0, baseStart, baseEnd };
    }
    st.composition.data = e.data || '';
    st.composition.start = e.start || 0;
    st.composition.length = e.length || 0;
    render();
  });
  root.addEventListener('compositionend', () => {
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
    if (k === 'ArrowLeft')       { st.caret = prevIndex(st.value, st.caret); st.anchor = null; }
    else if (k === 'ArrowRight') { st.caret = nextIndex(st.value, st.caret); st.anchor = null; }
    else if (k === 'Home')       { st.caret = 0; st.anchor = null; }
    else if (k === 'End')        { st.caret = st.value.length; st.anchor = null; }
    else if (k === 'Backspace') {
      const r = selRange();
      if (r) { st.value = st.value.slice(0, r[0]) + st.value.slice(r[1]); st.caret = r[0]; st.anchor = null; }
      else if (st.caret > 0) { const p = prevIndex(st.value, st.caret); st.value = st.value.slice(0, p) + st.value.slice(st.caret); st.caret = p; }
    }
    else if (k === 'Delete') {
      const r = selRange();
      if (r) { st.value = st.value.slice(0, r[0]) + st.value.slice(r[1]); st.caret = r[0]; st.anchor = null; }
      else if (st.caret < st.value.length) { const n = nextIndex(st.value, st.caret); st.value = st.value.slice(0, st.caret) + st.value.slice(n); }
    }
    else if (e.data != null || k.length === 1) { replaceSelection(k); }
    else return;
    render();
  });

  render();
  root.setAttribute('textInput', 'true');

  return {
    root,
    get value() { return st.value; },
    set value(v) { st.value = String(v); st.caret = st.value.length; st.anchor = null; render(); },
    getCaret: () => st.caret,
    getSelection: () => selRange(),
    selectAll: () => { st.anchor = 0; st.caret = st.value.length; st.focused = true; render(); },
  };
}
