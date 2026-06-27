// naive.mjs — Naive UI components: button types, switch, tag, controlled input.

import { ref, createApp, h } from './js/vue.mjs';
import { render } from './js/reconciler.mjs';
import { NButton, NSwitch, NTag, NInput, NSpace, theme } from './js/naive.mjs';

let pass = 0, fail = 0;
function check(n, c) { if (c) { pass++; console.log('PASS: ' + n); } else { fail++; console.log('FAIL: ' + n); } }
const center = (el) => host.pixel(el.offsetLeft + el.offsetWidth / 2, el.offsetTop + el.offsetHeight / 2);
// sample inside the left padding (avoids centered text glyphs) for fill color
const fillAt = (el) => host.pixel(el.offsetLeft + 3, el.offsetTop + el.offsetHeight / 2);

// --- button types: solid fill matches the theme color ---
const primary = NButton({ type: 'primary', id: 'b1' }, 'Primary');
const info = NButton({ type: 'info', id: 'b2' }, 'Info');
const error = NButton({ type: 'error', id: 'b3' }, 'Error');
const def = NButton({ id: 'b4' }, 'Default');
render(h('view', { style: { gap: '8', padding: '10' } }, primary, info, error, def), document.body);
host.render();
check('NButton primary is the primary green', fillAt(document.getElementById('b1')) === '#18A058');
check('NButton info is the info blue', fillAt(document.getElementById('b2')) === '#2080F0');
check('NButton error is the error red', fillAt(document.getElementById('b3')) === '#D03050');
check('NButton default is white', fillAt(document.getElementById('b4')) === '#FFFFFF');

// fresh container for the rest
const c2 = document.createElement('view');
c2.style.padding = '10'; c2.style.gap = '10';
document.body.appendChild(c2);

// --- switch: off is grey, on is primary ---
render(h('view', {}, NSwitch({ value: false })), c2);
host.render();
let sw = c2.firstChild.firstChild;
// off: knob sits on the left, so the right side shows the track
check('NSwitch off track is grey', host.pixel(sw.offsetLeft + 34, sw.offsetTop + 11) === '#DBDBDB');
render(h('view', {}, NSwitch({ value: true })), c2);
host.render();
sw = c2.firstChild.firstChild;
// on: knob sits on the right, so the left side shows the track
check('NSwitch on track is primary green', host.pixel(sw.offsetLeft + 6, sw.offsetTop + 11) === '#18A058');

// --- tag: colored text/border, tinted background ---
const c3 = document.createElement('view'); c3.style.padding = '10';
document.body.appendChild(c3);
render(h('view', {}, NTag({ type: 'warning', id: 'tag' }, 'warn')), c3);
host.render();
const tag = document.getElementById('tag');
// sample the left padding area (no glyph there) -> the tinted background
check('NTag warning has a tinted background', host.pixel(tag.offsetLeft + 4, tag.offsetTop + 12) === '#FDF2E3');

// --- NInput: controlled editing through a Vue ref ---
const App = {
  setup() {
    const txt = ref('');
    return () => h('view', { style: { padding: '10' } },
      NInput({ id: 'inp', value: txt.value, placeholder: 'type...', onInput: v => txt.value = v, width: 220 }));
  },
};
const c4 = document.createElement('view');
document.body.appendChild(c4);
createApp(App).mount(c4);
host.render();
const inp = document.getElementById('inp');
check('NInput shows the placeholder when empty', inp.textContent === 'type...');
host.click(inp.offsetLeft + 10, inp.offsetTop + 10);  // focus
host.key('H'); host.key('i');
check('NInput edits via controlled ref (typed "Hi")', document.getElementById('inp').textContent === 'Hi');
host.key('Backspace');
check('NInput backspace removes a char', document.getElementById('inp').textContent === 'H');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
