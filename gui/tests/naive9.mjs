// naive9.mjs — Wave 3: Popover, Popselect, BackTop, Anchor, Affix,
// notification, loadingBar.

import { ref, createApp, h } from './gui/sdk/js/vue.mjs';
import { render } from './gui/sdk/js/reconciler.mjs';
import {
  NPopover, NPopselect, NBackTop, NAnchor, NAffix, NOverlayHost,
  notification, loadingBar,
} from './gui/sdk/js/naive.mjs';

let pass = 0, fail = 0;
function check(n, c) { if (c) { pass++; console.log('PASS: ' + n); } else { fail++; console.log('FAIL: ' + n); } }
const box = () => { const c = document.createElement('view'); c.style.padding = '12'; document.body.appendChild(c); return c; };
const full = () => { const c = document.createElement('view'); c.style.position = 'absolute'; c.style.width = '100%'; c.style.height = '100%'; c.style.top = '0'; c.style.left = '0'; document.body.appendChild(c); return c; };
function findByText(root, txt) { if (root.nodeType === 1 && root.textContent === txt) return root; for (let c = root.firstChild; c; c = c.nextSibling) { const r = findByText(c, txt); if (r) return r; } return null; }
const clickCenter = (el) => host.click(el.offsetLeft + el.offsetWidth / 2, el.offsetTop + el.offsetHeight / 2);

// --- structural: BackTop, Anchor, Affix (in a sized stage) ---
const stage = full();
let backTopHit = false, ancSel = null;
render(h('view', { style: { width: '100%', height: '100%', position: 'relative' } },
  NBackTop({ id: 'bt', visible: true, onClick: () => backTopHit = true }),
  NAnchor({ id: 'anc', active: 'b', links: [{ key: 'a', label: 'Intro' }, { key: 'b', label: 'Usage' }, { key: 'c', label: 'API' }], onSelect: k => ancSel = k }),
  NAffix({ id: 'af', affixed: false }, h('view', {}, 'Affixed content'))), stage);
host.render();
check('backtop renders the arrow', document.getElementById('bt').textContent.indexOf('↑') >= 0);
clickCenter(document.getElementById('bt'));
check('backtop click fires', backTopHit === true);
check('anchor renders links', document.getElementById('anc').textContent.indexOf('Intro') >= 0);
clickCenter(document.getElementById('anc').childNodes[2]);   // "API"
check('anchor click selects', ancSel === 'c');
check('affix renders its child', document.getElementById('af').textContent.indexOf('Affixed content') >= 0);

// --- Popover (overlay) ---
const pvApp = { setup() { return () => h('view', { style: { width: '100%', height: '100%' } },
  h('view', { style: { padding: '20' } }, NPopover({ content: 'Popover body', trigger: 'click' }, h('view', { id: 'pvtrig', style: { width: '80', height: '32', backgroundColor: '#eeeeee' } }, 'Click'))),
  NOverlayHost()); } };
createApp(pvApp).mount(full());
host.render();
const pvtrig = document.getElementById('pvtrig');
host.click(pvtrig.offsetLeft + 40, pvtrig.offsetTop + 16);
check('popover opens its content', document.body.textContent.indexOf('Popover body') >= 0);
host.click(5, 5);   // dismiss the popover (its backdrop) so it doesn't block later clicks

// --- Popselect (overlay) ---
let psVal = null;
const psApp = { setup() { return () => h('view', { style: { width: '100%', height: '100%' } },
  h('view', { style: { padding: '20' } }, NPopselect({ value: psVal, options: [{ value: 'x', label: 'Option X' }, { value: 'y', label: 'Option Y' }], onUpdate: v => psVal = v }, h('view', { id: 'pstrig', style: { width: '80', height: '32', backgroundColor: '#eeeeee' } }, 'Pick'))),
  NOverlayHost()); } };
createApp(psApp).mount(full());
host.render();
const pstrig = document.getElementById('pstrig');
host.click(pstrig.offsetLeft + 40, pstrig.offsetTop + 16);
check('popselect opens options', document.body.textContent.indexOf('Option X') >= 0);
clickCenter(findByText(document.body, 'Option X'));
check('popselect selects + closes', psVal === 'x' && document.body.textContent.indexOf('Option Y') < 0);

// --- notification + loadingBar (overlay) ---
const fbApp = { setup() { return () => h('view', { style: { width: '100%', height: '100%' } }, NOverlayHost()); } };
createApp(fbApp).mount(full());
host.render();
notification.success({ title: 'Saved', content: 'Your changes were saved', duration: 0 });
host.flush(); host.render();
check('notification shows a card', document.body.textContent.indexOf('Saved') >= 0 && document.body.textContent.indexOf('Your changes were saved') >= 0);

loadingBar.start();
host.flush(); host.render();
check('loading bar appears at the top', host.pixel(20, 1) === '#18A058');
loadingBar.finish();

console.log('\n' + pass + ' passed, ' + fail + ' failed');
