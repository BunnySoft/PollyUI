// naive2.mjs — dark theme + the new components (checkbox/radio/slider/tabs/
// progress/alert/modal).

import { h } from './js/vue.mjs';
import { render } from './js/reconciler.mjs';
import {
  NButton, NCheckbox, NRadioGroup, NSlider, NTabs, NProgress, NAlert, NModal,
  theme, useTheme,
} from './js/naive.mjs';

let pass = 0, fail = 0;
function check(n, c) { if (c) { pass++; console.log('PASS: ' + n); } else { fail++; console.log('FAIL: ' + n); } }
const fillAt = (el) => host.pixel(el.offsetLeft + 3, el.offsetTop + el.offsetHeight / 2);
const at = (el, dx, dy) => host.pixel(el.offsetLeft + dx, el.offsetTop + dy);
const rgb = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
const fresh = () => { const c = document.createElement('view'); c.style.padding = '10'; document.body.appendChild(c); return c; };

// --- dark theme ---
useTheme('dark');
check('useTheme(dark) sets dark tokens', theme.body === '#101014' && theme.primary === '#63e2b7');
const dc = fresh();
render(h('view', {}, NButton({ type: 'primary', id: 'db' }, 'Dark')), dc);
host.render();
check('dark primary button uses the dark green', fillAt(document.getElementById('db')) === '#63E2B7');
useTheme('light'); // back to light for the rest

// --- checkbox ---
const cb = fresh();
render(h('view', { style: { gap: '8' } },
  NCheckbox({ checked: true, id: 'cbY' }, 'on'),
  NCheckbox({ checked: false, id: 'cbN' }, 'off')), cb);
host.render();
const boxY = document.getElementById('cbY').firstChild;  // the box (first child of the row)
const boxN = document.getElementById('cbN').firstChild;
check('checked checkbox box is primary', at(boxY, 9, 9) === '#18A058');
check('unchecked checkbox box is white', at(boxN, 9, 9) === '#FFFFFF');

// --- radio group ---
const rg = fresh();
render(NRadioGroup({ value: 'b', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }), rg);
host.render();
// the selected radio (B) has a primary inner dot; the first row is A (unselected)
const rows = rg.firstChild.childNodes;
const dotB = rows[1].firstChild; // radio circle of option B
check('selected radio has a primary dot', at(dotB, 9, 9) === '#18A058');

// --- slider: click sets the value ---
const sc = fresh();
let sliderVal = null;
render(NSlider({ value: 0, width: 200, id: 'sld', onUpdate: v => sliderVal = v }), sc);
host.render();
const sld = document.getElementById('sld');
host.mouse('mousedown', sld.offsetLeft + 150, sld.offsetTop + 9); // 75% along
check('slider click reports ~75', sliderVal !== null && Math.abs(sliderVal - 75) <= 2);

// --- tabs: active label + switching ---
const tc = fresh();
let tab = 'one';
const renderTabs = () => render(NTabs({
  value: tab, onUpdate: (n) => { tab = n; renderTabs(); host.render(); },
  panes: [{ name: 'one', label: 'One', content: h('view', { id: 'pane' }, 'first') },
          { name: 'two', label: 'Two', content: h('view', { id: 'pane' }, 'second') }],
}), tc);
renderTabs();
host.render();
check('active tab pane renders its content', document.getElementById('pane').textContent === 'first');
const tabTwo = tc.firstChild.firstChild.childNodes[1]; // header row -> second tab
host.click(tabTwo.offsetLeft + 5, tabTwo.offsetTop + 5);
check('clicking a tab switches the pane', document.getElementById('pane').textContent === 'second');

// --- progress: 100% fill is primary ---
const pc = fresh();
render(NProgress({ percentage: 100, width: 220 }), pc);
host.render();
const track = pc.firstChild.firstChild;       // row -> track
check('full progress bar fill is primary', at(track, 8, 4) === '#18A058');

// --- alert: tinted background ---
const ac = fresh();
render(NAlert({ type: 'info', title: 'Heads up', id: 'al' }, 'Some info'), ac);
host.render();
const al = document.getElementById('al');
const albg = rgb(at(al, 60, 4));              // tinted info-blue over white
check('alert has a light tinted background', albg[2] > albg[0] && albg[0] > 200);

// --- modal: backdrop covers its (relative, sized) stage only when shown ---
const stage = document.createElement('view');
stage.style.width = '400'; stage.style.height = '260'; stage.style.position = 'relative';
document.body.appendChild(stage);
const corner = () => rgb(host.pixel(stage.offsetLeft + 20, stage.offsetTop + 20));

render(NModal({ show: false }, 'hidden'), stage);   // absolute child of the sized stage
host.render();
check('hidden modal: stage corner is unobscured', corner()[0] > 200);
render(NModal({ show: true, title: 'Hi', width: 240 }, 'body'), stage);
host.render();
check('shown modal: a dim backdrop covers the stage', corner()[0] < 160);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
