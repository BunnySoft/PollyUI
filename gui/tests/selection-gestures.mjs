import { h, createApp, reactive } from './gui/sdk/js/vue.mjs';
import { NRadioGroup, NTabs, NMenu, NSelect, NOverlayHost } from './gui/sdk/js/naive.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
const model = reactive({ kind: 'radio', items: ['a', 'b', 'c'], value: 'a' }), calls = [];
const options = () => model.items.map(value => ({ value, key: value, name: value, label: 'Same label', content: 'Pane' }));
const choose = value => calls.push(value);
createApp({ setup: () => () => h('view', { style: { width: '100%', height: '100%', padding: 20 } },
  model.kind === 'radio' ? NRadioGroup({ id: 'review', value: model.value, options: options(), onUpdate: choose }) :
  model.kind === 'tabs' ? NTabs({ id: 'review', value: model.value, panes: options(), onUpdate: choose }) :
  model.kind === 'menu' ? NMenu({ id: 'review', value: model.value, items: options(), onUpdate: choose }) :
  NSelect({ id: 'review', value: model.value, options: options(), onUpdate: choose }),
  NOverlayHost()) }).mount(document.body);
const settle = async () => { for (let i = 0; i < 3; i++) { await Promise.resolve(); host.render(); } };
const target = () => model.kind === 'radio' || model.kind === 'menu' ? document.getElementById('review').firstChild :
  model.kind === 'tabs' ? document.getElementById('review').firstChild.firstChild : document.querySelector('.n-select-option');
const center = node => { const r = node.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; };
const results = [];
for (const kind of ['radio', 'tabs', 'menu', 'select']) {
  for (const action of ['delete', 'reorder']) {
    model.kind = kind; model.items = ['a', 'b', 'c']; model.value = 'a'; await settle();
    if (kind === 'select') {
      document.getElementById('review').focus();
      host.key('Enter', 'keydown', { text: false }); await settle();
    }
    const node = target(), [x, y] = center(node), count = calls.length;
    host.mouse('mousedown', x, y);
    model.items = action === 'delete' ? ['b', 'c'] : ['b', 'a', 'c'];
    await settle();
    const sameNode = target() === node;
    host.mouse('mouseup', x, y); host.mouse('click', x, y); await settle();
    results.push({ kind, action, sameNode, emitted: calls.slice(count) });
    if (kind === 'select') { host.key('Escape', 'keydown', { text: false }); await settle(); }
  }
}
console.log('SELECTION_HELD_IDENTITY ' + JSON.stringify(results));
check(results.every(result => result.sameNode && result.emitted.length === 0),
  'A held slot cannot activate another value after deletion or reorder');
for (const kind of ['radio', 'tabs', 'menu', 'select']) {
  model.kind = kind; model.items = ['a', 'b', 'c']; await settle();
  if (kind === 'select') {
    document.getElementById('review').focus(); host.key('Enter', 'keydown', { text: false }); await settle();
  }
  const [x, y] = center(target()), count = calls.length;
  host.mouse('mousedown', x, y); host.mouse('mouseup', x, y); host.mouse('click', x, y); await settle();
  check(calls.length === count + 1 && calls.at(-1) === 'a', kind + ' unchanged primary gesture still activates once');
}
console.log('PASS: actual held-pointer identity across four mapped control types, deletion/reorder and normal primary gestures');
