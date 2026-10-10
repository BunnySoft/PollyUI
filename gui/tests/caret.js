// caret.js — headless test of measureText + caret/editing logic.

let pass = 0, fail = 0;
function check(name, cond) {
    if (cond) { pass++; console.log('PASS: ' + name); }
    else      { fail++; console.log('FAIL: ' + name); }
}

check('measureText returns positive width', measureText('Hello', 16) > 0);
check('wider text measures wider', measureText('Hello World', 16) > measureText('Hi', 16));
check('empty string measures 0', measureText('', 16) === 0);
check('bigger font measures wider', measureText('Hi', 32) > measureText('Hi', 12));

// A focusable field with caret/editing logic.
const box = document.createElement('view');
box.style.width = 300; box.style.height = 44; box.style.margin = 20;
box.style.backgroundColor = '#ffffff';
box.tabIndex = 0;
document.body.appendChild(box);
const t = document.createElement('view');
box.appendChild(t);

let value = '', caretIndex = 0;
box.addEventListener('keydown', (e) => {
    const k = e.key;
    if      (k === 'Backspace') { if (caretIndex > 0) { value = value.slice(0, caretIndex - 1) + value.slice(caretIndex); caretIndex--; } }
    else if (k === 'ArrowLeft') { if (caretIndex > 0) caretIndex--; }
    else if (k === 'ArrowRight'){ if (caretIndex < value.length) caretIndex++; }
    else if (k === 'Home')      { caretIndex = 0; }
    else if (k === 'End')       { caretIndex = value.length; }
    else if (k.length === 1)    { value = value.slice(0, caretIndex) + k + value.slice(caretIndex); caretIndex++; }
    t.textContent = value;
});

host.click(40, 40); // focus the field
'abc'.split('').forEach((ch) => host.key(ch));
check('typed "abc"', value === 'abc' && caretIndex === 3);

host.key('ArrowLeft'); host.key('ArrowLeft');
check('ArrowLeft moves caret to 1', caretIndex === 1);

host.key('X');
check('insert at caret', value === 'aXbc' && caretIndex === 2);

host.key('Home');
check('Home -> caret 0', caretIndex === 0);

host.key('End');
check('End -> caret at end', caretIndex === 4);

host.key('Backspace');
check('Backspace deletes before caret', value === 'aXb' && caretIndex === 3);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
