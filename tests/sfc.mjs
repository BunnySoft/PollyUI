// sfc.mjs — the Vue SFC compiler: template directives, interpolation, ref
// auto-unwrap, component tags, and reactivity through to render.

import { createApp } from './js/vue.mjs';
import { compileSFC } from './js/sfc.mjs';
import './js/pollyui.mjs'; // side effect: registers component tags (<button>, …)

let pass = 0, fail = 0;
function check(n, c) { if (c) { pass++; console.log('PASS: ' + n); } else { fail++; console.log('FAIL: ' + n); } }
function findText(node, str) {
  if (!node) return false;
  if (node.nodeType === 3 && node.textContent === str) return true;
  for (const c of node.childNodes || []) if (findText(c, str)) return true;
  return false;
}
const full = () => { const c = document.createElement('view'); c.style.position = 'absolute'; c.style.top = '0'; c.style.left = '0'; c.style.width = '100%'; c.style.height = '100%'; document.body.appendChild(c); return c; };

const Comp = compileSFC(`
  <template>
    <view>
      <view id="lbl"><text>Count: {{ count }}</text></view>
      <button id="inc" type="primary" @click="inc">Add</button>
      <view v-if="count > 1" id="hi"><text>high</text></view>
      <view v-for="(n, i) in items"><text>{{ i }}={{ n }}</text></view>
    </view>
  </template>
  <script>
    export default {
      props: ['start'],
      setup(props) {
        const count = ref(props.start || 0);
        const items = ['x', 'y'];
        const inc = () => count.value++;
        return { count, items, inc };
      }
    }
  </script>
`);

const c = full();
createApp(Comp, { start: 1 }).mount(c);
host.render();

check('interpolation + ref auto-unwrap + props', findText(document.body, 'Count: 1'));
check('v-for renders the list', findText(document.body, '0=x') && findText(document.body, '1=y'));
check('v-if false when count=1', !findText(document.body, 'high'));
check('component tag <button> resolved + rendered its label', findText(document.body, 'Add'));

// the <button> tag resolved to NButton, which is interactive; @click mutates the ref
const inc = document.getElementById('inc');
check('button element exists with id', !!inc);
host.click(inc.offsetLeft + 6, inc.offsetTop + Math.floor(inc.offsetHeight / 2));
host.flush(); host.render();

check('@click handler ran -> ref updated (Count: 2)', findText(document.body, 'Count: 2'));
check('v-if now true (count > 1)', findText(document.body, 'high'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
