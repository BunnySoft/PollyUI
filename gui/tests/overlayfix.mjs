// overlayfix.mjs — non-modal overlays must not block the app (pointerEvents),
// and getBoundingClientRect must report viewport coords (scroll-adjusted) so
// popups land at the trigger's on-screen position after scrolling.

import { h, render } from './gui/sdk/js/reconciler.mjs';

let pass = 0, fail = 0;
function check(n, c) { if (c) { pass++; console.log('PASS: ' + n); } else { fail++; console.log('FAIL: ' + n); } }

// --- pointerEvents:none pass-through ---
let appClicks = 0;
const btn = h('view', { style: { position: 'absolute', left: '0', top: '0', width: '200', height: '80', backgroundColor: '#18a058' }, onClick: () => appClicks++ });
// a full-screen host on top (like NOverlayHost) with pointerEvents:none, hosting
// a small toast that does NOT cover the button.
const ovl = h('view', { style: { position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', pointerEvents: 'none' } },
  h('view', { style: { position: 'absolute', left: '300', top: '300', width: '120', height: '40', backgroundColor: '#ffffff' }, onClick: () => {} }));
render(h('view', { style: { width: '100%', height: '100%' } }, btn, ovl), document.body);
document.body.style.width = '100%'; document.body.style.height = '100%';
host.render();

host.click(50, 40);  // over the button, beneath the full-screen pe:none host
check('click passes through pointerEvents:none host to the app button', appClicks === 1);
host.click(360, 320); // over the toast (auto pointerEvents) — must NOT reach the button
check('an auto-pointerEvents popup still catches its own clicks', appClicks === 1);

// --- getBoundingClientRect is scroll-adjusted (viewport coords) ---
const sc = document.createElement('view');
sc.style.position = 'absolute'; sc.style.left = '0'; sc.style.top = '0';
sc.style.width = '200'; sc.style.height = '100'; sc.style.overflow = 'scroll';
document.body.appendChild(sc);
const spacer = document.createElement('view'); spacer.style.height = '300'; sc.appendChild(spacer);
const child = document.createElement('view'); child.id = 'sch'; child.style.height = '20'; sc.appendChild(child); // layout_y = 300
host.render();
const before = document.getElementById('sch').getBoundingClientRect();
sc.scrollTop = 150;
host.render();
const after = document.getElementById('sch').getBoundingClientRect();
check('rect.top is the un-scrolled layout position before scrolling', Math.round(before.top) === 300);
check('rect.top drops by scrollTop after scrolling (viewport coords)', Math.round(before.top - after.top) === 150);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
