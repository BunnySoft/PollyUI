// textinput.mjs — click-to-position caret, drag-to-select, edit-with-selection.

import { createTextInput } from './gui/sdk/js/textinput.mjs';
import { textGeometry } from './gui/sdk/js/textgeometry.mjs';

let pass = 0, fail = 0;
function check(n, c) { if (c) { pass++; console.log('PASS: ' + n); } else { fail++; console.log('FAIL: ' + n); } }
function findColor(x0, y0, x1, y1, hex) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (host.pixel(x, y) === hex) return true;
  return false;
}

const FS = 20, PAD = 8;
const input = createTextInput({ value: 'Hello World', width: 300, fontSize: FS, padding: PAD });
input.root.style.marginLeft = '20';
input.root.style.marginTop = '20';
document.body.appendChild(input.root);
host.render();

const left = input.root.offsetLeft + PAD;          // x of the text start
const y = input.root.offsetTop + PAD + FS / 2;     // vertical middle of the line
const xAt = (i) => left + measureText('Hello World'.slice(0, i), FS);

// --- click positions the caret ---
host.mouse('mousedown', xAt(5), y);
host.mouse('mouseup', xAt(5), y);
check('click positions the caret near index 5', Math.abs(input.getCaret() - 5) <= 1);
check('a plain click leaves no selection', input.getSelection() === null);

// --- drag selects a range ---
host.mouse('mousedown', xAt(0) + 1, y);
host.mouse('mousemove', xAt(5), y);
host.mouse('mouseup', xAt(5), y);
const sel = input.getSelection();
check('drag creates a selection starting at 0', sel && sel[0] === 0);
check('drag selection ends near index 5', sel && Math.abs(sel[1] - 5) <= 1);

// --- the selection highlight is painted behind the text ---
host.render();
check('selection highlight is drawn', findColor(left, y - 8, left + measureText('Hello', FS), y + 8, '#93C5FD'));

// --- typing replaces the selection ---
host.key('X');
check('typing replaces the selection', input.value === 'X World');
check('selection cleared after typing', input.getSelection() === null);

// --- arrow navigation + backspace + insertion ---
input.value = 'abc';                 // caret at end (3)
host.key('ArrowLeft');               // 2
host.key('ArrowLeft');               // 1
check('ArrowLeft moves the caret', input.getCaret() === 1);
host.key('Backspace');               // delete 'a' -> 'bc', caret 0
check('Backspace deletes before the caret', input.value === 'bc' && input.getCaret() === 0);
host.key('Z');                       // insert at 0 -> 'Zbc'
check('typing inserts at the caret', input.value === 'Zbc' && input.getCaret() === 1);

// --- selectAll + Delete clears everything ---
input.value = 'erase me';
input.selectAll();
host.key('Delete');
check('select-all then Delete clears the field', input.value === '');

input.value = 'Hello World';
host.key('Home');
host.key('ArrowRight', 'keydown', { shiftKey: true });
host.key('ArrowRight', 'keydown', { shiftKey: true });
check('Shift arrows preserve an anchor', JSON.stringify(input.getSelection()) === '[0,2]');
host.key('ArrowLeft');
check('plain Left collapses to the start without an extra step', input.getCaret() === 0 && input.getSelection() === null);
host.key('End', 'keydown', { shiftKey: true });
check('Shift End selects to the end', JSON.stringify(input.getSelection()) === '[0,11]');
host.key('ArrowRight');
check('plain Right collapses to the end', input.getCaret() === 11 && input.getSelection() === null);
host.key('Home', 'keydown', { shiftKey: true });
check('Shift Home selects back to the start', JSON.stringify(input.getSelection()) === '[0,11]');
host.key('ArrowRight', 'keydown', { shiftKey: true });
check('reverse Shift movement shrinks the same anchored range', JSON.stringify(input.getSelection()) === '[1,11]');
host.mouse('mousedown', xAt(5), y, { shiftKey: true });
host.mouse('mouseup', xAt(5), y, { shiftKey: true });
check('Shift click extends the existing keyboard anchor', JSON.stringify(input.getSelection()) === '[5,11]');

host.mouse('mousedown', xAt(0), y);
check('text drag acquires mouse capture', input.root.hasMouseCapture());
host.mouse('mousemove', 500, y, { buttons: 1 });
host.mouse('mouseup', 500, y);
check('outside-field drag and release select to the end and release capture',
  JSON.stringify(input.getSelection()) === '[0,11]' && !input.root.hasMouseCapture());
