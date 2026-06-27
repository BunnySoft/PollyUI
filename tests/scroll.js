// scroll.js — overflow clipping, scrollTop translation, wheel default-scroll.

let pass = 0, fail = 0;
function check(n, c) { if (c) { pass++; console.log('PASS: ' + n); } else { fail++; console.log('FAIL: ' + n); } }
const el = (s, p) => { const n = document.createElement('view'); if (s) for (const k in s) n.style[k] = s[k]; if (p) p.appendChild(n); return n; };

// A 100x100 viewport at (20,20) containing a tall column of colored rows.
// overflow:scroll clips children to the box and enables wheel scrolling.
const view = el({ width: 100, height: 100, margin: 20, overflow: 'scroll' }, document.body);
const rows = el({ flexDirection: 'column' }, view);
el({ width: 100, height: 60, backgroundColor: '#ff0000' }, rows);  // row0  y 20..80
el({ width: 100, height: 60, backgroundColor: '#00ff00' }, rows);  // row1  y 80..140 (below the box)
el({ width: 100, height: 60, backgroundColor: '#0000ff' }, rows);  // row2  y 140..200
host.render();

// --- clipping: content past the 100px box (y >= 120) is not painted ---
check('row0 visible at top of viewport', host.pixel(60, 40) === '#FF0000');
check('content below the box is clipped', host.pixel(60, 140) === '#FFFFFF');

// --- programmatic scrollTop translates children up ---
check('scrollTop starts at 0', view.scrollTop === 0);
view.scrollTop = 60;            // pull row1 (green) to the top of the box
host.render();
check('scrollTop reflects back', view.scrollTop === 60);
check('after scroll, green row is at the top', host.pixel(60, 40) === '#00FF00');
check('red row scrolled out of view', host.pixel(60, 40) !== '#FF0000');

// --- hit-testing accounts for scroll: a click at the top now hits row1 ---
let hitColor = null;
[...rows.childNodes].forEach((r, i) => r.addEventListener('click', () => { hitColor = i; }));
host.click(60, 40);            // top of viewport -> row index 1 after scrolling 60px
check('click hit-tests through the scroll offset', hitColor === 1);

// --- wheel performs default scroll, clamped to content ---
view.scrollTop = 0; host.render();
host.scroll(60, 60, 40);       // wheel down by 40
check('wheel scrolls the container down', view.scrollTop === 40);
host.scroll(60, 60, 10000);    // wheel far past the end
check('wheel scroll clamps to content height', view.scrollTop === 80); // 180 content - 100 box

console.log('\n' + pass + ' passed, ' + fail + ' failed');
