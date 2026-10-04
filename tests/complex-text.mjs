import { previousTextIndex, nextTextIndex, clampTextIndex } from './js/textindex.mjs';
import { textGeometry } from './js/textgeometry.mjs';
import { createTextInput } from './js/textinput.mjs';
import { createApp, h, reactive } from './js/vue.mjs';
import { NInput } from './js/naive.mjs';

function check(value, message) {
  if (!value) throw new Error('FAIL: ' + message);
  console.log('PASS: ' + message);
}
check(typeof textBoundaries === 'function' && typeof layoutText === 'function', 'Linux exposes native Unicode text APIs');
const cases = [
  ['e\u0301', [0, 2]],
  ['\ud83d\udc69\u200d\ud83d\udc69\u200d\ud83d\udc67', [0, 8]],
  ['\ud83d\udc4d\ud83c\udffd', [0, 4]],
  ['\ud83c\udde8\ud83c\uddf3\ud83c\uddfa\ud83c\uddf8', [0, 4, 8]],
  ['\u0915\u094d\u0937', [0, 3]],
  ['\u1100\u1161\u11a8', [0, 3]],
  ['\r\n', [0, 2]],
  ['A\0B', [0, 1, 2, 3]],
  ['\ud800x', [0, 1, 2]],
  ['', [0]],
];
for (const [value, expected] of cases) {
  check(JSON.stringify(textBoundaries(value)) === JSON.stringify(expected), 'Unicode grapheme boundary ' + JSON.stringify(value));
  for (let i = 0; i < expected.length - 1; i++) {
    check(nextTextIndex(value, expected[i]) === expected[i + 1] &&
      previousTextIndex(value, expected[i + 1]) === expected[i], 'editor steps over a whole grapheme');
    for (let at = expected[i]; at < expected[i + 1]; at++)
      check(clampTextIndex(value, at) === expected[i], 'caret cannot split a grapheme');
  }
}
const arabic = '\u0644\u0627';
check(measureText(arabic, 32) < measureText('\u0644', 32) + measureText('\u0627', 32) - 1,
  'Arabic joining and lam-alef ligature alter advances');
check(Math.abs(measureText('e\u0301', 24) - measureText('\u00e9', 24)) < 0.1,
  'combining-mark positioning shares normalized advance');
for (const value of ['office', arabic, 'English \u05d0\u05d1\u05d2 123', '\u0915\u094d\u0937', '\u4f60\u597d', cases[1][0]]) {
  const layout = layoutText(value, 24);
  check(layout.width > 0 && Math.abs(layout.width - measureText(value, 24)) < 0.01,
    'measurement and shaping share advances: ' + value);
  check(layout.clusters.every(cluster => Number.isFinite(cluster.x) && cluster.width >= 0 &&
    cluster.start >= 0 && cluster.end <= value.length && cluster.start < cluster.end), 'cluster geometry is bounded');
  const boundaries = textBoundaries(value);
  check(layout.clusters.every(cluster => boundaries.includes(cluster.start) && boundaries.includes(cluster.end)),
    'shaping geometry uses grapheme boundaries');
}
const rtl = textGeometry('\u05d0\u05d1\u05d2', 24);
check(rtl.caret(0) > rtl.caret(1) && rtl.caret(1) > rtl.caret(2) && rtl.caret(3) === 0,
  'RTL logical caret positions follow visual glyph order');
check(rtl.nearest(rtl.caret(0)) === 0 && rtl.nearest(0) === 3, 'RTL pointer hit testing uses visual positions');
check(rtl.ranges(0, 3).length === 1 && Math.abs(rtl.ranges(0, 3)[0].width - rtl.width) < 0.01,
  'RTL selection covers the shaped text');

const field = createTextInput({ value: 'A' + cases[1][0] + 'e\u0301', width: 400 });
document.body.appendChild(field.root); host.render(); field.root.focus();
host.key('Backspace');
check(field.value === 'A' + cases[1][0], 'backspace removes the complete combining sequence');
host.key('Backspace');
check(field.value === 'A', 'backspace removes the complete ZWJ emoji');
field.value = '\u05d0\u05d1\u05d2';
host.render();
host.mouse('mousedown', field.root.offsetLeft + 8, field.root.offsetTop + 12, { button: 0 });
host.mouse('mouseup', field.root.offsetLeft + 8, field.root.offsetTop + 12, { button: 0 });
check(field.getCaret() === 3, 'RTL click at the visual left selects the logical end');
field.selectAll(); host.render();
let highlighted = false;
for (let y = 9; y < 25; y++) for (let x = 9; x < 30; x++)
  if (host.pixel(field.root.offsetLeft + x, field.root.offsetTop + y).toLowerCase() === '#93c5fd') highlighted = true;
check(highlighted,
  'RTL selection highlight has nonnegative width and visible pixels');

const state = reactive({ value: 'e\u0301' + cases[2][0] });
const mount = document.createElement('view');
document.body.appendChild(mount);
createApp({ setup: () => () => h('view', {}, NInput({
  id: 'unicode-controlled', value: state.value, onInput: value => state.value = value,
})) }).mount(mount);
host.render(); document.getElementById('unicode-controlled').focus();
host.key('End'); host.key('Backspace');
check(state.value === 'e\u0301', 'controlled input deletes complete modifier emoji');
host.key('Home'); host.key('Delete');
check(state.value === '', 'controlled input deletes a complete combining cluster');

document.body.textContent = '';
const line = document.createElement('view');
Object.assign(line.style, { width: 90, fontSize: 24, color: '#000000' });
line.textContent = '\u4f60\u597d\u4e16\u754c\u4f60\u597d\u4e16\u754c';
document.body.appendChild(line); host.render();
check(line.offsetHeight > 45, 'CJK wraps at Unicode line opportunities without ASCII spaces');
let ink = false;
for (let y = 30; y < 70; y += 2) for (let x = 0; x < 90; x += 2)
  if (host.pixel(x, y) !== '#FFFFFF') ink = true;
check(ink, 'wrapped CJK glyphs are actually rendered below the first line');
console.log('PASS: complex text suite complete');
