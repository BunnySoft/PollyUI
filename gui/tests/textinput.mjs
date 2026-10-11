// textinput.mjs — click-to-position caret, drag-to-select, edit-with-selection.

import { createTextInput } from './gui/sdk/js/textinput.mjs';

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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) throw new Error('Text input assertions failed');
