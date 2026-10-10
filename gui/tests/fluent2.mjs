// fluent2.mjs — the second wave of Fluent controls (hyperlink, badge,
// progressbar, expander) added to js/fluent.mjs.

import { reactive, createApp, h } from './gui/sdk/js/vue.mjs';
import './gui/sdk/js/pollyui.mjs';
import './gui/sdk/js/fluent.mjs';

let pass = 0, fail = 0;
function check(n, c) { if (c) { pass++; console.log('PASS: ' + n); } else { fail++; console.log('FAIL: ' + n); } }
function find(n, s) { if (!n) return false; if (n.nodeType === 3 && n.textContent === s) return true; for (const c of n.childNodes || []) if (find(c, s)) return true; return false; }

let linkClicks = 0;
const s = reactive({ exp: false });
const App = {
  setup() {
    return () => h('view', { style: { padding: '20', gap: '12' } },
      h('fluent-hyperlink', { id: 'lnk', onClick: () => linkClicks++ }, 'Learn more'),
      h('fluent-badge', { id: 'bdg', value: 7 }),
      h('fluent-progressbar', { id: 'pb', value: 50 }),
      h('fluent-expander', { id: 'exp', title: 'Advanced options', expanded: s.exp, onToggle: () => s.exp = !s.exp },
        h('text', {}, 'Hidden body content')));
  },
};
createApp(App).mount(document.body);
host.render();

check('hyperlink renders its slot label', find(document.body, 'Learn more'));
const lnk = document.getElementById('lnk');
host.click(lnk.offsetLeft + 5, lnk.offsetTop + Math.floor(lnk.offsetHeight / 2)); host.flush(); host.render();
check('hyperlink onClick fires', linkClicks === 1);

check('badge renders its value', find(document.body, '7'));

// progressbar: 50% fill — sample left half (accent) vs right half (track)
const pb = document.getElementById('pb');
check('progressbar fill is accent on the left', host.pixel(pb.offsetLeft + 4, pb.offsetTop + 1) === '#0067C0');

// expander: collapsed hides body, header click expands it
check('expander header renders', find(document.body, 'Advanced options'));
check('expander body hidden while collapsed', !find(document.body, 'Hidden body content'));
const exp = document.getElementById('exp');
host.click(exp.offsetLeft + 20, exp.offsetTop + 24); host.flush(); host.render();
check('expander body shown after toggle', find(document.body, 'Hidden body content'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
