// fluent_sfc.mjs — a WinUI/Fluent-styled control authored as a Vue SFC, proving
// the control pack can be written declaratively (template + script + Fluent style)
// on top of PollyUI, and composes existing component tags (<button>).

import { createApp } from './js/vue.mjs';
import { compileSFC } from './js/sfc.mjs';
import './js/pollyui.mjs'; // registers component tags

let pass = 0, fail = 0;
function check(n, c) { if (c) { pass++; console.log('PASS: ' + n); } else { fail++; console.log('FAIL: ' + n); } }
function findText(node, str) {
  if (!node) return false;
  if (node.nodeType === 3 && node.textContent === str) return true;
  for (const c of node.childNodes || []) if (findText(c, str)) return true;
  return false;
}
const full = () => { const c = document.createElement('view'); c.style.position = 'absolute'; c.style.top = '0'; c.style.left = '0'; c.style.width = '100%'; c.style.height = '100%'; document.body.appendChild(c); return c; };

// A Fluent "Card" control — WinUI look (rounded, hairline border, depth color
// ramp), authored entirely in SFC form, composing the <button> component tag.
const FluentCard = compileSFC(`
  <template>
    <view :style="{ width: '320', borderRadius: '8', borderWidth: '1', borderColor: '#e5e5e5', backgroundColor: '#ffffff', padding: '20', gap: '12', flexDirection: 'column' }">
      <text :style="{ fontSize: '18', fontWeight: 'bold', color: '#1a1a1a' }">{{ title }}</text>
      <text :style="{ fontSize: '14', color: '#5f6368' }">{{ body }}</text>
      <view v-if="badge" :style="{ alignSelf: 'flex-start', backgroundColor: '#0067c0', borderRadius: '4', paddingLeft: '10', paddingRight: '10', paddingTop: '3', paddingBottom: '3' }">
        <text :style="{ color: '#ffffff', fontSize: '12' }">{{ badge }}</text>
      </view>
      <button id="cta" type="primary" @click="clicks++">{{ action }} ({{ clicks }})</button>
    </view>
  </template>
  <script>
    export default {
      props: ['title', 'body', 'action', 'badge'],
      setup(props) {
        const clicks = ref(0);
        return { ...props, clicks };
      }
    }
  </script>
`);

const c = full();
createApp(FluentCard, { title: 'Microsoft Store', body: 'Get apps, games and more.', action: 'Open', badge: 'New' }).mount(c);
host.render();

check('Fluent card title renders', findText(document.body, 'Microsoft Store'));
check('Fluent card body renders', findText(document.body, 'Get apps, games and more.'));
check('v-if badge renders', findText(document.body, 'New'));
check('CTA button (component tag) renders with count', findText(document.body, 'Open (0)'));

const cta = document.getElementById('cta');
host.click(cta.offsetLeft + 8, cta.offsetTop + Math.floor(cta.offsetHeight / 2));
host.flush(); host.render();
check('CTA @click mutated state through the SFC', findText(document.body, 'Open (1)'));

// the styled card has the Fluent white surface — sample a pixel inside it
const root = c.childNodes[0];
host.render();
check('card has a white Fluent surface', host.pixel(root.offsetLeft + 30, root.offsetTop + 4) === '#FFFFFF');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
