// textinput.mjs — a single-line text input with a movable caret, click-to-
// position, drag-to-select, and editing. Built entirely on the DOM + events +
// measureText (no native text-input widget).
//
//   import { createTextInput } from './gui/sdk/js/textinput.mjs';
//   const input = createTextInput({ value: 'Hello', width: 280 });
//   document.body.appendChild(input.root);
// Pass window: handle when embedding in another native window (document and cursor).

import { previousTextIndex, nextTextIndex, clampTextIndex } from './gui/sdk/js/textindex.mjs';
import { textGeometry } from './gui/sdk/js/textgeometry.mjs';
import { selectionTextColor, paintSelectionText } from './gui/sdk/js/selection-text.mjs';
import { requireFontFamily, fontFamilyStyle } from './gui/sdk/js/font-family.mjs';

const el = (owner, tag, style) => {
  const n = owner.createElement(tag);
  if (style) for (const k in style) n.style[k] = String(style[k]);
  return n;
};

export function createTextInput(opts = {}) {
  let fontFamily = requireFontFamily(opts.fontFamily);
  const maxLength = opts.maxLength;
  if (maxLength !== undefined && (!Number.isSafeInteger(maxLength) || maxLength < 0))
    throw new RangeError('Input maxLength must be a non-negative safe integer');
  const bounded = (value, budget = maxLength) => {
    if (budget === undefined) return value;
    const prefix = Array.from(value).slice(0, budget).join('');
    return value.slice(0, clampTextIndex(value, prefix.length));
  };
  const surface = opts.window ?? (typeof window !== 'undefined' && (!opts.document || opts.document === window.document) ? window : null);
  const owner = opts.document ?? surface?.document ?? document;
  let fontSize = opts.fontSize ?? 18;
  const padding  = opts.padding ?? 8;
  const width    = opts.width ?? 240;
  let color    = opts.color ?? '#0f172a';
  let selColor = opts.selectionColor ?? '#93c5fd';
  let selTextColor = selectionTextColor(opts.selectionTextColor), selectedText = null;
  const purpose = opts.password ? 'password' : opts.purpose ?? 'text';
  const secure = purpose === 'password' || purpose === 'pin';
  const displayed = value => secure ? '\u2022'.repeat(Array.from(value).length) : value;

  const st = { value: bounded(String(opts.value ?? '')), caret: 0, anchor: null, focused: false, dragging: false, hovered: false, composition: null };
  st.caret = st.value.length;

  const root = el(owner, 'view', {
    width, height: fontSize + padding * 2, backgroundColor: opts.background ?? '#ffffff',
    borderRadius: 6, borderWidth: 1, borderColor: '#cbd5e1',
    position: 'relative', overflow: 'hidden', paddingLeft: padding, paddingTop: padding,
    'focus:borderColor': opts.focusColor ?? '#2563eb',
  });
  root.tabIndex = 0;

  const highlight = el(owner, 'view', { position: 'absolute', top: 0, left: 0, width, height: fontSize + padding * 2, pointerEvents: 'none' });
  const textEl = el(owner, 'view', { color, fontSize, ...fontFamilyStyle(fontFamily),
    pointerEvents: 'none', flexShrink: 0, position: 'relative' });
  const textNode = owner.createTextNode(displayed(st.value));
  textEl.appendChild(textNode);
  const caret = el(owner, 'view', { position: 'absolute', top: padding, left: padding, width: 2, height: fontSize, backgroundColor: 'transparent', pointerEvents: 'none' });
  const underline = el(owner, 'view', { position: 'absolute', top: 0, left: 0, width, height: fontSize + padding * 2, pointerEvents: 'none' });

  root.appendChild(highlight);  // behind the text
  root.appendChild(textEl);
  root.appendChild(caret);
  root.appendChild(underline);

  let blinkFrame = null, blinkTime = null, caretOn = true, blinkGeneration = 0;
  function scheduleBlink() {
    const generation = blinkGeneration;
    blinkFrame = requestAnimationFrame(timestamp => {
      if (generation === blinkGeneration) blink(timestamp);
    });
  }
  function focusedInput() {
    if (!st.focused || owner.activeElement !== root || root.ownerDocument !== owner || surface?.closed) return false;
    for (let node = root; node; node = node.parentNode) {
      if (node.style?.display === 'none') return false;
      if (node === owner.body) return true;
    }
    return false;
  }
  function activeOwner() {
    const view = owner.defaultView ?? surface;
    if (!view) return true;
    if (view.closed) return false;
    if (!('state' in view)) return true;
    const state = view.state;
    return state.active && !state.minimized;
  }
  function blinkSupported() {
    const view = owner.defaultView ?? surface;
    return !view || 'state' in view;
  }
  function paintCaret() {
    const visible = focusedInput() && activeOwner() && caretOn &&
      (!st.composition || st.composition.cursor >= 0);
    const next = visible ? color : 'transparent';
    if (caret.style.backgroundColor !== next) caret.style.backgroundColor = next;
  }
  function blink(timestamp) {
    blinkFrame = null;
    if (!focusedInput() || selRange()) { paintCaret(); return; }
    if (!activeOwner()) { caretOn = false; blinkTime = null; }
    else if (blinkTime === null || st.dragging || st.composition) { caretOn = true; blinkTime = timestamp; }
    else if (timestamp - blinkTime >= 530) { caretOn = !caretOn; blinkTime = timestamp; }
    paintCaret();
    scheduleBlink();
  }
  function resetCaret(reset = true) {
    blinkGeneration++;
    if (reset) { caretOn = true; blinkTime = null; }
    if (blinkFrame !== null) cancelAnimationFrame(blinkFrame);
    blinkFrame = null;
    paintCaret();
    // rAF does not keep a headless test alive and only caret color changes repaint.
    if (focusedInput() && !selRange() && blinkSupported()) scheduleBlink();
  }

  const displayIndex = (value, i) => displayed(value.slice(0, i)).length;
  const xOf = (i, value = st.value) => textGeometry(displayed(value), fontSize, fontFamily).caret(displayIndex(value, i));

  // Map a text-local x (px from the text start) to the nearest caret index.
  function indexAtX(localX) {
    const index = textGeometry(displayed(st.value), fontSize, fontFamily).nearest(localX);
    return secure ? clampTextIndex(st.value, Array.from(st.value).slice(0, index).join('').length) : index;
  }

  function selRange() {
    if (st.anchor === null || st.anchor === st.caret) return null;
    return st.anchor < st.caret ? [st.anchor, st.caret] : [st.caret, st.anchor];
  }

  function paintRanges(container, ranges, y, height, color) {
    while (container.childNodes.length > ranges.length) container.removeChild(container.lastChild);
    while (container.childNodes.length < ranges.length) container.appendChild(el(owner, 'view', { position: 'absolute', pointerEvents: 'none' }));
    ranges.forEach((range, index) => Object.assign(container.childNodes[index].style, {
      left: padding + range.x, top: y, width: range.width, height, backgroundColor: color,
    }));
  }
  function render(resetBlink = true) {
    const composition = st.composition;
    const value = composition ? st.value.slice(0, composition.start) + composition.text + st.value.slice(composition.end) : st.value;
    const cursor = composition ? composition.start + (composition.cursor < 0 ? composition.text.length : composition.cursor) : st.caret;
    textNode.textContent = displayed(value);
    caret.style.left = String(padding + xOf(cursor, value));
    resetCaret(resetBlink);
    const geometry = textGeometry(displayed(value), fontSize, fontFamily);
    const innerWidth = root.offsetWidth - padding * 2 - 2;
    if (innerWidth > 0) {
      const x = xOf(cursor, value), current = Number(root.scrollLeft);
      root.scrollLeft = Math.max(0, Math.min(Math.max(0, geometry.width - innerWidth),
        x < current ? x : x > current + innerWidth ? x - innerWidth : current));
    }
    paintRanges(underline, composition ? geometry.ranges(displayIndex(value, composition.start),
      displayIndex(value, composition.start + composition.text.length)) : [], padding + fontSize, 1, color);
    const r = composition ? null : selRange();
    const ranges = r && st.focused ? geometry.ranges(displayIndex(value, r[0]), displayIndex(value, r[1])) : [];
    paintRanges(highlight, ranges,
      padding, fontSize, selColor);
    if (selTextColor !== undefined && selTextColor !== color && ranges.length) {
      if (!selectedText) {
        selectedText = el(owner, 'view', { position: 'absolute', left: 0, top: 0, pointerEvents: 'none' });
        selectedText.className = 'input-selection-text';
        selectedText.setAttribute('aria-hidden', 'true');
        textEl.appendChild(selectedText);
      }
      paintSelectionText(selectedText, { text: displayed(value), fontSize, fontFamily, ranges, width: geometry.width, height: fontSize,
        foreground: selTextColor, selection: selColor, background: root.style.backgroundColor });
    } else if (selectedText?.parentNode) {
      selectedText.parentNode.removeChild(selectedText);
      selectedText = null;
    }
    if (st.focused && owner.activeElement === root && root.ownerDocument === owner && !surface?.closed)
      root.setInputMethod({ purpose, x: padding + xOf(cursor, value), y: padding, width: 2, height: fontSize });
  }

  const localXFrom = clientX => clientX - root.getBoundingClientRect().x - padding + Number(root.scrollLeft);
  const cursor = name => { if (surface && !surface.closed) surface.setCursor(name); };
  function endDrag(release = false) {
    const dragging = st.dragging;
    st.dragging = false;
    if (release && dragging) root.releaseMouseCapture();
    if (st.anchor === st.caret) st.anchor = null;
    if (dragging) cursor(st.hovered ? 'text' : 'arrow');
  }

  root.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (st.composition) root.cancelComposition();
    const i = indexAtX(localXFrom(e.clientX));
    if (!e.shiftKey) st.anchor = i;
    else if (st.anchor === null) st.anchor = st.caret;
    st.caret = i;
    root.focus();
    root.setMouseCapture();
    st.dragging = true;
    cursor('text');
    render();
  });
  root.addEventListener('mousemove', (e) => {
    if (!st.dragging) return;
    st.caret = indexAtX(localXFrom(e.clientX));
    render();
  });
  root.addEventListener('mouseup', e => {
    if (e.button !== 0 || !st.dragging) return;
    st.caret = indexAtX(localXFrom(e.clientX));
    endDrag(true);
    const selection = selRange();
    if (!secure && selection && typeof clipboard !== 'undefined' && clipboard.supportsPrimary)
      clipboard.writePrimaryText(st.value.slice(selection[0], selection[1]));
    render();
  });
  root.addEventListener('mouseenter', () => { st.hovered = true; cursor('text'); });
  root.addEventListener('mouseleave', () => { st.hovered = false; if (!st.dragging) cursor('arrow'); });
  root.addEventListener('mousecancel', () => { st.hovered = false; endDrag(); cursor('arrow'); render(); });
  root.addEventListener('lostmousecapture', () => { endDrag(); render(); });
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
  root.addEventListener('blur',  () => { st.focused = false; endDrag(true); render(); });
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
    endDrag(true);
    const r = selRange();
    const [s, e] = r ? r : [st.caret, st.caret];
    if (maxLength !== undefined)
      insert = bounded(insert, Math.max(0, maxLength - Array.from(st.value.slice(0, s) + st.value.slice(e)).length));
    st.value = st.value.slice(0, s) + insert + st.value.slice(e);
    st.caret = s + insert.length;
    st.anchor = null;
  }

  root.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === 'Escape' || ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Backspace', 'Delete'].includes(k) ||
      ((e.ctrlKey || e.metaKey) && !e.altKey && ['a', 'x', 'v'].includes(k.toLowerCase()))) endDrag(true);
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
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(k)) {
      const selected = selRange();
      if (e.shiftKey) { if (st.anchor === null) st.anchor = st.caret; }
      else st.anchor = null;
      st.caret = k === 'Home' ? 0 : k === 'End' ? st.value.length :
        selected && !e.shiftKey ? selected[k === 'ArrowLeft' ? 0 : 1] :
          k === 'ArrowLeft' ? previousTextIndex(st.value, st.caret) : nextTextIndex(st.value, st.caret);
    }
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
    set value(v) { endDrag(true); if (st.composition) root.cancelComposition(); st.value = bounded(String(v)); st.caret = st.value.length; st.anchor = null; render(); },
    getCaret: () => st.caret,
    getSelection: () => selRange(),
    selectAll: () => { st.anchor = 0; st.caret = st.value.length; st.focused = true; render(); },
    setAppearance(values) {
      if (!values || typeof values !== 'object' || Array.isArray(values))
        throw new TypeError('Input appearance must be an object');
      if (Object.hasOwn(values, 'fontFamily')) requireFontFamily(values.fontFamily);
      for (const [key, value] of Object.entries(values)) {
        if (key === 'fontFamily') continue;
        if (key === 'borderRadius' || key === 'fontSize') {
          if (!Number.isFinite(value) || value < (key === 'fontSize' ? 8 : 0) ||
            value > (key === 'fontSize' ? 64 : 256))
            throw new RangeError('Invalid input appearance metric: ' + key);
        } else if (!['color', 'selectionColor', 'selectionTextColor', 'background', 'borderColor', 'focusColor'].includes(key) ||
          typeof value !== 'string' || !value.length || value.length > 64)
          throw new TypeError('Invalid input appearance field: ' + key);
      }
      if (Object.hasOwn(values, 'color')) { color = values.color; textEl.style.color = color; }
      if (Object.hasOwn(values, 'fontFamily')) {
        const changed = fontFamily !== values.fontFamily;
        fontFamily = values.fontFamily;
        if (changed) textEl.style.fontFamily = fontFamily ?? '';
      }
      if (Object.hasOwn(values, 'selectionColor')) selColor = values.selectionColor;
      if (Object.hasOwn(values, 'selectionTextColor')) selTextColor = values.selectionTextColor;
      if (Object.hasOwn(values, 'background')) root.style.backgroundColor = values.background;
      if (Object.hasOwn(values, 'borderColor')) root.style.borderColor = values.borderColor;
      if (Object.hasOwn(values, 'focusColor')) root.style['focus:borderColor'] = values.focusColor;
      if (Object.hasOwn(values, 'borderRadius')) root.style.borderRadius = values.borderRadius;
      if (Object.hasOwn(values, 'fontSize')) {
        fontSize = values.fontSize;
        textEl.style.fontSize = fontSize;
        root.style.height = highlight.style.height = underline.style.height = fontSize + padding * 2;
        caret.style.height = fontSize;
      }
      render(false);
    },
  };
}
