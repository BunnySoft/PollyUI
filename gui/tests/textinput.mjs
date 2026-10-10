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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
