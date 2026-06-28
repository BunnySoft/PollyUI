// naive5.mjs — Collapse, Menu, Steps, Spin, Popconfirm, Drawer, Table sort+select.

import { createApp, h } from './js/vue.mjs';
import { render } from './js/reconciler.mjs';
import {
  NCollapse, NMenu, NSteps, NSpin, NPopconfirm, NDrawer, NDataTable, NOverlayHost,
} from './js/naive.mjs';

let pass = 0, fail = 0;
function check(n, c) { if (c) { pass++; console.log('PASS: ' + n); } else { fail++; console.log('FAIL: ' + n); } }
const box = () => { const c = document.createElement('view'); c.style.padding = '12'; document.body.appendChild(c); return c; };
const full = () => { const c = document.createElement('view'); c.style.position = 'absolute'; c.style.width = '100%'; c.style.height = '100%'; document.body.appendChild(c); return c; };
const rgb = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
function findByText(root, txt) { if (root.nodeType === 1 && root.textContent === txt) return root; for (let c = root.firstChild; c; c = c.nextSibling) { const r = findByText(c, txt); if (r) return r; } return null; }
function hasColor(el, hex) { for (let y = 0; y < el.offsetHeight; y += 2) for (let x = 0; x < el.offsetWidth; x += 2) if (host.pixel(el.offsetLeft + x, el.offsetTop + y) === hex) return true; return false; }

// --- Collapse ---
const cc = box();
let exp = [];
const rc = () => render(NCollapse({ id: 'col', value: exp, onUpdate: e => { exp = e; rc(); host.render(); },
  items: [{ name: 'a', title: 'Section A', content: 'Body A' }, { name: 'b', title: 'Section B', content: 'Body B' }] }), cc);
rc(); host.render();
check('collapse starts collapsed', document.getElementById('col').textContent.indexOf('Body A') < 0);
const headerA = document.getElementById('col').firstChild.firstChild;
host.click(headerA.offsetLeft + 20, headerA.offsetTop + 15);
check('collapse expands on header click', document.getElementById('col').textContent.indexOf('Body A') >= 0);
host.click(headerA.offsetLeft + 20, headerA.offsetTop + 15);
check('collapse re-collapses', document.getElementById('col').textContent.indexOf('Body A') < 0);

// --- Menu ---
const mc = box();
let menuSel = 'home';
render(NMenu({ id: 'menu', value: 'home', onUpdate: k => menuSel = k, items: [{ key: 'home', label: 'Home' }, { key: 'settings', label: 'Settings' }] }), mc);
host.render();
const menu = document.getElementById('menu');
check('active menu item is tinted', host.pixel(menu.firstChild.offsetLeft + 5, menu.firstChild.offsetTop + 20) !== '#FFFFFF');
host.click(menu.childNodes[1].offsetLeft + 20, menu.childNodes[1].offsetTop + 20);
check('menu click updates selection', menuSel === 'settings');

// --- Steps ---
const sc = box();
render(NSteps({ id: 'steps', current: 1, steps: [{ title: 'One' }, { title: 'Two' }, { title: 'Three' }] }), sc);
host.render();
const steps = document.getElementById('steps');
check('steps render titles', steps.textContent.indexOf('One') >= 0 && steps.textContent.indexOf('Three') >= 0);
check('completed step shows a check', steps.textContent.indexOf('✓') >= 0);
check('done step circle is primary', host.pixel(steps.firstChild.firstChild.offsetLeft + 5, steps.firstChild.firstChild.offsetTop + 14) === '#18A058');

// --- Spin ---
const spc = box();
render(NSpin({ id: 'spin', size: 32, color: '#18a058' }), spc);
host.render();
check('spinner renders primary dots', hasColor(document.getElementById('spin'), '#18A058'));

// --- DataTable: selection ---
const tc2 = box();
let selKeys = [];
const rt = () => render(NDataTable({ id: 'tbl2', selectable: true, selectedKeys: selKeys, onSelectionChange: k => { selKeys = k; rt(); host.render(); },
  rowKey: (r) => r.name, columns: [{ title: 'Name', key: 'name' }], data: [{ name: 'X' }, { name: 'Y' }] }), tc2);
rt(); host.render();
const tbl2 = document.getElementById('tbl2');
const cbCell = tbl2.childNodes[2].firstChild;   // [header, divider, row0]; row0.firstChild = checkbox cell
host.click(cbCell.offsetLeft + 22, cbCell.offsetTop + 20);
check('row selection toggles a key', selKeys.length === 1 && selKeys[0] === 'X');
const hdrCb = tbl2.firstChild.firstChild;        // header checkbox cell
host.click(hdrCb.offsetLeft + 22, hdrCb.offsetTop + 20);
check('select-all selects every row', selKeys.length === 2);

// --- DataTable: sort ---
const tc3 = box();
let sortState = null;
render(NDataTable({ id: 'tbl3', sortBy: null, sortOrder: null, onSort: (k, o) => sortState = [k, o],
  columns: [{ title: 'Name', key: 'name', sortable: true }], data: [{ name: 'A' }] }), tc3);
host.render();
const hdr = document.getElementById('tbl3').firstChild.firstChild;
host.click(hdr.offsetLeft + 20, hdr.offsetTop + 15);
check('sortable header reports a sort', sortState && sortState[0] === 'name' && sortState[1] === 'asc');

// --- Drawer ---
const stage = document.createElement('view');
stage.style.width = '400'; stage.style.height = '300'; stage.style.position = 'absolute'; stage.style.top = '0'; stage.style.left = '0';
document.body.appendChild(stage);
render(NDrawer({ show: true, title: 'Details', width: 200, placement: 'right' }, h('view', { style: { color: '#333639' } }, 'drawer body')), stage);
host.render();
check('drawer panel sits on the right (white card)', rgb(host.pixel(stage.offsetLeft + 350, stage.offsetTop + 150))[0] > 240);
check('drawer dims the rest with a backdrop', rgb(host.pixel(stage.offsetLeft + 50, stage.offsetTop + 150))[0] < 160);
check('drawer renders its body', stage.textContent.indexOf('drawer body') >= 0);

// --- Popconfirm (overlay) ---
let confirmed = false;
const App = { setup() {
  return () => h('view', { style: { width: '100%', height: '100%' } },
    h('view', { style: { padding: '20' } },
      NPopconfirm({ title: 'Delete this?', onConfirm: () => confirmed = true },
        h('view', { id: 'pctrig', style: { width: '80', height: '32', backgroundColor: '#eeeeee' } }, 'Delete'))),
    NOverlayHost());
} };
createApp(App).mount(full());
document.body.style.width = '100%'; document.body.style.height = '100%';
host.render();
const pctrig = document.getElementById('pctrig');
host.click(pctrig.offsetLeft + 40, pctrig.offsetTop + 16);
check('popconfirm opens on click', document.body.textContent.indexOf('Delete this?') >= 0);
const yes = findByText(document.body, 'Yes');
host.click(yes.offsetLeft + yes.offsetWidth / 2, yes.offsetTop + yes.offsetHeight / 2);
check('popconfirm confirm fires + closes', confirmed && document.body.textContent.indexOf('Delete this?') < 0);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
