// textfield.js — a real text field with a blinking caret.
// Click a field and type; the caret blinks, moves with Arrow/Home/End, and
// characters insert at the caret. The caret is positioned with measureText()
// and absolute positioning; the blink is a setTimeout loop.

const el = (s, p) => { const n = document.createElement('view'); if (s) for (const k in s) n.style[k] = s[k]; if (p) p.appendChild(n); return n; };
const text = (str, s, p) => { const n = el(s, p); n.textContent = str; return n; };
const C = { page: '#0f172a', card: '#1e293b', field: '#0b1220', focus: '#0e1a2f', ink: '#e2e8f0', placeholder: '#64748b', primary: '#3b82f6' };
const FS = 17;

document.body.style.backgroundColor = C.page;
document.body.style.justifyContent = 'center';
document.body.style.alignItems = 'center';

const card = el({ backgroundColor: C.card, padding: 32, width: 440, flexDirection: 'column' }, document.body);
text('Text field with caret', { fontSize: 22, color: C.ink, marginBottom: 4 }, card);
text('Click a field and type. Arrow / Home / End move the caret.', { fontSize: 13, color: C.placeholder, marginBottom: 24 }, card);

let activeField = null, blinkOn = true;

function field(label, placeholder, autofocus) {
    text(label, { fontSize: 13, color: C.placeholder, marginBottom: 6 }, card);
    const box = el({ height: 48, backgroundColor: C.field, marginBottom: 18, paddingLeft: 14, paddingRight: 14, justifyContent: 'center' }, card);
    box.tabIndex = 0;
    const content = el({ height: 22, justifyContent: 'center' }, box);
    const t = text('', { fontSize: FS, color: C.placeholder }, content);
    const caret = el({ position: 'absolute', left: 0, top: 0, width: 2, height: 22, backgroundColor: 'transparent' }, content);

    let value = '', caretIndex = 0, focused = false;

    function renderCaret() {
        caret.style.left = measureText(value.slice(0, caretIndex), FS);
        caret.style.backgroundColor = (focused && blinkOn) ? C.primary : 'transparent';
    }
    function refresh() {
        if (value) { t.style.color = C.ink; t.textContent = value; }
        else       { t.style.color = C.placeholder; t.textContent = placeholder; }
        renderCaret();
    }
    const api = { renderCaret };

    box.addEventListener('focus', () => { focused = true; blinkOn = true; activeField = api; box.style.backgroundColor = C.focus; refresh(); });
    box.addEventListener('blur',  () => { focused = false; if (activeField === api) activeField = null; box.style.backgroundColor = C.field; refresh(); });
    box.addEventListener('keydown', (e) => {
        const k = e.key;
        if      (k === 'Backspace') { if (caretIndex > 0) { value = value.slice(0, caretIndex - 1) + value.slice(caretIndex); caretIndex--; } }
        else if (k === 'Delete')    { value = value.slice(0, caretIndex) + value.slice(caretIndex + 1); }
        else if (k === 'ArrowLeft') { if (caretIndex > 0) caretIndex--; }
        else if (k === 'ArrowRight'){ if (caretIndex < value.length) caretIndex++; }
        else if (k === 'Home')      { caretIndex = 0; }
        else if (k === 'End')       { caretIndex = value.length; }
        else if (k.length === 1)    { value = value.slice(0, caretIndex) + k + value.slice(caretIndex); caretIndex++; }
        blinkOn = true;
        refresh();
    });
    refresh();
    if (autofocus) box.focus();
    return api;
}

field('Name', 'Type your name', true);
field('Email', 'you@example.com');

// Blink the focused field's caret (~530ms), driven by the event loop.
(function blink() { blinkOn = !blinkOn; if (activeField) activeField.renderCaret(); setTimeout(blink, 530); })();

console.log('textfield.js: click a field and type; the caret blinks and moves');