host.mouse('mousedown', xAt(0), y);
host.mouse('mousemove', xAt(5), y, { buttons: 1 });
host.mouse('mousecancel', 0, 0);
const cancelled = JSON.stringify(input.getSelection());
host.mouse('mousemove', 500, y);
host.mouse('mouseup', 500, y);
check('cancel ignores late motion and release', JSON.stringify(input.getSelection()) === cancelled && !input.root.hasMouseCapture());
host.mouse('mousedown', xAt(0), y);
document.body.removeChild(input.root);
document.body.appendChild(input.root);
host.render();
host.mouse('mousemove', 500, y);
host.mouse('mouseup', 500, y);
check('detach and reattach cannot resume selection', input.getCaret() === 0 && !input.root.hasMouseCapture());
host.mouse('mousedown', xAt(0), y);
input.root.blur();
host.mouse('mousemove', 500, y);
host.mouse('mouseup', 500, y);
check('blur terminates a captured selection', input.getCaret() === 0 && !input.root.hasMouseCapture());
host.mouse('mousedown', xAt(0), y);
host.key('Escape');
host.mouse('mousemove', 500, y); host.mouse('mouseup', 500, y);
check('Escape ends capture without swallowing application cancellation', input.getCaret() === 0 && !input.root.hasMouseCapture());

const viewport = document.createElement('view');
Object.assign(viewport.style, { position: 'absolute', left: 20, top: 100, width: 320, height: 60, overflow: 'scroll' });
const gap = document.createElement('view');
Object.assign(gap.style, { height: 100, flexShrink: 0 });
viewport.appendChild(gap); viewport.appendChild(input.root);
document.body.appendChild(viewport); viewport.scrollTop = 90; host.render();
const scrolled = input.root.getBoundingClientRect();
host.mouse('mousedown', scrolled.x + PAD + measureText('Hello', FS), scrolled.y + PAD + FS / 2);
host.mouse('mouseup', scrolled.x + PAD + measureText('Hello', FS), scrolled.y + PAD + FS / 2);
check('caret hit testing uses viewport geometry in a scrolled parent', input.getCaret() === 5);
input.value = 'a long line '.repeat(10);
input.root.focus(); host.key('End'); host.render();
check('long text scrolls the caret into the field', input.root.scrollLeft > 0);
host.key('Home'); host.render();
check('Home returns horizontal scroll to the start', input.root.scrollLeft === 0);

const limited = createTextInput({ maxLength: 128, value: 'a'.repeat(127) + '\u{1f642}x' });
document.body.appendChild(limited.root); limited.root.focus();
check('maxLength bounds initial code points without splitting a surrogate',
  limited.value === 'a'.repeat(127) + '\u{1f642}');
limited.value = 'tail';
host.key('Home', 'keydown', { text: false });
host.text('x'.repeat(200));
check('bounded middle insertion keeps the unselected suffix and insertion caret',
  limited.value === 'x'.repeat(124) + 'tail' && limited.getCaret() === 124 && limited.getSelection() === null);
host.key('Delete', 'keydown', { text: false });
check('Delete follows the bounded insertion caret rather than jumping to the end', limited.value === 'x'.repeat(124) + 'ail');
limited.selectAll(); host.text('\u{1f642}'.repeat(129));
check('selected text releases its code-point budget for the replacement',
  limited.value === '\u{1f642}'.repeat(128) && limited.getCaret() === 256);
limited.value = 'z'.repeat(129);
check('programmatic value assignment uses the same bound and existing end-caret semantics',
  limited.value.length === 128 && limited.getCaret() === 128);
for (const maxLength of [-1, 1.5, '128', null, NaN, Number.MAX_SAFE_INTEGER + 1]) {
  let rejected = false;
  try { createTextInput({ maxLength }); } catch (error) { rejected = error instanceof RangeError; }
  check('invalid maxLength is rejected: ' + String(maxLength), rejected);
}
input.value = 'unbounded'.repeat(30);
check('omitted maxLength preserves unbounded legacy input', input.value.length === 270);

