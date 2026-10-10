// transition.mjs — declarative `transition` prop: style changes that flow
// through the reconciler animate over time (driven by rAF, advanced here via
// host.render(ts) so the tween is deterministic).

import { reactive, createApp, h } from './gui/sdk/js/vue.mjs';
import './gui/sdk/js/pollyui.mjs';

let pass = 0, fail = 0;
function check(n, c) { if (c) { pass++; console.log('PASS: ' + n); } else { fail++; console.log('FAIL: ' + n); } }
const near = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;

const st = reactive({ open: true });

const App = {
  setup() {
    return () => h('view', {
      id: 'box',
      style: {
        opacity: st.open ? 1 : 0,
        width: st.open ? '100px' : '40px',
        backgroundColor: st.open ? '#0067c0' : '#ff0000',
      },
      transition: { duration: 200, easing: 'linear' },
    });
  },
};

createApp(App).mount(document.body);
const box = () => document.getElementById('box');

// --- mount is instant (no transition on first paint) ---
host.render(1000);
check('mount opacity is instant (1)', parseFloat(box().style.opacity) === 1);
check('mount width is instant (100px)', box().style.width === '100px');
check('mount color is instant', box().style.backgroundColor.toLowerCase() === '#0067c0');

// --- toggle off: opacity/width/color all tween 1000 -> 1200ms ---
st.open = false;
host.flush();          // re-render: starts the tween (registers rAF)
host.render(1000);     // first frame: start=1000, p=0 -> still at the 'from' value
check('t=0 opacity still 1', near(parseFloat(box().style.opacity), 1));
check('t=0 width still 100px', near(parseFloat(box().style.width), 100, 0.5));

host.render(1100);     // p = 0.5 (linear)
check('t=0.5 opacity ~0.5', near(parseFloat(box().style.opacity), 0.5));
check('t=0.5 width ~70px', near(parseFloat(box().style.width), 70, 0.5));
// color midpoint: #0067c0 -> #ff0000  ==>  r~127 g~51 b~96  (#7f3360)
check('t=0.5 color is interpolated (not either endpoint)',
  box().style.backgroundColor.toLowerCase() !== '#0067c0' &&
  box().style.backgroundColor.toLowerCase() !== '#ff0000');

host.render(1200);     // p = 1 -> final
check('t=1 opacity reaches 0', near(parseFloat(box().style.opacity), 0));
check('t=1 width reaches 40px', near(parseFloat(box().style.width), 40, 0.5));
check('t=1 color reaches #ff0000', box().style.backgroundColor.toLowerCase() === '#ff0000');

// --- re-target mid-flight: toggling back cancels the old tween cleanly ---
st.open = false; host.flush(); host.render(2000);  // settle at 0
st.open = true;  host.flush();                      // new target: opacity 1
host.render(2000);                                  // start of new tween, p=0 -> ~0
host.render(2100);                                  // p=0.5 -> ~0.5 (not jumping around)
check('re-target tween moves toward new value', near(parseFloat(box().style.opacity), 0.5, 0.05));
host.render(2200);
check('re-target tween completes at 1', near(parseFloat(box().style.opacity), 1));

// --- props filter: only listed props animate; others are instant ---
const st2 = reactive({ big: false });
const App2 = {
  setup() {
    return () => h('view', { id: 'box2',
      style: { opacity: st2.big ? 1 : 0.2, width: st2.big ? '80px' : '20px' },
      transition: { duration: 200, easing: 'linear', props: ['opacity'] } });
  },
};
const host2 = document.createElement('view'); document.body.appendChild(host2);
createApp(App2).mount(host2);
const box2 = () => document.getElementById('box2');
host.render(3000);
st2.big = true; host.flush(); host.render(3000); host.render(3100);
check('props filter: width jumps instantly to 80px', near(parseFloat(box2().style.width), 80, 0.5));
check('props filter: opacity still mid-tween', parseFloat(box2().style.opacity) < 1);

// --- <Transition>: enter on mount, animated leave with deferred removal ------
const ts = reactive({ show: false });
const TApp = {
  setup() {
    return () => h('view', { id: 'wrap' },
      h('transition', { duration: 200, easing: 'linear', enter: { opacity: 0 }, leave: { opacity: 0 } },
        ts.show && h('view', { id: 'panel', style: { opacity: 1, width: '120px' } }, 'hi')));
  },
};
const tc = document.createElement('view'); document.body.appendChild(tc);
createApp(TApp).mount(tc);
const panel = () => document.getElementById('panel');
host.render(5000);
check('transition: nothing rendered while hidden', panel() === null);

// enter
ts.show = true; host.flush();   // mount: onMount sets opacity 0 synchronously
host.render(5000);              // p=0
check('enter: panel mounted', panel() !== null);
check('enter: starts at opacity 0', near(parseFloat(panel().style.opacity), 0, 0.05));
host.render(5100);
check('enter: mid opacity ~0.5', near(parseFloat(panel().style.opacity), 0.5, 0.06));
host.render(5200);
check('enter: settles at opacity 1', near(parseFloat(panel().style.opacity), 1));

// leave: element stays in the DOM until the leave tween finishes
ts.show = false; host.flush();
check('leave: panel still present during animation', panel() !== null);
host.render(6000);             // p=0
host.render(6100);
check('leave: mid opacity ~0.5', near(parseFloat(panel().style.opacity), 0.5, 0.06));
host.render(6200); host.flush(); // p=1 -> resolve; flush drains .then(done) -> detach
check('leave: panel removed after animation', panel() === null);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
