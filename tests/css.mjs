// css.mjs — stylesheet parsing, selector matching, cascade/specificity.

import { parseCSS, applyStylesheet, css } from './js/css.mjs';

let pass = 0, fail = 0;
function check(n, c) { if (c) { pass++; console.log('PASS: ' + n); } else { fail++; console.log('FAIL: ' + n); } }
const el = (tag, cls, id, parent) => {
  const n = document.createElement(tag || 'view');
  if (cls) n.className = cls;
  if (id) n.id = id;
  if (parent) parent.appendChild(n);
  return n;
};

// --- parsing ---
const rules = parseCSS('.a, .b { color: red; } #x { background-color: #112233; font-size: 12px; }');
check('parses each selector in a group as a rule', rules.length === 3);
check('maps kebab props to camelCase', rules.find(r => r.declarations.backgroundColor) !== undefined);

// --- a small tree to style ---
//   #panel.card  >  .title (text)  +  .body > .badge#hero
const panel = el('view', 'card', 'panel', document.body);
panel.style.width = '200'; panel.style.height = '200';
const title = el('view', 'title', null, panel);
title.style.width = '100'; title.style.height = '40';
const body = el('view', 'body', null, panel);
body.style.width = '100'; body.style.height = '100';
const badge = el('view', 'badge', 'hero', body);
badge.style.width = '50'; badge.style.height = '50';

applyStylesheet(document.body, `
  .card        { background-color: #ff0000; }
  .card .title { background-color: #00ff00; }
  .badge       { background-color: #0000ff; }
  #hero        { background-color: #ffff00; }   /* id beats class -> wins on badge */
`);
host.render();

// sample the panel's uncovered right half (children are 100px wide, panel is 200)
check('class selector applies (panel is red)', host.pixel(panel.offsetLeft + 150, panel.offsetTop + 10) === '#FF0000');
check('descendant selector applies (.card .title is green)', host.pixel(title.offsetLeft + 5, title.offsetTop + 5) === '#00FF00');
check('id specificity beats class (#hero yellow over .badge blue)',
      host.pixel(badge.offsetLeft + 5, badge.offsetTop + 5) === '#FFFF00');

// --- later same-specificity rule wins (source order) ---
const box = el('view', 'z', null, document.body);
box.style.width = '60'; box.style.height = '60';
applyStylesheet(document.body, '.z { background-color: #aaaaaa; } .z { background-color: #00cccc; }');
host.render();
check('later rule of equal specificity wins', host.pixel(box.offsetLeft + 5, box.offsetTop + 5) === '#00CCCC');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
