// uifix.mjs — visible scrollbar on overflow:scroll + blinking caret in NInput.

import { ref, createApp, h } from './gui/sdk/js/vue.mjs';
import { render } from './gui/sdk/js/reconciler.mjs';
import { NInput, NOverlayHost } from './gui/sdk/js/naive.mjs';

let pass = 0, fail = 0;
function check(n, c) { if (c) { pass++; console.log('PASS: ' + n); } else { fail++; console.log('FAIL: ' + n); } }
const rgb = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];

// --- native scrollbar thumb on an overflow:scroll container ---
const s1 = document.createElement('view'); s1.style.position = 'absolute'; s1.style.top = '0'; s1.style.left = '0'; document.body.appendChild(s1);
const scroller = document.createElement('view');
scroller.style.width = '200'; scroller.style.height = '120'; scroller.style.overflow = 'scroll'; scroller.style.backgroundColor = '#ffffff';
s1.appendChild(scroller);
for (let i = 0; i < 12; i++) { const row = document.createElement('view'); row.style.height = '30'; row.style.backgroundColor = '#ffffff'; scroller.appendChild(row); }  // 360px content in 120px box
host.render();
// thumb is at x ~ right-8 .. right-3, vertically near the top (scrollTop 0). Sample at the right edge mid-top.
let thumbFound = false;
for (let y = 2; y < 60; y++) { const c = rgb(host.pixel(scroller.offsetLeft + 200 - 5, scroller.offsetTop + y)); if (c[0] > 150 && c[0] < 230 && Math.abs(c[0] - c[1]) < 12 && Math.abs(c[1] - c[2]) < 12) { thumbFound = true; break; } }
check('overflow:scroll shows a scrollbar thumb', thumbFound);
// and no thumb when content fits
const fit = document.createElement('view'); fit.style.width = '200'; fit.style.height = '120'; fit.style.overflow = 'scroll'; fit.style.backgroundColor = '#ffffff';
const small = document.createElement('view'); small.style.height = '30'; small.style.backgroundColor = '#ffffff'; fit.appendChild(small);
const s1b = document.createElement('view'); s1b.style.position = 'absolute'; s1b.style.top = '0'; s1b.style.left = '300'; document.body.appendChild(s1b); s1b.appendChild(fit);
host.render();
let noThumb = true;
for (let y = 2; y < 118; y++) { const c = rgb(host.pixel(fit.offsetLeft + 200 - 5, fit.offsetTop + y)); if (c[0] > 150 && c[0] < 230 && Math.abs(c[0] - c[1]) < 12) { noThumb = false; break; } }
check('no scrollbar when content fits', noThumb);
document.body.removeChild(s1); document.body.removeChild(s1b);

// --- blinking caret in a focused NInput ---
const appC = document.createElement('view'); appC.style.position = 'absolute'; appC.style.top = '0'; appC.style.left = '0'; appC.style.width = '100%'; appC.style.height = '100%'; document.body.appendChild(appC);
const value = ref('Hi');
createApp({ setup() { return () => h('view', { style: { width: '100%', height: '100%' } },
  h('view', { style: { padding: '20' } }, NInput({ id: 'inp', value: value.value, onInput: x => value.value = x, width: 200 })), NOverlayHost()); } }).mount(appC);
host.render();
const inp = document.getElementById('inp');
check('unfocused input has no caret (text only)', inp.childNodes.length === 1);
host.click(inp.offsetLeft + 30, inp.offsetTop + 17);   // focus
check('focused input shows a caret', document.getElementById('inp').childNodes.length === 2);
host.key('!');
check('typing into the focused input works', document.getElementById('inp').textContent.indexOf('Hi!') >= 0);
host.click(700, 540);   // click empty area -> blur
check('blurred input drops the caret', document.getElementById('inp').childNodes.length === 1);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
