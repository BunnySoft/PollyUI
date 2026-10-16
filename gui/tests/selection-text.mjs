import { createTextInput } from './gui/sdk/js/textinput.mjs';
import { textGeometry } from './gui/sdk/js/textgeometry.mjs';
import { h, createApp, reactive } from './gui/sdk/js/vue.mjs';
import { NInput } from './gui/sdk/js/naive.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
const pixels = (root, padding, width, height, offset = 0) => {
  const r = root.getBoundingClientRect(), result = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
    result.push(host.pixel(r.x + padding + offset + x, r.y + padding + y));
  return result;
};
const difference = (a, b) => a.filter((pixel, index) => pixel !== b[index]).length;
const settle = async () => { for (let i = 0; i < 3; i++) { await Promise.resolve(); host.render(); } };
const shade = '#0a246a', white = '#ffffff', black = '#000000';
const results = [];
for (const text of ['AV fi cafe\u0301', 'Color \ud83d\ude42 glyph', '\u05d0\u05d1\u05d2 abc \u05d3\u05d4\u05d5']) {
  const fs = 20, pad = 8, geometry = textGeometry(text, fs), width = Math.ceil(geometry.width), height = fs;
  const reference = createTextInput({ value: text, fontSize: fs, padding: pad, width: 600,
    color: white, background: shade });
  document.body.appendChild(reference.root); host.render();
  const nativeWhite = pixels(reference.root, pad, width, height);
  let colorGlyphPixels = null;
  if (text.startsWith('Color')) {
    colorGlyphPixels = nativeWhite.filter(pixel => {
      const r = parseInt(pixel.slice(1, 3), 16), g = parseInt(pixel.slice(3, 5), 16), b = parseInt(pixel.slice(5, 7), 16);
      return r > 100 && g > 70 && b < 100;
    }).length;
    check(colorGlyphPixels > 0, 'The current native DOM reference really contains a rendered color emoji, not a missing-glyph proxy');
  }
  const actual = createTextInput({ value: text, fontSize: fs, padding: pad, width: 600,
    color: black, background: '#ffffff', selectionColor: shade, selectionTextColor: white });
  document.body.appendChild(actual.root); host.render();
  const unselected = pixels(actual.root, pad, width, height);
  actual.root.focus(); actual.selectAll(); host.render();
  const selected = pixels(actual.root, pad, width, height);
  const selectedOrigin = actual.root.getBoundingClientRect(), selectedCaret = actual.root.childNodes[2].getBoundingClientRect();
  const fullClips = actual.root.querySelector('.input-selection-text').childNodes.map(node => {
    const r = node.getBoundingClientRect(); return [r.x - selectedOrigin.x - pad, r.right - selectedOrigin.x - pad];
  });
  const expectedFull = nativeWhite.map((pixel, index) => {
    const x = index % width, y = Math.floor(index / width);
    if (selectedOrigin.x + pad + x >= selectedCaret.x && selectedOrigin.x + pad + x < selectedCaret.right &&
        selectedOrigin.y + pad + y >= selectedCaret.y && selectedOrigin.y + pad + y < selectedCaret.bottom) return '#000000';
    return fullClips.some(([left, right]) => x >= left && x < right) ? pixel : unselected[index];
  });
  const changed = difference(expectedFull, selected);
  check(changed === 0, 'Whole selected native DOM glyph reference: ' +
    JSON.stringify({ case: text.startsWith('Color') ? 'color-glyph' : text.startsWith('AV') ? 'Latin' : 'RTL', width, height, changed }));
  const layer = actual.root.querySelector('.input-selection-text');
  check(layer && layer.getAttribute('aria-hidden') === 'true' && layer.style.pointerEvents === 'none' &&
    actual.value === text && actual.root.childNodes[1].firstChild.textContent === text,
    'Decorative native copies do not replace the real text/value or intercept input');
  const selection = JSON.stringify(actual.getSelection()), caret = actual.getCaret(), root = actual.root;
  actual.setAppearance({ selectionTextColor: '#ffff00', borderRadius: 0, fontSize: fs });
  check(actual.root === root && actual.getCaret() === caret && JSON.stringify(actual.getSelection()) === selection,
    'Appearance changes retain selection, caret and input node');
  actual.setAppearance({ selectionTextColor: white });
  actual.root.blur(); host.render();
  check(difference(unselected, pixels(actual.root, pad, width, height)) === 0 &&
    !actual.root.querySelector('.input-selection-text'), 'Blur restores every unselected glyph pixel and removes decorative copies');
  actual.root.focus(); host.key('Home', 'keydown', { text: false });
  for (let i = 0; i < 2; i++) host.key('ArrowRight', 'keydown', { shiftKey: true, text: false });
  host.render();
  const [start, end] = actual.getSelection(), ranges = geometry.ranges(start, end);
  const origin = actual.root.getBoundingClientRect(), caretBox = actual.root.childNodes[2].getBoundingClientRect();
  const paintedRanges = actual.root.querySelector('.input-selection-text').childNodes.map(node => {
    const r = node.getBoundingClientRect();
    return { x: r.x - origin.x - pad, width: r.width };
  });
  const partial = pixels(actual.root, pad, width, height);
  let wrongInside = 0, wrongOutside = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const inside = paintedRanges.some(range => x >= range.x && x < range.x + range.width);
    const caret = origin.x + pad + x >= caretBox.x && origin.x + pad + x < caretBox.right &&
      origin.y + pad + y >= caretBox.y && origin.y + pad + y < caretBox.bottom;
    const expected = caret ? '#000000' : inside ? nativeWhite[y * width + x] : unselected[y * width + x];
    if (inside && partial[y * width + x] !== expected) wrongInside++;
    if (!inside && partial[y * width + x] !== expected) wrongOutside++;
  }
  check(wrongInside === 0 && wrongOutside === 0, 'Partial selection native ranges: ' +
    JSON.stringify({ start, end, ranges, paintedRanges, wrongInside, wrongOutside, caret: actual.getCaret() }));
  host.compose('pending', 7, 0); host.render();
  check(actual.value === text && !actual.root.querySelector('.input-selection-text'),
    'Composition suppresses selection copies without changing the committed value');
  host.compose(''); actual.root.blur();
  results.push({ case: text.startsWith('Color') ? 'native-color-glyph' : text.startsWith('AV') ? 'Latin-kerning-combining' : 'mixed-RTL',
    fullRect: [width, height], fullDifference: changed, partialInside: wrongInside, partialOutside: wrongOutside,
    colorGlyphPixels, complexLayoutAvailable: typeof layoutText === 'function' });
  document.body.removeChild(reference.root); document.body.removeChild(actual.root);
}
const secure = createTextInput({ password: true, value: 'private\ud83d\ude42', fontSize: 20, selectionColor: shade, selectionTextColor: white });
document.body.appendChild(secure.root); host.render(); secure.root.focus(); secure.selectAll(); host.render();
check(secure.root.querySelector('.input-selection-text').textContent === '\u2022'.repeat(8),
  'Password decorative rendering contains only displayed masks');
