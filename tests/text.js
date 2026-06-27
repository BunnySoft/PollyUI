// text.js — bold/italic weight + multi-line ('\n') rendering.

let pass = 0, fail = 0;
function check(n, c) { if (c) { pass++; console.log('PASS: ' + n); } else { fail++; console.log('FAIL: ' + n); } }
const el = (s, p) => { const n = document.createElement('view'); if (s) for (const k in s) n.style[k] = s[k]; if (p) p.appendChild(n); return n; };
function hasInk(x0, y0, x1, y1) {
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) if (host.pixel(x, y) !== '#FFFFFF') return true;
    return false;
}
function inkCount(x0, y0, x1, y1) {
    let c = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (host.pixel(x, y) !== '#FFFFFF') c++;
    return c;
}

// --- measureText respects weight + length ---
check('bold is at least as wide as normal', measureText('Hello World', 24, 700) >= measureText('Hello World', 24, 400));
check('width grows with text length', measureText('WWWWWWWW', 24) > measureText('ii', 24));

// --- bold renders visibly more ink than normal ---
const tb = el({ fontSize: 36, color: '#000000' }, document.body);
tb.appendChild(document.createTextNode('BOLD'));
tb.style.fontWeight = 'normal'; host.render();
const inkN = inkCount(0, 0, 160, 48);
tb.style.fontWeight = 'bold'; host.render();
const inkB = inkCount(0, 0, 160, 48);
check('bold renders more ink than normal', inkB > inkN);
document.body.removeChild(tb);

// --- multi-line: a '\n' produces a second line of text ---
const blk = el({ fontSize: 40, color: '#000000' }, document.body);
const tn = document.createTextNode('HELLO\nWORLD');
blk.appendChild(tn);
host.render();
check('two-line text draws ink on the lower line', hasInk(0, 55, 300, 95));
tn.textContent = 'HELLO';
host.render();
check('removing the newline clears the lower line', !hasInk(0, 55, 300, 95));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
