// naive6.mjs — Tree, Transfer, Calendar, Upload, Cascader.

import { ref, createApp, h } from './gui/sdk/js/vue.mjs';
import { render } from './gui/sdk/js/reconciler.mjs';
import { NTree, NTransfer, NCalendar, NUpload, NCascader, NOverlayHost, formatDate } from './gui/sdk/js/naive.mjs';

let pass = 0, fail = 0;
function check(n, c) { if (c) { pass++; console.log('PASS: ' + n); } else { fail++; console.log('FAIL: ' + n); } }
const box = () => { const c = document.createElement('view'); c.style.padding = '12'; document.body.appendChild(c); return c; };
const full = () => { const c = document.createElement('view'); c.style.position = 'absolute'; c.style.width = '100%'; c.style.height = '100%'; document.body.appendChild(c); return c; };
function findByText(root, txt) { if (root.nodeType === 1 && root.textContent === txt) return root; for (let c = root.firstChild; c; c = c.nextSibling) { const r = findByText(c, txt); if (r) return r; } return null; }
const clickCenter = (el) => host.click(el.offsetLeft + el.offsetWidth / 2, el.offsetTop + el.offsetHeight / 2);

// --- Tree ---
const tc = box();
let tExp = [], tSel = [];
const td = [{ key: '1', label: 'Fruits', children: [{ key: '1-1', label: 'Apple' }, { key: '1-2', label: 'Banana' }] }, { key: '2', label: 'Veggies', children: [{ key: '2-1', label: 'Carrot' }] }];
const rtree = () => render(NTree({ id: 'tree', data: td, expandedKeys: tExp, selectedKeys: tSel,
  onExpand: e => { tExp = e; rtree(); host.render(); }, onSelect: s => { tSel = s; rtree(); host.render(); } }), tc);
rtree(); host.render();
check('tree shows roots', document.getElementById('tree').textContent.indexOf('Fruits') >= 0);
check('tree children hidden initially', document.getElementById('tree').textContent.indexOf('Apple') < 0);
const arrow = document.getElementById('tree').firstChild.firstChild;   // Fruits row's expand arrow
host.click(arrow.offsetLeft + 9, arrow.offsetTop + 9);
check('tree expands to reveal children', document.getElementById('tree').textContent.indexOf('Apple') >= 0);
const appleRow = document.getElementById('tree').childNodes[1];        // [Fruits, Apple, Banana, Veggies]
host.click(appleRow.offsetLeft + 50, appleRow.offsetTop + 16);
check('tree selects a node', tSel[0] === '1-1');

// --- Transfer ---
const trc = box();
let tk = [];
const rtr = () => render(NTransfer({ id: 'tr', data: [{ key: 'a', label: 'Alpha' }, { key: 'b', label: 'Beta' }, { key: 'c', label: 'Gamma' }], targetKeys: tk, onChange: k => { tk = k; rtr(); host.render(); } }), trc);
rtr(); host.render();
const alpha = findByText(document.getElementById('tr'), 'Alpha');
clickCenter(alpha);
check('transfer moves an item to target', tk.length === 1 && tk[0] === 'a');
const beta = findByText(document.getElementById('tr'), 'Beta');
clickCenter(beta);
check('transfer moves a second item', tk.length === 2 && tk.indexOf('b') >= 0);

// --- Calendar ---
const cc2 = box();
let calDate = null, calView = { year: 2024, month: 0 };
const rcal = () => render(NCalendar({ id: 'cal', value: calDate, view: calView, onUpdate: d => { calDate = d; },
  onNav: delta => { calView = { year: calView.year, month: calView.month + delta }; if (calView.month < 0) { calView.month = 11; calView.year--; } if (calView.month > 11) { calView.month = 0; calView.year++; } rcal(); host.render(); } }), cc2);
rcal(); host.render();
check('calendar shows the month', document.getElementById('cal').textContent.indexOf('Jan 2024') >= 0);
clickCenter(findByText(document.getElementById('cal'), '15'));
check('calendar picks a day', calDate && formatDate(calDate) === '2024-01-15');
clickCenter(findByText(document.getElementById('cal'), '›'));
check('calendar navigates to next month', document.getElementById('cal').textContent.indexOf('Feb 2024') >= 0);

// --- Upload ---
const uc = box();
render(NUpload({ id: 'up', fileList: [{ name: 'report.pdf' }, { name: 'photo.png' }] }), uc);
host.render();
const up = document.getElementById('up');
check('upload shows the dropzone', up.textContent.indexOf('Click to upload') >= 0);
check('upload lists the files', up.textContent.indexOf('report.pdf') >= 0 && up.textContent.indexOf('photo.png') >= 0);
let triggered = false;
const uc2 = full();   // on-screen at (0,0); a stacked box() would be below the viewport
render(NUpload({ id: 'up2', fileList: [], onTrigger: () => triggered = true }), uc2);
host.render();
const dz = document.getElementById('up2').firstChild;
clickCenter(dz);
check('upload dropzone click triggers', triggered);

// --- Cascader (overlay, drill-down) ---
let cascVal = null;
const App = { setup() {
  const v = ref([]);
  return () => h('view', { style: { width: '100%', height: '100%' } },
    h('view', { style: { padding: '20' } },
      NCascader({ id: 'casc', value: v.value, width: 200,
        options: [
          { value: 'asia', label: 'Asia', children: [{ value: 'cn', label: 'China', children: [{ value: 'bj', label: 'Beijing' }, { value: 'sh', label: 'Shanghai' }] }, { value: 'jp', label: 'Japan' }] },
          { value: 'eu', label: 'Europe', children: [{ value: 'fr', label: 'France' }] }],
        onUpdate: p => { v.value = p; cascVal = p; } })),
    NOverlayHost());
} };
createApp(App).mount(full());
document.body.style.width = '100%'; document.body.style.height = '100%';
host.render();
const casc = document.getElementById('casc');
host.click(casc.offsetLeft + 20, casc.offsetTop + 17);
check('cascader opens the first column', document.body.textContent.indexOf('Asia') >= 0 && document.body.textContent.indexOf('Europe') >= 0);
clickCenter(findByText(document.body, 'Asia'));
check('cascader drills into children', document.body.textContent.indexOf('China') >= 0 && document.body.textContent.indexOf('Japan') >= 0);
clickCenter(findByText(document.body, 'China'));
check('cascader shows the third level', document.body.textContent.indexOf('Beijing') >= 0);
clickCenter(findByText(document.body, 'Beijing'));
// 'Shanghai' only ever appears in the popup, so its absence proves it closed
// (the trigger now shows the selected path "Asia / China / Beijing").
check('cascader selects a leaf path + closes', cascVal && cascVal.join('/') === 'asia/cn/bj' && document.body.textContent.indexOf('Shanghai') < 0);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
