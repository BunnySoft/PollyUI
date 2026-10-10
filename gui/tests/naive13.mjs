// naive13.mjs — Wave 6: Code (monospace font-family) + GradientText.

import { h } from './gui/sdk/js/vue.mjs';
import { render } from './gui/sdk/js/reconciler.mjs';
import { NCode, NGradientText } from './gui/sdk/js/naive.mjs';

let pass = 0, fail = 0;
function check(n, c) { if (c) { pass++; console.log('PASS: ' + n); } else { fail++; console.log('FAIL: ' + n); } }
const box = () => { const c = document.createElement('view'); c.style.padding = '12'; document.body.appendChild(c); return c; };
const rgb = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
function scan(x0, x1, y0, y1, pred) { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const p = host.pixel(x, y); if (p !== '#FFFFFF' && pred(rgb(p))) return true; } return false; }

// Code renders its text + a code block background
render(NCode({ id: 'code' }, 'const x = 42;'), box());
host.render();
check('code renders its text', document.getElementById('code').textContent === 'const x = 42;');

// monospace: 'iiii' and 'MMMM' measure to the same width (proportional fonts differ)
render(h('view', { style: { flexDirection: 'row', gap: '20' } }, NCode({ id: 'c1' }, 'iiii'), NCode({ id: 'c2' }, 'MMMM')), box());
host.render();
// monospace: 'M' is ~3x 'i' in a proportional font; equal width => monospace
check('monospace makes iiii and MMMM equal width', Math.abs(document.getElementById('c1').offsetWidth - document.getElementById('c2').offsetWidth) <= 2);

// GradientText: red on the left, blue on the right (over the actual text ink span)
render(NGradientText({ id: 'gt', from: '#ff0000', to: '#0000ff', fontSize: 40 }, 'WWWWWWWW'), box());
host.render();
const gt = document.getElementById('gt');
const y0 = gt.offsetTop, y1 = gt.offsetTop + 44;
let lo = -1, hi = -1;
for (let x = gt.offsetLeft; x < gt.offsetLeft + 500; x++) { let ink = false; for (let y = y0; y < y1; y++) if (host.pixel(x, y) !== '#FFFFFF') { ink = true; break; } if (ink) { if (lo < 0) lo = x; hi = x; } }
const span = hi - lo;
check('gradient text is reddish on the left', scan(lo, lo + span / 3, y0, y1, c => c[0] > c[2] + 40));
check('gradient text is bluish on the right', scan(hi - span / 3, hi + 1, y0, y1, c => c[2] > c[0] + 40));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
