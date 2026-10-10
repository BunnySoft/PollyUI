// keyboard.js — headless test of focus + keyboard, using the host API:
//   host.click(x,y)  also focuses the focusable element under the point
//   host.key(name)   dispatches a keydown to the focused element ("Tab" cycles)

let pass = 0, fail = 0;
function check(name, cond) {
    if (cond) { pass++; console.log('PASS: ' + name); }
    else      { fail++; console.log('FAIL: ' + name); }
}

// A focusable "text field" that accumulates typed characters.
const field = document.createElement('view');
field.style.width = 300;
field.style.height = 44;
field.style.margin = 30;            // -> occupies (30,30)..(330,74)
field.style.backgroundColor = '#ffffff';
field.tabIndex = 0;
document.body.appendChild(field);

const label = document.createElement('view');
label.style.fontSize = 20;
label.style.color = '#000000';
field.appendChild(label);

let value = '', focused = false;
field.addEventListener('focus', () => { focused = true; field.style.backgroundColor = '#eff6ff'; });
field.addEventListener('blur',  () => { focused = false; field.style.backgroundColor = '#ffffff'; });
field.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace') value = value.slice(0, -1);
    else if (e.key.length === 1) value += e.key;
    label.textContent = value;
});

check('tabIndex round-trips', field.tabIndex === 0);
check('nothing focused initially', document.activeElement === null);

host.click(60, 50);
check('click focuses the field', document.activeElement === field);
check('focus event fired', focused === true);

host.key('H'); host.key('i');
check('typing appends chars', value === 'Hi');
check('text node updated', label.textContent === 'Hi');

host.key('Backspace');
check('Backspace deletes', value === 'H');

host.click(500, 500);               // empty area
check('click outside blurs', document.activeElement === null);
check('blur event fired', focused === false);

// Tab cycling across two focusable elements.
const f2 = document.createElement('view');
f2.tabIndex = 0;
document.body.appendChild(f2);

host.key('Tab');
check('Tab focuses first focusable', document.activeElement === field);
host.key('Tab');
check('Tab advances focus', document.activeElement === f2);
host.key('Tab');
check('Tab wraps around', document.activeElement === field);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
