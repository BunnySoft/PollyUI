// events.js — bubbling control, preventDefault, pointer types, hover, keyup.

let pass = 0, fail = 0;
function check(n, c) { if (c) { pass++; console.log('PASS: ' + n); } else { fail++; console.log('FAIL: ' + n); } }
const el = (s, p) => { const n = document.createElement('view'); if (s) for (const k in s) n.style[k] = s[k]; if (p) p.appendChild(n); return n; };

// Layout: a parent box with a child box inside it.
const parent = el({ width: 200, height: 200, margin: 20 }, document.body);
const child = el({ width: 100, height: 100, margin: 30 }, parent); // child at ~(50,50)..(150,150)

// --- bubbling: child click reaches parent ---
let log = [];
parent.addEventListener('click', () => log.push('parent'));
child.addEventListener('click', () => log.push('child'));
host.click(80, 80);   // inside child
check('event bubbles child -> parent', log.join(',') === 'child,parent');

// --- stopPropagation: child stops the bubble ---
log = [];
const stopper = (e) => { log.push('child'); e.stopPropagation(); };
child.addEventListener('click', stopper);
host.click(80, 80);
check('stopPropagation blocks the parent', log.indexOf('parent') === -1);
child.removeEventListener('click', stopper);

// --- preventDefault sets defaultPrevented ---
let wasPrevented = null;
child.addEventListener('mousedown', (e) => { e.preventDefault(); wasPrevented = e.defaultPrevented; });
host.mouse('mousedown', 80, 80);
check('preventDefault sets defaultPrevented', wasPrevented === true);

// --- clientX/clientY carried on pointer events ---
let pt = null;
child.addEventListener('mouseup', (e) => { pt = [e.clientX, e.clientY]; });
host.mouse('mouseup', 75, 85);
check('pointer event carries clientX/Y', pt && pt[0] === 75 && pt[1] === 85);

// --- mouseenter / mouseleave as hover moves between elements ---
let hover = [];
child.addEventListener('mouseenter', () => hover.push('enter'));
child.addEventListener('mouseleave', () => hover.push('leave'));
host.mouse('mousemove', 80, 80);    // enter child
host.mouse('mousemove', 5, 5);      // leave to empty space (outside parent)
check('mouseenter then mouseleave fire on hover change', hover.join(',') === 'enter,leave');

// --- keyup (distinct from keydown) ---
let keys = [];
child.tabIndex = 0;
child.focus();
child.addEventListener('keydown', (e) => keys.push('down:' + e.key));
child.addEventListener('keyup', (e) => keys.push('up:' + e.key));
host.key('a');            // default type = keydown
host.key('a', 'keyup');   // explicit keyup
check('keydown + keyup dispatch separately', keys.join(',') === 'down:a,up:a');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
