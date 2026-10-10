// naive4.mjs — Pagination, DataTable, Avatar, Badge, Dropdown, DatePicker, Message.

import { ref, createApp, h } from './gui/sdk/js/vue.mjs';
import { render } from './gui/sdk/js/reconciler.mjs';
import {
  NPagination, NDataTable, NAvatar, NBadge, NDropdown, NDatePicker, NOverlayHost,
  message, formatDate,
} from './gui/sdk/js/naive.mjs';

let pass = 0, fail = 0;
function check(n, c) { if (c) { pass++; console.log('PASS: ' + n); } else { fail++; console.log('FAIL: ' + n); } }
const box = () => { const c = document.createElement('view'); c.style.padding = '12'; document.body.appendChild(c); return c; };
const fullScreen = () => { const c = document.createElement('view'); c.style.position = 'absolute'; c.style.width = '100%'; c.style.height = '100%'; document.body.appendChild(c); return c; };
function findByText(root, txt) {
  if (root.nodeType === 1 && root.textContent === txt) return root;
  for (let c = root.firstChild; c; c = c.nextSibling) { const r = findByText(c, txt); if (r) return r; }
  return null;
}

// --- formatDate (pure) ---
check('formatDate pads month/day', formatDate(new Date(2024, 1, 5)) === '2024-02-05');

// --- Pagination ---
const pc = box();
let pg = 2;
render(NPagination({ id: 'pg', page: 2, pageCount: 3, onUpdate: p => pg = p }), pc);
host.render();
const pgEl = document.getElementById('pg');
const pk = pgEl.childNodes;     // [‹, 1, 2, 3, ›]
check('active page is highlighted', host.pixel(pk[2].offsetLeft + 3, pk[2].offsetTop + 16) === '#18A058');
host.click(pk[3].offsetLeft + 10, pk[3].offsetTop + 16);   // click "3"
check('clicking a page reports it', pg === 3);
host.click(pk[0].offsetLeft + 8, pk[0].offsetTop + 16);    // prev at page 2... still 3 in state? prev disabled only at page 1
check('prev moves back', pg === 1);

// --- DataTable ---
const tc = box();
render(NDataTable({ id: 'tbl', columns: [{ title: 'Name', key: 'name' }, { title: 'Age', key: 'age' }], data: [{ name: 'Alice', age: 30 }, { name: 'Bob', age: 25 }] }), tc);
host.render();
const tbl = document.getElementById('tbl');
check('table renders headers', tbl.textContent.indexOf('Name') >= 0 && tbl.textContent.indexOf('Age') >= 0);
check('table renders row data', tbl.textContent.indexOf('Alice') >= 0 && tbl.textContent.indexOf('Bob') >= 0 && tbl.textContent.indexOf('30') >= 0);

// --- Avatar ---
const ac = box();
render(NAvatar({ id: 'av', size: 40, color: '#2080f0' }, 'AB'), ac);
host.render();
const av = document.getElementById('av');
check('avatar shows initials', av.textContent === 'AB');
check('avatar uses its color', host.pixel(av.offsetLeft + 6, av.offsetTop + 20) === '#2080F0');

// --- Badge ---
const bc = box();
render(NBadge({ id: 'bd', value: 5 }, h('view', { style: { width: '40', height: '40', backgroundColor: '#cccccc' } })), bc);
host.render();
check('badge shows the count', document.getElementById('bd').textContent === '5');

// --- Dropdown (overlay) ---
let lastPick = null;
const ddApp = { setup() {
  return () => h('view', { style: { width: '100%', height: '100%' } },
    h('view', { style: { padding: '20' } },
      NDropdown({ options: [{ key: 'edit', label: 'Edit' }, { key: 'del', label: 'Delete' }], width: 140, onSelect: k => lastPick = k },
        h('view', { id: 'ddtrig', style: { width: '80', height: '32', backgroundColor: '#eeeeee' } }, 'Menu'))),
    NOverlayHost());
} };
createApp(ddApp).mount(fullScreen());
document.body.style.width = '100%'; document.body.style.height = '100%';
host.render();
const trig = document.getElementById('ddtrig');
host.click(trig.offsetLeft + 40, trig.offsetTop + 16);     // open menu
check('dropdown opens a menu', document.body.textContent.indexOf('Edit') >= 0 && document.body.textContent.indexOf('Delete') >= 0);
host.click(trig.offsetLeft + 70, trig.offsetTop + trig.offsetHeight + 24);  // click "Edit"
check('dropdown item selects + closes', lastPick === 'edit' && document.body.textContent.indexOf('Delete') < 0);

// --- DatePicker (overlay) ---
let lastDate = null;
const dpApp = { setup() {
  const date = ref(null);
  return () => h('view', { style: { width: '100%', height: '100%' } },
    h('view', { style: { padding: '20' } },
      NDatePicker({ id: 'dp', value: date.value, onUpdate: d => { date.value = d; lastDate = d; } })),
    NOverlayHost());
} };
createApp(dpApp).mount(fullScreen());
host.render();
const dp = document.getElementById('dp');
host.click(dp.offsetLeft + 20, dp.offsetTop + 17);          // open calendar
check('date picker opens a calendar', document.body.textContent.indexOf('Jan 2024') >= 0);
const cell = findByText(document.body, '15');
host.click(cell.offsetLeft + cell.offsetWidth / 2, cell.offsetTop + cell.offsetHeight / 2);  // pick the 15th
check('picking a day reports the date', lastDate && formatDate(lastDate) === '2024-01-15');

// --- Message toast (overlay) ---
const msgApp = { setup() { return () => h('view', { style: { width: '100%', height: '100%' } }, NOverlayHost()); } };
createApp(msgApp).mount(fullScreen());
message.success('Saved!', 0);     // duration 0 => no auto-dismiss timer
host.flush();                     // run the batched re-render
host.render();
check('message shows a toast', document.body.textContent.indexOf('Saved!') >= 0);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
