// anim.mjs — tween interpolation, easing, completion (deterministic timestamps).

import { animate, easings, fadeIn } from './js/anim.mjs';

let pass = 0, fail = 0;
function check(n, c) { if (c) { pass++; console.log('PASS: ' + n); } else { fail++; console.log('FAIL: ' + n); } }
const approx = (a, b, eps = 0.001) => Math.abs(a - b) < eps;

// --- easing functions ---
check('linear midpoint', approx(easings.linear(0.5), 0.5));
check('easeInQuad midpoint', approx(easings.easeInQuad(0.5), 0.25));
check('easings clamp endpoints', easings.easeOutCubic(0) === 0 && approx(easings.easeOutCubic(1), 1));

// --- linear tween of two props over a fixed timeline ---
const box = document.createElement('view');
box.style.width = '100'; box.style.height = '100';
box.style.opacity = '0'; box.style.translateX = '0';
box.style.backgroundColor = '#3366ff';
document.body.appendChild(box);

let completed = false, lastP = -1;
animate(box, { opacity: [0, 1], translateX: [0, 200] },
        { duration: 1000, easing: 'linear', onUpdate: (p) => { lastP = p; }, onComplete: () => { completed = true; } });

host.render(0);     // frame 0: progress 0
check('start: opacity 0', approx(parseFloat(box.style.opacity), 0));
host.render(250);   // 25%
check('quarter: opacity 0.25', approx(parseFloat(box.style.opacity), 0.25));
host.render(500);   // 50%
check('half: opacity 0.5', approx(parseFloat(box.style.opacity), 0.5));
check('half: translateX 100', approx(parseFloat(box.style.translateX), 100));
check('not complete before the end', completed === false);
host.render(1000);  // 100%
check('end: opacity 1', approx(parseFloat(box.style.opacity), 1));
check('end: translateX 200', approx(parseFloat(box.style.translateX), 200));
check('onComplete fired', completed === true);
check('onUpdate saw progress 1', approx(lastP, 1));

host.render(1200);  // past the end: no further rAF scheduled, value stays
check('value stays put after completion', approx(parseFloat(box.style.opacity), 1));
document.body.removeChild(box);

// --- fadeIn helper resolves its promise ---
const b2 = document.createElement('view');
b2.style.width = '50'; b2.style.height = '50'; b2.style.backgroundColor = '#000000';
document.body.appendChild(b2);
let faded = false;
fadeIn(b2, { duration: 100, easing: 'linear' }).then(() => { faded = true; });
host.render(0);
host.render(100);   // reaches the end -> promise resolves
host.flush();       // run the microtask (.then) that sets faded
check('fadeIn resolves its promise', faded === true);
check('fadeIn ends fully opaque', approx(parseFloat(b2.style.opacity), 1));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
