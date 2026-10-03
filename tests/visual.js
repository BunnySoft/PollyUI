// visual.js — linear gradients + image drawing.

let pass = 0, fail = 0;
function check(n, c) { if (c) { pass++; console.log('PASS: ' + n); } else { fail++; console.log('FAIL: ' + n); } }
const el = (s, p) => { const n = document.createElement('view'); if (s) for (const k in s) n.style[k] = s[k]; if (p) p.appendChild(n); return n; };
const rgb = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];

// --- vertical linear gradient red -> blue ---
const g = el({ width: 200, height: 400, margin: 20, gradientFrom: '#ff0000', gradientTo: '#0000ff' }, document.body);
host.render();
const top = rgb(host.pixel(120, 30));    // near top -> red
const bot = rgb(host.pixel(120, 410));   // near bottom -> blue
check('gradient top is reddish', top[0] > 180 && top[2] < 80);
check('gradient bottom is bluish', bot[2] > 180 && bot[0] < 80);
check('gradient blends top->bottom', top[0] > bot[0] && bot[2] > top[2]);
document.body.removeChild(g);

// --- image: snapshot an all-green frame, then draw it back via backgroundImage ---
const fill = el({ width: '100%', height: '100%', backgroundColor: '#00cc00' }, document.body);
host.render();
host.save('build/_imgtest.png');
document.body.removeChild(fill);

const pic = el({ width: 200, height: 150, margin: 30, backgroundImage: 'build/_imgtest.png' }, document.body);
host.render();
check('image draws into the box (shows the saved green)', host.pixel(130, 100) === '#00CC00');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
