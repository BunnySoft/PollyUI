// vue.mjs — reactivity (ref/reactive/computed/watch) + createApp re-render.

import { ref, reactive, computed, watch, watchEffect, createApp, h } from './gui/sdk/js/vue.mjs';

let pass = 0, fail = 0;
function check(n, c) { if (c) { pass++; console.log('PASS: ' + n); } else { fail++; console.log('FAIL: ' + n); } }

// --- ref + watchEffect (synchronous) ---
const n = ref(1);
let seen = 0;
watchEffect(() => { seen = n.value; });
check('watchEffect runs immediately', seen === 1);
n.value = 5;
check('watchEffect re-runs on ref change', seen === 5);

// --- reactive object ---
const state = reactive({ a: 2, b: 3, nested: { x: 1 } });
let sumSeen = 0;
watchEffect(() => { sumSeen = state.a + state.b; });
state.a = 10;
check('reactive object triggers effects', sumSeen === 13);
check('nested objects are reactive (identity cached)', state.nested === state.nested);

// --- computed ---
const c = computed(() => state.a + state.b);
check('computed initial value', c.value === 13);
state.b = 7;
check('computed recomputes lazily', c.value === 17);

// --- watch(source, cb) ---
const w = ref(0);
let watched = null;
watch(w, (nv, ov) => { watched = [ov, nv]; });
w.value = 42;
check('watch reports old + new value', watched && watched[0] === 0 && watched[1] === 42);

// --- createApp with setup() returning a render fn ---
const App = {
  setup() {
    const count = ref(0);
    return () => h('view', { id: 'app' },
      h('view', { id: 'cnt', style: { width: '80', height: '30', backgroundColor: count.value > 0 ? '#00ff00' : '#ff0000' } }, String(count.value)),
      h('view', { id: 'inc', style: { width: '60', height: '30' }, onClick: () => count.value++ }));
  },
};
createApp(App).mount(document.body);
host.render();
check('app mounts with initial state', document.getElementById('cnt').textContent === '0');
const cnt = document.getElementById('cnt');
check('initial reactive style (red at 0)', host.pixel(cnt.offsetLeft + 60, cnt.offsetTop + 5) === '#FF0000');

const inc = document.getElementById('inc');
host.click(inc.offsetLeft + 5, inc.offsetTop + 5);   // count.value++ -> schedules re-render; run-loop flushes it
check('ref mutation re-renders the app', document.getElementById('cnt').textContent === '1');
host.render();
check('reactive style updated (green after increment)', host.pixel(cnt.offsetLeft + 60, cnt.offsetTop + 5) === '#00FF00');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