host.compose('must-not-display', 3, 0);
check(!secure.root.textContent.includes('must') && !secure.root.textContent.includes('private'), 'Secure preedit and copies do not expose credentials');
secure.root.blur(); document.body.removeChild(secure.root);
const model = reactive({ value: 'AV cafe\u0301', foreground: white, family: undefined });
createApp({ setup: () => () => NInput({ id: 'selection-naive', value: model.value, fontSize: 20,
  fontFamily: model.family,
  selectionColor: shade, selectionTextColor: model.foreground, onInput: value => { model.value = value; } }) }).mount(document.body);
await settle();
const node = document.getElementById('selection-naive');
node.focus(); host.key('a', 'keydown', { ctrlKey: true, text: false }); await settle();
check(node.querySelector('.input-selection-text')?.textContent === model.value, 'Controlled NInput uses the same complete-string native selection painter');
model.foreground = '#ffff00'; await settle();
check(document.getElementById(node.id) === node && document.activeElement === node &&
  node.querySelector('.input-selection-text'), 'NInput retheme keeps actual focus/node/selection');
host.compose('pending', 7, 0); await settle();
check(!node.querySelector('.input-selection-text') && model.value === 'AV cafe\u0301', 'Controlled NInput preedit does not duplicate a selection');
host.text('done'); await settle();
check(model.value === 'done', 'Controlled IME commit still updates once');
node.blur(); await settle();
if (measureText.supportsFontFamily === true) {
  model.value = 'WiWiWi'; model.family = globalThis.namedTestFont || 'monospace'; await settle();
  node.focus(); host.key('Home', 'keydown', { text: false }); host.key('ArrowRight', 'keydown', { text: false }); await settle();
  const caret = () => node.childNodes.find(child => Number(child.style.width) === 1.5);
  check(Math.abs(Number(caret().style.left) - 12 - textGeometry(model.value, 20, model.family).caret(1)) < 0.01,
    'Controlled NInput caret uses the per-instance named-family metrics');
  host.key('a', 'keydown', { ctrlKey: true, text: false }); await settle();
  model.family = 'sans-serif'; await settle();
  const copy = node.querySelector('.input-selection-text').firstChild.childNodes[1];
  check(document.getElementById(node.id) === node && document.activeElement === node &&
    copy.style.fontFamily === model.family, 'Controlled family change retains selection and same-font full-string ink');
  host.text('x'); await settle();
  check(model.value === 'x', 'Named-family retheme preserves the actual controlled selected range');
  model.family = undefined; await settle();
  check(!node.firstChild.style.fontFamily, 'Removing the optional family restores the legacy input font');
  node.blur(); await settle();
}
console.log('SELECTION_TEXT_NATIVE ' + JSON.stringify(results));
console.log('PASS: native same-font full-string range clipping, emoji/combining/RTL, partial/all, secure and controlled IME lifecycle');
