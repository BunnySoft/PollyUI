// inputcaret.mjs — NInput click-to-position caret, drag-to-select, editing;
// plus a nested overflow:scroll scrollbar.

import { ref, createApp, h } from './js/vue.mjs';
import { render } from './js/reconciler.mjs';
import { NInput, NOverlayHost } from './js/naive.mjs';

let pass = 0, fail = 0;
function check(n, c) { if (c) { pass++; console.log('PASS: ' + n); } else { fail++; console.log('FAIL: ' + n); } }
const full = () => { const c = document.createElement('view'); c.style.position = 'absolute'; c.style.top = '0'; c.style.left = '0'; c.style.width = '100%'; c.style.height = '100%'; document.body.appendChild(c); return c; };
const rgb = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
function findColor(x0, x1, y0, y1, hex) { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (host.pixel(x, y) === hex) return true; return false; }

let val = '';
createApp({ setup() { const v = ref('Hello World'); val = v.value;
  return () => h('view', { style: { width: '100%', height: '100%' } },
    h('view', { style: { padding: '20' } }, NInput({ id: 'inp', value: v.value, onInput: x => { v.value = x; val = x; }, width: 260 })), NOverlayHost()); } }).mount(full());
host.render();

const inp = document.getElementById('inp');
const pad = 12, y = inp.offsetTop + 17;
const xAt = (s, i) => inp.offsetLeft + pad + measureText(s.slice(0, i), 14);

// drag-select "Hello"
host.mouse('mousedown', xAt('Hello World', 0) + 2, y);
host.mouse('mousemove', xAt('Hello World', 5), y);
host.mouse('mouseup', xAt('Hello World', 5), y);
host.render();
check('drag-select shows a selection highlight', findColor(inp.offsetLeft + pad, xAt('Hello World', 5), inp.offsetTop + 6, inp.offsetTop + 28, '#93C5FD'));
host.key('Z');
check('typing replaces the selection', val === 'Z World');

// click to position the caret at index 3 of "Z World", then insert
host.click(xAt('Z World', 3), y);
host.key('!');
check('click repositions the caret (insert at 3)', val === 'Z W!orld');

// Arrow + Backspace
host.key('Home');            // caret 0
host.key('ArrowRight');      // caret 1
host.key('Backspace');       // delete char before caret (the 'Z')
check('Home/Arrow/Backspace edit at the caret', val === ' W!orld');

// caret element present while focused
check('focused input renders a caret element', document.getElementById('inp').childNodes.length >= 2);

// --- nested overflow:scroll scrollbars (outer + inner both get a thumb) ---
const sc = document.createElement('view'); sc.style.position = 'absolute'; sc.style.top = '0'; sc.style.left = '300';
document.body.appendChild(sc);
const outer = document.createElement('view'); outer.style.width = '220'; outer.style.height = '160'; outer.style.overflow = 'scroll'; outer.style.backgroundColor = '#ffffff';
sc.appendChild(outer);
const spacer = document.createElement('view'); spacer.style.height = '80'; spacer.style.backgroundColor = '#ffffff'; outer.appendChild(spacer);
const inner = document.createElement('view'); inner.style.width = '180'; inner.style.height = '120'; inner.style.overflow = 'scroll'; inner.style.backgroundColor = '#ffffff';
outer.appendChild(inner);
for (let i = 0; i < 8; i++) { const r = document.createElement('view'); r.style.height = '30'; r.style.backgroundColor = '#ffffff'; inner.appendChild(r); }  // 240 in 120
const tail = document.createElement('view'); tail.style.height = '200'; tail.style.backgroundColor = '#ffffff'; outer.appendChild(tail);  // outer content 80+120+200=400 in 160
host.render();
// outer thumb near outer's right edge
let outerThumb = false;
for (let yy = 2; yy < 80; yy++) { const c = rgb(host.pixel(outer.offsetLeft + 220 - 5, outer.offsetTop + yy)); if (c[0] > 150 && c[0] < 230 && Math.abs(c[0] - c[1]) < 12) { outerThumb = true; break; } }
check('outer scroll container shows a scrollbar', outerThumb);
// inner thumb near inner's right edge (inner is at outer top+80)
let innerThumb = false;
for (let yy = 2; yy < 110; yy++) { const c = rgb(host.pixel(inner.offsetLeft + 180 - 5, inner.offsetTop + yy)); if (c[0] > 150 && c[0] < 230 && Math.abs(c[0] - c[1]) < 12) { innerThumb = true; break; } }
check('nested (inner) scroll container also shows a scrollbar', innerThumb);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
