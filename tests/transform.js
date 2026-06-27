// transform.js — translate / scale / rotate (paint-space, about the center).

let pass = 0, fail = 0;
function check(n, c) { if (c) { pass++; console.log('PASS: ' + n); } else { fail++; console.log('FAIL: ' + n); } }
const el = (s, p) => { const n = document.createElement('view'); if (s) for (const k in s) n.style[k] = s[k]; if (p) p.appendChild(n); return n; };

// --- translateX: box at (20,20) shifts +100px right ---
const a = el({ width: 50, height: 50, marginLeft: 20, marginTop: 20, backgroundColor: '#ff0000', translateX: 100 }, document.body);
host.render();
check('translateX moves the box right', host.pixel(140, 40) === '#FF0000');
check('original position is now empty', host.pixel(40, 40) === '#FFFFFF');
document.body.removeChild(a);

// --- scale: 50x50 box about its center (45,45) grows to ~100x100 ---
const b = el({ width: 50, height: 50, marginLeft: 20, marginTop: 20, backgroundColor: '#ff0000', scale: 2 }, document.body);
host.render();
check('scale grows past the original box', host.pixel(90, 90) === '#FF0000'); // outside 20..70, inside scaled
check('center stays painted', host.pixel(45, 45) === '#FF0000');
document.body.removeChild(b);

// --- rotate: a wide 80x20 box rotated 90deg becomes tall (20x80) ---
const c = el({ width: 80, height: 20, marginLeft: 60, marginTop: 60, backgroundColor: '#ff0000', rotate: 90 }, document.body);
host.render();
check('rotate 90 paints into the new tall extent', host.pixel(100, 40) === '#FF0000'); // was empty, now covered
check('rotate 90 vacates the old wide extent', host.pixel(130, 70) === '#FFFFFF');     // was covered, now empty
document.body.removeChild(c);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
