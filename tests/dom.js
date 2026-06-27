// dom.js — attributes, id, className/classList, getElementById, querySelector.

let pass = 0, fail = 0;
function check(n, c) { if (c) { pass++; console.log('PASS: ' + n); } else { fail++; console.log('FAIL: ' + n); } }
const el = (s, p, tag) => { const n = document.createElement(tag || 'view'); if (s) for (const k in s) n.style[k] = s[k]; if (p) p.appendChild(n); return n; };

// --- attributes ---
const box = el({}, document.body);
box.setAttribute('data-role', 'card');
check('getAttribute returns the set value', box.getAttribute('data-role') === 'card');
check('hasAttribute is true when present', box.hasAttribute('data-role') === true);
check('getAttribute of a missing attr is null', box.getAttribute('nope') === null);
box.removeAttribute('data-role');
check('removeAttribute clears it', box.getAttribute('data-role') === null && box.hasAttribute('data-role') === false);

// --- id + getElementById ---
box.id = 'hero';
check('id reflects to the id attribute', box.getAttribute('id') === 'hero');
check('getElementById finds the node', document.getElementById('hero') === box);

// --- className + classList ---
box.className = 'a b';
check('className getter', box.className === 'a b');
check('classList.contains', box.classList.contains('a') && box.classList.contains('b'));
box.classList.add('c');
check('classList.add appends', box.classList.contains('c') && box.className === 'a b c');
box.classList.remove('b');
check('classList.remove drops the token', !box.classList.contains('b') && box.className === 'a c');
check('classList.toggle off returns false', box.classList.toggle('a') === false && !box.classList.contains('a'));
check('classList.toggle on returns true', box.classList.toggle('z') === true && box.classList.contains('z'));

// --- querySelector / querySelectorAll ---
const list = el({}, document.body);
const i1 = el({}, list); i1.className = 'item';
const i2 = el({}, list); i2.className = 'item';
const i3 = el({}, list, 'button'); i3.id = 'go';
check('querySelector by class returns the first match', document.querySelector('.item') === i1);
check('querySelectorAll by class counts all', document.querySelectorAll('.item').length === 2);
check('querySelector by id', document.querySelector('#go') === i3);
check('querySelector by tag', document.querySelector('button') === i3);
check('element-scoped querySelector', list.querySelector('.item') === i1);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
