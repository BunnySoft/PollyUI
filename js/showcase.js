// showcase.js — a gallery of PollyUI's rendering features.
// Windowed:  pollyui js/showcase.js
// Snapshot:  pollyui --test js/showcase.js   (writes build/win-clang/showcase.png)

const make = (tag, style, parent) => {
  const n = document.createElement(tag || 'view');
  if (style) for (const k in style) n.style[k] = style[k];
  if (parent) parent.appendChild(n);
  return n;
};
const text = (str, style, parent) => {
  const box = make('view', style, parent);
  box.appendChild(document.createTextNode(str));
  return box;
};

document.body.style.backgroundColor = '#0f172a';
document.body.style.padding = '24';
document.body.style.gap = '20';

// --- Header with a gradient banner + drop shadow ---
const header = make('view', {
  height: '90', borderRadius: '16', padding: '20',
  gradientFrom: '#6366f1', gradientTo: '#ec4899', gradientDir: 'horizontal',
  shadowColor: '#00000066', shadowBlur: '24', shadowY: '8',
  justifyContent: 'center',
}, document.body);
text('PollyUI — Feature Showcase', { color: '#ffffff', fontSize: '28', fontWeight: 'bold' }, header);

// --- Row of cards: rounded corners, borders, shadows ---
const row = make('view', { flexDirection: 'row', gap: '16', height: '140' }, document.body);
const card = (title, body, accent) => {
  const c = make('view', {
    flexGrow: '1', backgroundColor: '#1e293b', borderRadius: '12', padding: '16', gap: '8',
    borderWidth: '2', borderColor: accent, shadowColor: '#00000055', shadowBlur: '16', shadowY: '6',
  }, row);
  text(title, { color: accent, fontSize: '18', fontWeight: 'bold' }, c);
  text(body, { color: '#cbd5e1', fontSize: '14' }, c);
  return c;
};
card('Gradients', 'Linear, H or V', '#22d3ee');
card('Shadows', 'Blurred + offset', '#f59e0b');
card('Borders', 'Width + radius', '#34d399');

// --- A transformed "NEW" badge floating over a panel ---
const panel = make('view', {
  height: '120', backgroundColor: '#111827', borderRadius: '12', padding: '16',
  position: 'relative', justifyContent: 'center',
}, document.body);
text('Transforms — rotate / scale / translate', { color: '#e5e7eb', fontSize: '16', fontStyle: 'italic' }, panel);
const badge = make('view', {
  position: 'absolute', top: '12', right: '16', width: '64', height: '64',
  backgroundColor: '#ef4444', borderRadius: '32', rotate: '15', justifyContent: 'center', alignItems: 'center',
}, panel);
text('NEW', { color: '#ffffff', fontWeight: 'bold', fontSize: '16' }, badge);

// --- A scrollable list (overflow: scroll) ---
const list = make('view', {
  height: '120', backgroundColor: '#1e293b', borderRadius: '12', overflow: 'scroll', padding: '8', gap: '6',
}, document.body);
const palette = ['#ef4444', '#f59e0b', '#22d3ee', '#34d399', '#6366f1', '#ec4899', '#a78bfa', '#f472b6'];
palette.forEach((col, i) =>
  text('Scrollable row ' + (i + 1), {
    height: '34', backgroundColor: col, borderRadius: '8', paddingLeft: '12', justifyContent: 'center',
    color: '#0f172a', fontWeight: 'bold',
  }, list));
list.scrollTop = 40; // start partway down

// --- Snapshot when run headless (host present); silently skipped when windowed ---
if (typeof host !== 'undefined') {
  host.render();
  host.save('build/win-clang/showcase.png');
  console.log('wrote build/win-clang/showcase.png');
}
