// style.js — headless test of paint (radius/border/opacity) + layout (display:none).

let pass = 0, fail = 0;
function check(n, c) { if (c) { pass++; console.log('PASS: ' + n); } else { fail++; console.log('FAIL: ' + n); } }
const el = (s, p) => { const n = document.createElement('view'); if (s) for (const k in s) n.style[k] = s[k]; if (p) p.appendChild(n); return n; };

// --- borderRadius: corners are clipped away ---
const a = el({ width: 200, height: 200, margin: 50, backgroundColor: '#3b82f6', borderRadius: 40 }, document.body);
host.render();
check('rounded box center is bg', host.pixel(150, 150) === '#3B82F6');
check('rounded corner clipped to background', host.pixel(52, 52) === '#FFFFFF');
document.body.removeChild(a);

// --- border: stroke on the edge ---
const b = el({ width: 100, height: 100, margin: 20, backgroundColor: '#ffffff', borderColor: '#ef4444', borderWidth: 6 }, document.body);
host.render();
check('border edge is border color', host.pixel(23, 70) === '#EF4444');
check('inside the border is background', host.pixel(70, 70) === '#FFFFFF');
document.body.removeChild(b);

// --- opacity: black @ 0.5 over white -> mid gray ---
const c = el({ width: 100, height: 100, margin: 20, backgroundColor: '#000000', opacity: 0.5 }, document.body);
host.render();
const rr = parseInt(host.pixel(70, 70).slice(1, 3), 16);
check('opacity 0.5 blends black->gray', rr > 110 && rr < 145);
document.body.removeChild(c);

// --- display:none collapses layout (no space, not painted) ---
const row = el({ flexDirection: 'row', margin: 10 }, document.body);
el({ width: 50, height: 50, backgroundColor: '#ff0000' }, row);                       // a -> (10,10)
el({ width: 50, height: 50, backgroundColor: '#00ff00', display: 'none' }, row);       // hidden -> 0 width
el({ width: 50, height: 50, backgroundColor: '#0000ff' }, row);                       // c -> (60,10)
host.render();
check('display:none collapses (blue sits where green would)', host.pixel(80, 30) === '#0000FF');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
