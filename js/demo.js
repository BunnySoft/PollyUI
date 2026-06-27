// demo.js — a showcase of PollyUI's completed features (M0–M3).
//
// Everything here is plain JavaScript driving native QuickJS -> DOM -> Yoga
// (Flexbox) -> Skia. It builds a dashboard-style layout from nested flex
// containers. There's no text yet (that's M4), so UI elements are suggested
// with colored blocks. Resize the window: flexGrow makes it reflow live.
//
// Features demonstrated:
//   • document.createElement / appendChild / el.style.*   (DOM bridge, M2)
//   • nested flexDirection row/column                      (Yoga, M3)
//   • flexGrow responsive sizing                           (Yoga, M3)
//   • justifyContent / alignItems                          (Yoga, M3)
//   • padding / margin                                     (Yoga, M3)
//   • backgroundColor via #hex                             (Skia paint, M3)

// Tiny helper: create an element, apply a style object, attach to a parent.
function el(style, parent) {
    const n = document.createElement('view');
    if (style) for (const k in style) n.style[k] = style[k];
    if (parent) parent.appendChild(n);
    return n;
}

const C = {
    bg:      '#0f172a', // app background  (slate-900)
    panel:   '#1e293b', // panels / cards  (slate-800)
    chip:    '#334155', // inert chips     (slate-700)
    blue:    '#3b82f6',
    green:   '#22c55e',
    amber:   '#f59e0b',
    red:     '#ef4444',
    purple:  '#a855f7',
};

// Root.
document.body.style.backgroundColor = C.bg;
document.body.style.flexDirection = 'column';

// ---- Header bar ----
const header = el({
    height: 56, backgroundColor: C.panel,
    flexDirection: 'row', alignItems: 'center', padding: 12,
}, document.body);

el({ width: 32, height: 32, backgroundColor: C.blue, margin: 4 }, header); // logo
el({ flexGrow: 1 }, header);                                               // spacer
el({ width: 28, height: 28, backgroundColor: C.chip, margin: 4 }, header); // nav
el({ width: 28, height: 28, backgroundColor: C.chip, margin: 4 }, header);
el({ width: 28, height: 28, backgroundColor: C.green, margin: 4 }, header); // "online" dot

// ---- Main area (sidebar + content) ----
const main = el({ flexGrow: 1, flexDirection: 'row' }, document.body);

// Sidebar with menu items (first one "selected").
const sidebar = el({
    width: 200, backgroundColor: C.panel, flexDirection: 'column', padding: 12,
}, main);
const menuColors = [C.blue, C.chip, C.chip, C.chip, C.chip];
for (const color of menuColors) {
    el({ height: 36, backgroundColor: color, margin: 4 }, sidebar);
}
el({ flexGrow: 1 }, sidebar);                                  // push footer down
el({ height: 44, backgroundColor: C.chip, margin: 4 }, sidebar); // "profile" block

// Content column.
const content = el({
    flexGrow: 1, backgroundColor: C.bg, flexDirection: 'column', padding: 16,
}, main);

// A row of stat cards, each with a colored accent strip on top.
const stats = el({ flexDirection: 'row', height: 96 }, content);
for (const accent of [C.blue, C.green, C.amber, C.red]) {
    const card = el({
        flexGrow: 1, backgroundColor: C.panel, margin: 6, flexDirection: 'column',
    }, stats);
    el({ height: 6, backgroundColor: accent }, card);  // accent strip (stretches)
    el({ flexGrow: 1 }, card);                          // card body
    el({ height: 14, backgroundColor: C.chip, margin: 10 }, card); // "value" bar
}

// A large chart placeholder that grows to fill remaining space.
const chart = el({
    flexGrow: 1, backgroundColor: C.panel, margin: 6,
    flexDirection: 'row', alignItems: 'flex-end', padding: 16,
}, content);
// Fake bar chart: bars of varying height pinned to the bottom.
const heights = [40, 90, 60, 120, 80, 150, 70, 110, 95, 130];
for (const h of heights) {
    el({ flexGrow: 1, height: h, backgroundColor: C.purple, margin: 4 }, chart);
}

// Footer with two right-aligned "buttons".
const footer = el({
    height: 56, flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center',
}, content);
el({ width: 96, height: 32, backgroundColor: C.chip, margin: 6 }, footer);
el({ width: 96, height: 32, backgroundColor: C.blue, margin: 6 }, footer);

console.log('demo.js: dashboard built — resize the window to see Flexbox reflow');
