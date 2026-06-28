// naive11.mjs — Wave 5a: Scrollbar + VirtualList (wheel deltaY).

import { h } from './js/vue.mjs';
import { render } from './js/reconciler.mjs';
import { NScrollbar, NVirtualList } from './js/naive.mjs';

let pass = 0, fail = 0;
function check(n, c) { if (c) { pass++; console.log('PASS: ' + n); } else { fail++; console.log('FAIL: ' + n); } }
// on-screen container at the viewport origin
const stage = () => { const c = document.createElement('view'); c.style.position = 'absolute'; c.style.top = '0'; c.style.left = '0'; c.style.padding = '12'; document.body.appendChild(c); return c; };

// --- Scrollbar: tall content clipped + wheel scrolls it ---
const s1 = stage(); let sbTop = 0;
const tallContent = h('view', { style: { flexDirection: 'column' } },
  h('view', { style: { height: '40', backgroundColor: '#ff0000' } }),    // row 0  (visible at top)
  h('view', { style: { height: '40', backgroundColor: '#00ff00' } }),    // row 1
  h('view', { style: { height: '40', backgroundColor: '#0000ff' } }),    // row 2
  h('view', { style: { height: '40', backgroundColor: '#ffff00' } }));   // row 3
const rsb = () => render(NScrollbar({ id: 'sb', width: 200, height: 80, contentHeight: 160, scrollTop: sbTop, onScroll: v => { sbTop = v; rsb(); host.render(); } }, tallContent), s1);
rsb(); host.render();
const sb = document.getElementById('sb');
check('scrollbar shows the top of content (red)', host.pixel(sb.offsetLeft + 10, sb.offsetTop + 10) === '#FF0000');
check('scrollbar clips content past its height', host.pixel(sb.offsetLeft + 10, sb.offsetTop + 70) === '#00FF00');
host.scroll(sb.offsetLeft + 10, sb.offsetTop + 40, 80);   // wheel down by 80
check('wheel scrolls (onScroll updated scrollTop)', sbTop === 80);
check('after scroll, the blue row shows at top', host.pixel(document.getElementById('sb').offsetLeft + 10, document.getElementById('sb').offsetTop + 10) === '#0000FF');

// --- VirtualList: only a window of rows is in the DOM ---
const s2 = stage();
const N = 1000;
const items = Array.from({ length: N }, (_, i) => 'Row ' + i);
let vlTop = 0;
const rvl = () => render(NVirtualList({ id: 'vl', width: 240, items, itemHeight: 30, height: 150, scrollTop: vlTop, onScroll: v => { vlTop = v; rvl(); host.render(); }, renderItem: (it) => h('view', { style: { color: '#000000', fontSize: '13' } }, it) }), s2);
rvl(); host.render();
const vl = document.getElementById('vl');
const renderedCount = vl.firstChild.childNodes.length;  // the absolute-positioned window
check('virtual list renders only a window, not all 1000', renderedCount > 0 && renderedCount < 30);
check('virtual list starts at row 0', vl.textContent.indexOf('Row 0') >= 0 && vl.textContent.indexOf('Row 500') < 0);
host.scroll(vl.offsetLeft + 10, vl.offsetTop + 40, 15000);   // wheel far down
check('virtual list windows to a deep range after scroll', document.getElementById('vl').textContent.indexOf('Row 0') < 0 && document.getElementById('vl').textContent.indexOf('Row 4') >= 0);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
