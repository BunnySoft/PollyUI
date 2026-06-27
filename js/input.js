// input.js — a sign-in form demonstrating focus + keyboard.
// Click a field (it highlights), type to fill it, Backspace deletes, Tab moves
// between fields. There's no native text widget — these are plain views that
// handle focus/keydown events.

const el = (s, p) => { const n = document.createElement('view'); if (s) for (const k in s) n.style[k] = s[k]; if (p) p.appendChild(n); return n; };
const text = (str, s, p) => { const n = el(s, p); n.textContent = str; return n; };

const C = {
    page: '#f1f5f9', surface: '#ffffff', field: '#f8fafc', focus: '#eff6ff',
    ink: '#0f172a', muted: '#64748b', placeholder: '#94a3b8', primary: '#3b82f6', primaryDown: '#1d4ed8',
};

document.body.style.backgroundColor = C.page;
document.body.style.justifyContent = 'center';
document.body.style.alignItems = 'center';

const card = el({ backgroundColor: C.surface, padding: 32, width: 380, flexDirection: 'column' }, document.body);
text('Sign in', { fontSize: 24, color: C.ink, marginBottom: 4 }, card);
text('Click a field and type. Tab to switch.', { fontSize: 13, color: C.muted, marginBottom: 24 }, card);

function field(labelText, placeholder) {
    text(labelText, { fontSize: 13, color: C.muted, marginBottom: 6 }, card);
    const box = el({
        height: 46, backgroundColor: C.field, marginBottom: 18,
        paddingLeft: 14, paddingRight: 14, justifyContent: 'center',
    }, card);
    box.tabIndex = 0;
    const t = text('', { fontSize: 16, color: C.placeholder }, box);

    let val = '';
    const refresh = () => {
        if (val) { t.style.color = C.ink; t.textContent = val; }
        else     { t.style.color = C.placeholder; t.textContent = placeholder; }
    };
    refresh();

    box.addEventListener('focus', () => { box.style.backgroundColor = C.focus; });
    box.addEventListener('blur',  () => { box.style.backgroundColor = C.field; });
    box.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace') val = val.slice(0, -1);
        else if (e.key.length === 1) val += e.key;
        refresh();
    });
    return box;
}

field('Name', 'Jane Doe');
field('Email', 'jane@example.com');

const btn = el({ height: 46, backgroundColor: C.primary, alignItems: 'center', justifyContent: 'center', marginTop: 6 }, card);
text('Sign in', { fontSize: 16, color: '#ffffff' }, btn);
btn.addEventListener('click', () => { btn.style.backgroundColor = C.primaryDown; });

console.log('input.js: click a field and type; Tab to switch fields');
