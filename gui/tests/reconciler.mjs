// reconciler.mjs — virtual DOM: mount, diff/update, events, components, lists.

import { h, render, mount } from './gui/sdk/js/reconciler.mjs';

let pass = 0, fail = 0;
function check(n, c) { if (c) { pass++; console.log('PASS: ' + n); } else { fail++; console.log('FAIL: ' + n); } }

// --- initial mount ---
const Label = ({ count, color }) =>
  h('view', { id: 'label', style: { width: '100', height: '30', backgroundColor: color } }, String(count));
const App = (state, setState) =>
  h('view', { style: { gap: '6' } },
    Label({ count: state.count, color: state.count > 0 ? '#00ff00' : '#ff0000' }),
    h('view', { id: 'btn', style: { width: '80', height: '30' }, onClick: () => setState({ count: state.count + 1 }) }));

const app = mount(App, document.body, { count: 0 });
host.render();

check('mounts a node tree', document.getElementById('label') !== null);
check('text child renders the count', document.getElementById('label').textContent === '0');
const label = document.getElementById('label');
check('initial style applied (red)', host.pixel(label.offsetLeft + 80, label.offsetTop + 5) === '#FF0000');

// --- event handler + minimal update ---
const btn = document.getElementById('btn');
host.click(btn.offsetLeft + 5, btn.offsetTop + 5);
check('onClick handler ran (state updated)', app.state.count === 1);
check('text updated in place', document.getElementById('label').textContent === '1');
check('same label DOM node reused', document.getElementById('label') === label);
host.render();
check('style prop updated (now green)', host.pixel(label.offsetLeft + 80, label.offsetTop + 5) === '#00FF00');

// --- function component + conditional / list children ---
const Item = ({ text }) => h('view', { className: 'item' }, text);
function List({ items }) {
  return h('view', { id: 'list' }, items.map(t => Item({ text: t })));
}
const c2 = document.createElement('view');
document.body.appendChild(c2);
render(h(List, { items: ['a', 'b', 'c'] }), c2);
check('function component renders a list', document.getElementById('list').childNodes.length === 3);
check('querySelectorAll sees list items', document.querySelectorAll('.item').length === 3);

// re-render with fewer items -> extra child removed
render(h(List, { items: ['a'] }), c2);
check('list shrinks on re-render', document.getElementById('list').childNodes.length === 1);
check('remaining item keeps its text', document.getElementById('list').textContent === 'a');

// re-render with more items -> children appended
render(h(List, { items: ['x', 'y', 'z', 'w'] }), c2);
check('list grows on re-render', document.getElementById('list').childNodes.length === 4);

const lifecycle = document.createElement('view');
document.body.appendChild(lifecycle);
let mounts = 0, updates = 0, leaves = 0, childrenReady = false, replacementUpdates = 0;
const mounted = () => mounts++;
const updated = node => {
  updates++;
  childrenReady = node.textContent === 'after' && node.getAttribute('aria-label') === 'after';
};
render(h('view', { onMount: mounted, onUpdate: updated, 'aria-label': 'before' }, 'before'), lifecycle);
const retained = lifecycle.firstChild;
check('mount calls onMount once without onUpdate', mounts === 1 && updates === 0);
render(h('view', { onMount: mounted, onUpdate: updated, 'aria-label': 'after' }, 'after'), lifecycle);
check('opt-in update runs once on the same existing node', mounts === 1 && updates === 1 && lifecycle.firstChild === retained);
check('onUpdate observes completed prop and child updates', childrenReady);
render(h('canvas', { onUpdate: () => replacementUpdates++ }), lifecycle);
check('replacement does not update either the retired or new node', updates === 1 && replacementUpdates === 0 && lifecycle.firstChild !== retained);
render(h('view', { onUpdate: updated, onLeave: (node, done) => { leaves++; done(); } }), lifecycle);
render(null, lifecycle);
check('onLeave removes without an extra update', leaves === 1 && updates === 1 && lifecycle.firstChild === null);
render(h('view', {}, 'plain'), lifecycle);
let propagated = false;
try { render(h('view', { onUpdate: () => { throw new Error('update failure'); } }, 'changed'), lifecycle); }
catch (error) { propagated = error.message === 'update failure'; }
check('onUpdate errors propagate without an implicit rerender', propagated && lifecycle.firstChild.textContent === 'changed');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
