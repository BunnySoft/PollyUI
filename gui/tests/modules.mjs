// modules.mjs — ES module import/export (run with .mjs => module mode).

import multiply, { PI, add } from './gui/tests/mathlib.mjs';

let pass = 0, fail = 0;
function check(n, c) { if (c) { pass++; console.log('PASS: ' + n); } else { fail++; console.log('FAIL: ' + n); } }

check('named export (function)', add(2, 3) === 5);
check('named export (const)', PI === 3.14159);
check('default export', multiply(4, 5) === 20);

// Modules still see the host globals (document, console, host, ...).
const el = document.createElement('view');
el.style.width = '100'; el.style.height = '100';
el.style.backgroundColor = '#123456';
document.body.appendChild(el);
host.render();
check('modules can use the DOM globals', host.pixel(5, 5) === '#123456');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