if (measureText.supportsFontFamily === true) {
  const family = globalThis.namedTestFont || 'monospace', other = 'sans-serif', size = 20, value = 'WiWiWi';
  check('font-family measurement capability is readonly and nonconfigurable',
    Object.getOwnPropertyDescriptor(measureText, 'supportsFontFamily').writable === false &&
    Object.getOwnPropertyDescriptor(measureText, 'supportsFontFamily').configurable === false);
  for (const invalid of [null, 12, '', '/font.ttf', 'url(font)', 'Arial, serif', 'a'.repeat(129)]) {
    let rejected = false;
    try { measureText(value, size, 400, invalid); } catch (error) { rejected = error instanceof TypeError; }
    check('native named measurement rejects invalid literal family: ' + String(invalid), rejected);
  }
  const namedWidth = measureText(value, size, 400, family);
  check('named text uses a distinct installed face advance',
    Math.abs(namedWidth - measureText(value, size, 400, other)) > 1);
  const named = createTextInput({ value, width: 300, fontSize: size, fontFamily: family,
    selectionTextColor: '#ffffff' });
  const mixed = createTextInput({ value, width: 300, fontSize: size, fontFamily: other });
  document.body.appendChild(named.root); document.body.appendChild(mixed.root); host.render(); named.root.focus();
  const measured = document.createElement('view');
  Object.assign(measured.style, { fontFamily: family, fontSize: size, position: 'absolute', left: 0, top: 0 });
  measured.textContent = value; document.body.appendChild(measured); host.render();
  host.key('Home', 'keydown', { text: false });
  host.key('ArrowRight', 'keydown', { text: false }); host.render();
  const position = textGeometry(value, size, family).caret(1);
  console.log('NAMED_INPUT_METRICS ' + JSON.stringify({ family, size, value, namedWidth,
    defaultWidth: measureText(value, size, 400, other), renderedWidth: measured.offsetWidth,
    firstCaret: position, actualCaret: Number(named.root.childNodes[2].style.left) - 8,
    complexLayoutAvailable: typeof layoutText === 'function' }));
  check('named input caret follows its rendered font, not default Sans',
    Math.abs(Number(named.root.childNodes[2].style.left) - 8 - position) < 0.01 &&
    Math.abs(measured.offsetWidth - namedWidth) <= 1);
  host.key('ArrowRight', 'keydown', { shiftKey: true, text: false }); host.render();
  const selection = JSON.stringify(named.getSelection()), caret = named.getCaret();
  named.setAppearance({ fontFamily: other }); host.render();
  check('same input font change preserves value, caret and selection',
    named.value === value && named.getCaret() === caret && JSON.stringify(named.getSelection()) === selection &&
    document.activeElement === named.root && named.root.childNodes[1].style.fontFamily === other);
  check('selected full-string copy uses the same changed font',
    named.root.querySelector('.input-selection-text').firstChild.childNodes[1].style.fontFamily === other);
  named.setAppearance({ fontFamily: family }); host.render();
  const box = named.root.getBoundingClientRect();
  const x = box.x + 8 + textGeometry(value, size, family).caret(3);
  host.mouse('mousedown', x, box.y + 18); host.mouse('mouseup', x, box.y + 18);
  check('named-font hit testing lands on the actual glyph boundary', named.getCaret() === 3);
  check('two mixed-font instances and cached geometries stay isolated',
    mixed.root.childNodes[1].style.fontFamily === other &&
    textGeometry(value, size, other).width !== textGeometry(value, size, family).width);
  host.compose('pending', 7, 0); host.render(); named.setAppearance({ fontFamily: other });
  host.compose(''); host.text('x');
  check('font change preserves IME commit value semantics', named.value === 'WiWxiWi');
  named.root.blur();
  const originalMeasure = globalThis.measureText, originalLayout = globalThis.layoutText;
  const before = [named.value, named.getCaret(), named.root.childNodes[1].style.color];
  try {
    globalThis.measureText = () => 0; globalThis.layoutText = undefined;
    let rejected = false;
    try { named.setAppearance({ color: '#ff0000', fontFamily: family }); } catch (error) { rejected = /font-family-aware/.test(String(error)); }
    check('old providers reject a named input appearance before changing text, caret or DOM',
      rejected && JSON.stringify(before) === JSON.stringify([named.value, named.getCaret(), named.root.childNodes[1].style.color]));
    rejected = false;
    try { createTextInput({ value: 'old provider', fontFamily: family }); } catch (error) { rejected = /font-family-aware/.test(String(error)); }
    check('named input construction does not silently use an old default-family provider', rejected);
  } finally { globalThis.measureText = originalMeasure; globalThis.layoutText = originalLayout; }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) throw new Error('Text input assertions failed');
