// customtags.mjs — custom element tags (h('button',...)) resolve to the matching
// Naive component and render identically to calling it directly.

import { h, render, NButton, NBadge, componentTags, tagNames } from './gui/sdk/js/pollyui.mjs';

let pass = 0, fail = 0;
function check(n, c) { if (c) { pass++; console.log('PASS: ' + n); } else { fail++; console.log('FAIL: ' + n); } }
function findText(node, str) {
  if (!node) return false;
  if (node.nodeType === 3 && node.textContent === str) return true;
  for (const c of node.childNodes || []) if (findText(c, str)) return true;
  return false;
}
const full = () => { const c = document.createElement('view'); c.style.position = 'absolute'; c.style.top = '0'; c.style.left = '0'; c.style.width = '100%'; c.style.height = '100%'; document.body.appendChild(c); return c; };

// the registry was populated as a side effect of importing pollyui.mjs
check("'button' tag is registered", tagNames().includes('button'));
check("'badge' tag is registered", componentTags.includes('badge'));
check("'dropdown' tag is registered", componentTags.includes('dropdown'));
check("multi-word kebab tag registered (button-group)", componentTags.includes('button-group'));

// h('button', props, label) renders the same DOM as NButton(props, label)
let clicked = false;
const viaTag  = h('button', { id: 'a', type: 'primary', onClick: () => clicked = true }, 'Save');
const viaFunc = NButton({ id: 'b', type: 'primary' }, 'Save');
check('h("button") returns a vnode (resolved at call time)', viaTag && viaTag.type === 'view');
check('tag vnode equals the function vnode shape', JSON.stringify(stripFns(viaTag.children)) === JSON.stringify(stripFns(viaFunc.children)));
function stripFns(x) { return JSON.parse(JSON.stringify(x, (k, v) => (typeof v === 'function' ? undefined : v))); }

// render a small tree authored entirely with tags
render(h('view', { style: { width: '100%', height: '100%' } },
  h('button', { id: 'go', type: 'primary', onClick: () => clicked = true }, 'Save'),
  h('badge', { value: 8 }, h('button', {}, 'Inbox')),
  h('tag', { type: 'success' }, 'stable')), full());
host.render();

check('tag-authored button renders its label', findText(document.body, 'Save'));
check('nested tag (badge>button) renders', findText(document.body, 'Inbox'));
check('badge value renders', findText(document.body, '8'));
check('tag-authored NTag renders', findText(document.body, 'stable'));

// the button is interactive (onClick wired through the tag path)
const go = document.getElementById('go');
host.click(go.offsetLeft + 6, go.offsetTop + go.offsetHeight / 2);
check('tag-authored button is clickable', clicked === true);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
