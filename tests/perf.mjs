// perf.mjs — measure the cost of a state-driven re-render that changes layout
// (the "click a nav item" case). Run with PU_PERF=1 to see per-render timing.

import { reactive, createApp, h } from './js/vue.mjs';
import './js/pollyui.mjs';
import './js/fluent.mjs';

const cl = (o) => o;
const card = (i) => h('view', { style: { backgroundColor: '#fbfbfb', borderWidth: 1, borderColor: '#e5e5e5', borderRadius: 8, padding: 20, gap: 14, flexDirection: 'column' } },
  h('view', { style: { fontSize: 16, fontWeight: '600' } }, 'Sample ' + i),
  h('view', { style: { flexDirection: 'row', gap: 12, flexWrap: 'wrap' } },
    h('fluent-button', { accent: true }, 'Accent'),
    h('fluent-button', {}, 'Standard'),
    h('fluent-toggle', { on: i % 2 === 0 })),
  h('fluent-infobar', { title: 'Info ' + i, message: 'A representative settings row with some text content.' }));

const s = reactive({ nav: 0 });
const App = {
  setup() {
    return () => h('view', { style: { flexDirection: 'row', width: '100%', height: '100%' } },
      h('view', { style: { width: 220, flexDirection: 'column', gap: 2, backgroundColor: '#eaeaec' } },
        ...Array.from({ length: 6 }, (_, i) => h('view', { style: { height: 36, backgroundColor: s.nav === i ? '#dfdfe2' : '#eaeaec' } }, 'Item ' + i))),
      h('view', { style: { flexGrow: 1, flexBasis: 0, minWidth: 0, flexDirection: 'column', gap: 18, padding: 24 } },
        // page content depends on nav -> a nav change swaps this whole subtree
        ...Array.from({ length: 8 }, (_, i) => card(s.nav * 100 + i))));
  },
};

createApp(App).mount(document.body);
host.render();           // first full layout
console.log('--- now toggling nav (each is a full page swap) ---');
for (let i = 1; i <= 5; i++) { s.nav = i; host.flush(); host.render(); }
console.log('done');
