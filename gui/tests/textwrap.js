// textwrap.js — word-wrap to width + text-align (left/center/right).

let pass = 0, fail = 0;
function check(n, c) { if (c) { pass++; console.log('PASS: ' + n); } else { fail++; console.log('FAIL: ' + n); } }
const make = (s, p) => { const n = document.createElement('view'); if (s) for (const k in s) n.style[k] = s[k]; if (p) p.appendChild(n); return n; };
const txt = (str, s, p) => { const n = make(s, p); n.appendChild(document.createTextNode(str)); return n; };
function hasInk(x0, y0, x1, y1) {
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) if (host.pixel(x, y) !== '#FFFFFF') return true;
    return false;
}
const SENTENCE = 'The quick brown fox jumps over the lazy dog';

// --- narrow box: the sentence wraps onto several lines ---
const narrow = txt(SENTENCE, { width: 120, fontSize: 20, color: '#000000' }, document.body);
host.render();
check('long text wraps (ink on a 3rd line)', hasInk(0, 56, 120, 82));
document.body.removeChild(narrow);

// --- wide box: same text fits on one line (nothing on the 3rd line) ---
const wide = txt(SENTENCE, { width: 600, fontSize: 20, color: '#000000' }, document.body);
host.render();
check('same text stays one line when wide', !hasInk(0, 56, 600, 82));
document.body.removeChild(wide);

// --- text-align: center ---
const cen = txt('Hi', { width: 300, fontSize: 24, color: '#000000', textAlign: 'center' }, document.body);
host.render();
check('centered text leaves the left edge empty', host.pixel(8, 12) === '#FFFFFF');
check('centered text has ink near the middle', hasInk(120, 0, 180, 30));
document.body.removeChild(cen);

// --- text-align: right ---
const rgt = txt('Hi', { width: 300, fontSize: 24, color: '#000000', textAlign: 'right' }, document.body);
host.render();
check('right-aligned text sits near the right edge', hasInk(266, 0, 300, 30));
check('right-aligned text leaves the left empty', host.pixel(8, 12) === '#FFFFFF');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
