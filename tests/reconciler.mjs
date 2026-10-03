// reconciler.mjs — virtual DOM: mount, diff/update, events, components, lists.

import { h, render, mount } from './js/reconciler.mjs';

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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
