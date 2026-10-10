// fluent.mjs — the Fluent control pack (SFC controls registered as tags),
// composed via h() with slots, props, and interaction.

import { ref, createApp, h } from './gui/sdk/js/vue.mjs';
import './gui/sdk/js/pollyui.mjs'; // base tags + h
import './gui/sdk/js/fluent.mjs';  // registers <fluent-*> tags

let pass = 0, fail = 0;
function check(n, c) { if (c) { pass++; console.log('PASS: ' + n); } else { fail++; console.log('FAIL: ' + n); } }
function findText(node, str) {
  if (!node) return false;
  if (node.nodeType === 3 && node.textContent === str) return true;
  for (const c of node.childNodes || []) if (findText(c, str)) return true;
  return false;
}
const full = () => { const c = document.createElement('view'); c.style.position = 'absolute'; c.style.top = '0'; c.style.left = '0'; c.style.width = '100%'; c.style.height = '100%'; document.body.appendChild(c); return c; };

let got = '';
const App = {
  setup() {
    const on = ref(false);
    return () => h('view', { style: { padding: '20', gap: '12' } },
      h('fluent-infobar', { title: 'Heads up', message: 'An update is available.' }),
      h('fluent-card', { title: 'Welcome' },
        h('text', { style: { fontSize: '14', color: '#5f6368' } }, 'A Fluent card via SFC.'),
        h('fluent-button', { id: 'cta', accent: true, onClick: () => { got = 'clicked'; } }, 'Get')),
      h('fluent-toggle', { id: 'tog', on: on.value, onToggle: () => { on.value = !on.value; } }));
  },
};

createApp(App).mount(full());
host.render();

check('fluent-infobar title (SFC tag) renders', findText(document.body, 'Heads up'));
check('fluent-infobar v-if message renders', findText(document.body, 'An update is available.'));
check('fluent-card title prop renders', findText(document.body, 'Welcome'));
check('fluent-card <slot/> content renders', findText(document.body, 'A Fluent card via SFC.'));
check('fluent-button <slot/> label renders', findText(document.body, 'Get'));

// accent button has the Fluent blue fill (#0067C0)
const cta = document.getElementById('cta');
check('fluent-button accent fill is #0067C0', host.pixel(cta.offsetLeft + 10, cta.offsetTop + 4) === '#0067C0');

// click the accent button -> the onClick prop fires
host.click(cta.offsetLeft + 12, cta.offsetTop + Math.floor(cta.offsetHeight / 2));
host.flush(); host.render();
check('fluent-button onClick prop fired', got === 'clicked');

// toggle: off is gray, click -> on is accent (controlled via app ref)
const tog = document.getElementById('tog');
// off: thumb sits left, so sample the track on the right (gray)
check('fluent-toggle off track is gray', host.pixel(tog.offsetLeft + 31, tog.offsetTop + 10) === '#D0D0D0');
host.click(tog.offsetLeft + 6, tog.offsetTop + 10);
host.flush(); host.render();
// on: thumb sits right, so sample the track on the left (accent)
check('fluent-toggle on track is accent after click', host.pixel(tog.offsetLeft + 8, tog.offsetTop + 10) === '#0067C0');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
