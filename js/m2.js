// m2.js — exercises the M2 DOM Model + bridge.
// Builds a tree via the DOM API and asserts the bridge behaves correctly
// (object identity, navigation, style round-trip, lifetime).

let pass = 0, fail = 0;
function assert(name, cond) {
    if (cond) { pass++; console.log('PASS: ' + name); }
    else      { fail++; console.log('FAIL: ' + name); }
}

const root = document.body;
assert('document.body exists', !!root);
assert('body.nodeType === 1 (element)', root.nodeType === 1);
assert('body.tagName', root.tagName === 'body');

// --- create + style ---
const card = document.createElement('view');
card.style.width = 240;
card.style.height = 140;
card.style.backgroundColor = '#3b82f6';
card.style.flexDirection = 'column';
root.appendChild(card);

assert('appendChild sets parentNode', card.parentNode === root);
assert('wrapper identity is stable', root.firstChild === root.firstChild);
assert('body.firstChild === card', root.firstChild === card);
assert('tagName', card.tagName === 'view');
assert('style round-trips (number coerced to string)', card.style.width === '240');
assert('style round-trips (color)', card.style.backgroundColor === '#3b82f6');
assert('style read of unset prop is undefined', card.style.nope === undefined);

// --- text nodes + navigation ---
const a = document.createTextNode('Hello');
const b = document.createTextNode('World');
card.appendChild(a);
card.appendChild(b);
assert('childNodes length', card.childNodes.length === 2);
assert('a.nodeType === 3 (text)', a.nodeType === 3);
assert('nextSibling', a.nextSibling === b);
assert('previousSibling', b.previousSibling === a);
assert('lastChild === b', card.lastChild === b);
assert('textContent gathers descendants', card.textContent === 'HelloWorld');

// --- removeChild ---
card.removeChild(a);
assert('removeChild updates count', card.childNodes.length === 1);
assert('removed node parentNode is null', a.parentNode === null);

// --- insertBefore ---
card.insertBefore(a, b);
assert('insertBefore restores order', card.firstChild === a && a.nextSibling === b);

// --- textContent setter on an element replaces children ---
const label = document.createElement('text');
label.textContent = 'Click me';
root.appendChild(label);
assert('textContent setter creates one text child', label.childNodes.length === 1);
assert('textContent setter round-trips', label.textContent === 'Click me');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
