// counter.js — an interactive demo using EVERYTHING: text (M4), click events
// (M5), absolute-positioned overlap, and Flexbox layout. Click the + / - buttons.

const el = (style, parent) => {
    const n = document.createElement('view');
    if (style) for (const k in style) n.style[k] = style[k];
    if (parent) parent.appendChild(n);
    return n;
};
const text = (str, style, parent) => {
    const n = el(style, parent);
    n.textContent = str;
    return n;
};

// Center the card in a dark viewport.
document.body.style.backgroundColor = '#0f172a';
document.body.style.justifyContent = 'center';
document.body.style.alignItems = 'center';

const card = el({
    backgroundColor: '#1e293b', padding: 36, alignItems: 'center', width: 360,
}, document.body);

// Overlapping badge poking out of the card's top-right corner (position:absolute).
el({
    position: 'absolute', top: -12, right: -12, width: 28, height: 28,
    backgroundColor: '#ef4444',
}, card);

text('PollyUI Counter', { fontSize: 26, color: '#e2e8f0' }, card);

const value = text('0', { fontSize: 84, color: '#3b82f6' }, card);

// Button row.
const row = el({ flexDirection: 'row', marginTop: 8 }, card);

function button(label, color, onClick) {
    const b = el({
        width: 90, height: 64, margin: 8, backgroundColor: color,
        alignItems: 'center', justifyContent: 'center',
    }, row);
    text(label, { fontSize: 34, color: '#ffffff' }, b);
    b.addEventListener('click', onClick);
    return b;
}

let count = 0;
const render = () => { value.textContent = String(count); };
button('-', '#334155', () => { count--; render(); });
button('+', '#3b82f6', () => { count++; render(); });

console.log('counter.js: click + / - to change the number');
