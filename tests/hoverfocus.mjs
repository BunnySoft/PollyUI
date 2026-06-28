// hoverfocus.mjs — engine-level :hover / :focus style overrides.
// A node carries hoverStyle/focusStyle; the native renderer applies them when
// the bridge marks the node hovered/focused (no JS re-render involved).

import { h, render } from './js/reconciler.mjs';
import { NButton, NInput, theme } from './js/naive.mjs';

let pass = 0, fail = 0;
function check(n, c) { if (c) { pass++; console.log('PASS: ' + n); } else { fail++; console.log('FAIL: ' + n); } }

// red box that turns blue on hover; green focusable box that turns yellow on focus
const box  = h('view', { style: { position: 'absolute', left: '20',  top: '20', width: '100', height: '100', backgroundColor: '#ff0000' }, hoverStyle: { backgroundColor: '#0000ff' } });
const fbox = h('view', { tabIndex: 0, style: { position: 'absolute', left: '140', top: '20', width: '100', height: '100', backgroundColor: '#00ff00' }, focusStyle: { backgroundColor: '#ffff00' } });
render(h('view', { style: { width: '100%', height: '100%' } }, box, fbox), document.body);
document.body.style.width = '100%'; document.body.style.height = '100%';
host.render();

// --- hover ---
check('box base is red',           host.pixel(70, 70) === '#FF0000');
host.mouse('mousemove', 70, 70);
check('box turns blue on hover',   host.pixel(70, 70) === '#0000FF');
host.mouse('mousemove', 400, 400);
check('box back to red on leave',  host.pixel(70, 70) === '#FF0000');

// --- focus ---
check('fbox base is green',        host.pixel(190, 70) === '#00FF00');
host.click(190, 70);
check('fbox turns yellow on focus',host.pixel(190, 70) === '#FFFF00');
host.click(400, 400);
check('fbox back to green on blur',host.pixel(190, 70) === '#00FF00');

// --- a real component: NButton primary lightens on hover ---
const root2 = document.createElement('view'); root2.style.position = 'absolute'; root2.style.top = '200'; root2.style.left = '0';
document.body.appendChild(root2);
render(NButton({ type: 'primary', id: 'gob' }, 'Go'), root2);
host.render();
const btn = document.getElementById('gob');
const bx = btn.offsetLeft + Math.floor(btn.offsetWidth / 2);
const by = btn.offsetTop + 4; // near the top edge, inside the fill but above the text glyphs
const base = host.pixel(bx, by);
host.mouse('mousemove', bx, by);
const hov = host.pixel(bx, by);
check('NButton primary has a colored fill', base !== '#FFFFFF' && base !== '#F5F7FA' && base !== '#000000');
check('NButton fill lightens on hover (differs from base)', hov !== base);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
