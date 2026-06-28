// naive12.mjs — Wave 5b: TimePicker, TreeSelect, AutoComplete, Mention, ColorPicker.
// Each component runs in its own app/overlay-host, removed after its test (real
// apps have a single NOverlayHost; multiple live hosts would show stale popups).

import { ref, createApp, h } from './js/vue.mjs';
import { NTimePicker, NTreeSelect, NAutoComplete, NMention, NColorPicker, NOverlayHost } from './js/naive.mjs';

let pass = 0, fail = 0;
function check(n, c) { if (c) { pass++; console.log('PASS: ' + n); } else { fail++; console.log('FAIL: ' + n); } }
function findByText(root, txt) { if (root.nodeType === 1 && root.textContent === txt) return root; for (let c = root.firstChild; c; c = c.nextSibling) { const r = findByText(c, txt); if (r) return r; } return null; }
const clickCenter = (el) => host.click(el.offsetLeft + el.offsetWidth / 2, el.offsetTop + el.offsetHeight / 2);
// run an overlay test in a fresh, isolated host, then detach it
function stageApp(renderComp, body) {
  const c = document.createElement('view'); c.style.position = 'absolute'; c.style.top = '0'; c.style.left = '0'; c.style.width = '100%'; c.style.height = '100%';
  document.body.appendChild(c);
  createApp({ setup() { return () => h('view', { style: { width: '100%', height: '100%' } }, h('view', { style: { padding: '20' } }, renderComp()), NOverlayHost()); } }).mount(c);
  host.render();
  body();
  document.body.removeChild(c);
}

// TimePicker
let tpVal = null;
stageApp(() => { const v = (stageApp.tpv || (stageApp.tpv = ref(null))); return NTimePicker({ id: 'tp', value: v.value, onUpdate: x => { v.value = x; tpVal = x; } }); }, () => {
  const tp = document.getElementById('tp');
  host.click(tp.offsetLeft + 20, tp.offsetTop + 17);
  check('timepicker opens its columns', document.body.textContent.indexOf('03') >= 0);
  clickCenter(findByText(document.body, '03'));
  check('timepicker selects an hour', tpVal && tpVal.h === 3);
  host.click(5, 5);
});

// TreeSelect
let tsVal = null;
stageApp(() => { const v = (stageApp.tsv || (stageApp.tsv = ref(null))); return NTreeSelect({ id: 'ts', value: v.value, options: [{ key: 'a', label: 'Item A' }, { key: 'b', label: 'Item B' }], onUpdate: x => { v.value = x; tsVal = x; } }); }, () => {
  const ts = document.getElementById('ts');
  host.click(ts.offsetLeft + 20, ts.offsetTop + 17);
  check('treeselect opens the tree', document.body.textContent.indexOf('Item A') >= 0);
  clickCenter(findByText(document.body, 'Item A'));
  check('treeselect selects a node', tsVal === 'a');
});

// AutoComplete
let acSel = null;
stageApp(() => { const v = (stageApp.acv || (stageApp.acv = ref(''))); return NAutoComplete({ id: 'ac', value: v.value, options: ['Apple', 'Apricot', 'Banana'], onInput: x => v.value = x, onSelect: x => acSel = x }); }, () => {
  const ac = document.getElementById('ac');
  host.click(ac.offsetLeft + 20, ac.offsetTop + 17);
  host.key('A'); host.key('p');
  check('autocomplete live-filters while typing', document.body.textContent.indexOf('Apple') >= 0 && document.body.textContent.indexOf('Apricot') >= 0 && document.body.textContent.indexOf('Banana') < 0);
  clickCenter(findByText(document.body, 'Apple'));
  check('autocomplete selects an option', acSel === 'Apple');
});

// Mention
let menVal = '';
stageApp(() => { const v = (stageApp.mv || (stageApp.mv = ref(''))); return NMention({ id: 'men', value: v.value, options: ['alice', 'bob', 'alex'], onInput: x => { v.value = x; menVal = x; } }); }, () => {
  const men = document.getElementById('men');
  host.click(men.offsetLeft + 20, men.offsetTop + 17);
  host.key('@'); host.key('a');
  check('mention filters after @', document.body.textContent.indexOf('@alice') >= 0 && document.body.textContent.indexOf('@alex') >= 0 && document.body.textContent.indexOf('@bob') < 0);
  clickCenter(findByText(document.body, '@alice'));
  check('mention inserts the picked handle', menVal === '@alice ');
});

// ColorPicker
let cpVal = null;
stageApp(() => { const v = (stageApp.cpv || (stageApp.cpv = ref('#2080f0'))); return NColorPicker({ id: 'cp', value: v.value, onUpdate: x => { v.value = x; cpVal = x; } }); }, () => {
  const cp = document.getElementById('cp');
  host.click(cp.offsetLeft + 20, cp.offsetTop + 17);
  check('colorpicker opens the panel', document.body.textContent.indexOf('#') >= 0);
  host.mouse('mousedown', cp.offsetLeft + 100, cp.offsetTop + 108);
  check('colorpicker square sets a hex color', cpVal && /^#[0-9a-f]{6}$/.test(cpVal));
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
