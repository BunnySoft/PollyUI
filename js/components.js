// components.js — a component-library showcase, like a design-system demo app.
// A sidebar switches between sections; each shows interactive components built
// from PollyUI primitives (Flexbox + text + click events + absolute positioning).
//
// Run:  pollyui.exe js/components.js   then click around the sidebar.

// ---------- helpers ----------
const el = (style, parent) => {
    const n = document.createElement('view');
    if (style) for (const k in style) n.style[k] = style[k];
    if (parent) parent.appendChild(n);
    return n;
};
const text = (str, style, parent) => { const n = el(style, parent); n.textContent = str; return n; };
const clear = (n) => { n.textContent = ''; };

// ---------- palette ----------
const C = {
    page: '#f1f5f9', surface: '#ffffff', border: '#e2e8f0',
    ink: '#0f172a', muted: '#64748b', slate: '#475569',
    primary: '#3b82f6', primarySoft: '#eff6ff',
    success: '#22c55e', warning: '#f59e0b', danger: '#ef4444',
    info: '#0ea5e9', purple: '#8b5cf6', track: '#cbd5e1',
};

// ---------- shell ----------
document.body.style.backgroundColor = C.page;
document.body.style.flexDirection = 'column';

const header = el({
    height: 60, backgroundColor: C.surface, flexDirection: 'row',
    alignItems: 'center', paddingLeft: 20, paddingRight: 20,
}, document.body);
el({ width: 26, height: 26, backgroundColor: C.primary, marginRight: 12 }, header);
text('PollyUI Components', { fontSize: 19, color: C.ink }, header);
el({ flexGrow: 1 }, header);
const vb = el({ backgroundColor: C.primarySoft, paddingLeft: 10, paddingRight: 10, paddingTop: 5, paddingBottom: 5 }, header);
text('v0.1', { fontSize: 13, color: C.primary }, vb);

el({ height: 1, backgroundColor: C.border }, document.body);

const main = el({ flexGrow: 1, flexDirection: 'row' }, document.body);
const sidebar = el({ width: 220, backgroundColor: C.surface, flexDirection: 'column', paddingTop: 12, paddingLeft: 12, paddingRight: 12 }, main);
el({ width: 1, backgroundColor: C.border }, main);
const content = el({ flexGrow: 1, paddingLeft: 28, paddingTop: 24, paddingRight: 28, flexDirection: 'column' }, main);

// ---------- navigation ----------
const SECTIONS = ['Buttons', 'Toggle', 'Tabs', 'Progress', 'Badges', 'Cards'];
const navRefs = {};

SECTIONS.forEach((name) => {
    const item = el({ height: 40, justifyContent: 'center', paddingLeft: 12, marginBottom: 4 }, sidebar);
    const lab = text(name, { fontSize: 15, color: C.muted }, item);
    item.addEventListener('click', () => select(name));
    navRefs[name] = { item, label: lab };
});

function select(name) {
    for (const k in navRefs) {
        const sel = (k === name);
        navRefs[k].item.style.backgroundColor = sel ? C.primarySoft : C.surface;
        navRefs[k].label.style.color = sel ? C.primary : C.muted;
    }
    clear(content);
    RENDER[name](content);
}

// ---------- shared bits ----------
function head(parent, title, sub) {
    text(title, { fontSize: 26, color: C.ink, marginBottom: 4 }, parent);
    if (sub) text(sub, { fontSize: 14, color: C.muted, marginBottom: 20 }, parent);
}
function caption(parent, str) {
    text(str, { fontSize: 12, color: C.muted, marginTop: 16, marginBottom: 10 }, parent);
}
function button(parent, lbl, opts) {
    opts = opts || {};
    const b = el({
        height: opts.h || 40, paddingLeft: opts.px || 18, paddingRight: opts.px || 18,
        backgroundColor: opts.bg || C.primary, alignItems: 'center', justifyContent: 'center',
        marginRight: 10, marginBottom: 10,
    }, parent);
    text(lbl, { fontSize: opts.fs || 15, color: opts.fg || '#ffffff' }, b);
    if (opts.onClick) b.addEventListener('click', opts.onClick);
    return b;
}

// ---------- sections ----------
function renderButtons(root) {
    head(root, 'Buttons', 'Variants, sizes, and click handling.');
    const status = {};

    caption(root, 'VARIANTS');
    const r1 = el({ flexDirection: 'row', flexWrap: 'wrap' }, root);
    [['Primary', C.primary, '#ffffff'], ['Success', C.success, '#ffffff'],
     ['Warning', C.warning, '#ffffff'], ['Danger', C.danger, '#ffffff'],
     ['Secondary', C.border, C.ink]].forEach(([n, bg, fg]) =>
        button(r1, n, { bg, fg, onClick: () => { status.ref.textContent = 'Clicked: ' + n; } }));

    caption(root, 'SIZES');
    const r2 = el({ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' }, root);
    button(r2, 'Small', { h: 30, px: 12, fs: 13 });
    button(r2, 'Medium', { h: 40, px: 18, fs: 15 });
    button(r2, 'Large', { h: 50, px: 24, fs: 18 });

    const bar = el({ marginTop: 12, backgroundColor: C.surface, padding: 14 }, root);
    status.ref = text('Clicked: —', { fontSize: 14, color: C.muted }, bar);
}

function renderToggle(root) {
    head(root, 'Toggle Switch', 'Click a switch to flip it (knob is absolutely positioned).');
    [['Wi-Fi', true], ['Bluetooth', false], ['Notifications', true], ['Dark mode', false]].forEach(([name, init]) => {
        const row = el({ flexDirection: 'row', alignItems: 'center', height: 50 }, root);
        text(name, { fontSize: 15, color: C.ink, width: 200 }, row);
        let on = init;
        const track = el({ width: 52, height: 30, backgroundColor: on ? C.success : C.track }, row);
        const knob = el({ position: 'absolute', top: 3, left: on ? 25 : 3, width: 24, height: 24, backgroundColor: '#ffffff' }, track);
        track.addEventListener('click', () => {
            on = !on;
            track.style.backgroundColor = on ? C.success : C.track;
            knob.style.left = on ? 25 : 3;
        });
    });
}

function renderTabs(root) {
    head(root, 'Tabs', 'Click a tab to switch panels.');
    const tabs = ['Overview', 'Activity', 'Settings'];
    const colors = [C.primary, C.purple, C.info];
    let active = 0;

    const bar = el({ flexDirection: 'row' }, root);
    el({ height: 1, backgroundColor: C.border, marginBottom: 16 }, root);
    const panel = el({ backgroundColor: C.surface, height: 260, padding: 22, flexDirection: 'column' }, root);
    const tabRefs = [];

    function renderPanel() {
        clear(panel);
        el({ width: 64, height: 64, backgroundColor: colors[active], marginBottom: 16 }, panel);
        text(tabs[active], { fontSize: 18, color: C.ink, marginBottom: 8 }, panel);
        text('Content for the "' + tabs[active] + '" tab goes here.', { fontSize: 14, color: C.muted }, panel);
    }
    function styleTabs() {
        tabRefs.forEach((t, i) => {
            const sel = (i === active);
            t.label.style.color = sel ? C.primary : C.muted;
            t.underline.style.backgroundColor = sel ? C.primary : C.surface;
        });
    }
    tabs.forEach((name, i) => {
        const tab = el({ flexDirection: 'column', marginRight: 6, paddingLeft: 16, paddingRight: 16, paddingTop: 10 }, bar);
        const lab = text(name, { fontSize: 15, color: C.muted, marginBottom: 10 }, tab);
        const underline = el({ height: 3, backgroundColor: C.surface }, tab);
        tab.addEventListener('click', () => { active = i; styleTabs(); renderPanel(); });
        tabRefs.push({ label: lab, underline });
    });
    styleTabs();
    renderPanel();
}

function renderProgress(root) {
    head(root, 'Progress', 'Determinate bars (percentage widths).');
    function bar(pct, color) {
        const row = el({ flexDirection: 'row', alignItems: 'center', marginBottom: 16 }, root);
        const track = el({ flexGrow: 1, height: 12, backgroundColor: C.border, marginRight: 12 }, row);
        el({ width: pct + '%', height: 12, backgroundColor: color }, track);
        text(pct + '%', { fontSize: 13, color: C.muted, width: 46 }, row);
    }
    bar(25, C.info);
    bar(50, C.primary);
    bar(75, C.success);

    caption(root, 'INTERACTIVE');
    let pct = 40;
    const track = el({ height: 16, backgroundColor: C.border, marginBottom: 10 }, root);
    const fill = el({ width: pct + '%', height: 16, backgroundColor: C.purple }, track);
    const pctText = text(pct + '%', { fontSize: 15, color: C.ink, marginBottom: 12 }, root);
    const row = el({ flexDirection: 'row' }, root);
    const upd = (d) => {
        pct = Math.max(0, Math.min(100, pct + d));
        fill.style.width = pct + '%';
        pctText.textContent = pct + '%';
    };
    button(row, '− 10', { bg: C.slate, onClick: () => upd(-10) });
    button(row, '+ 10', { bg: C.primary, onClick: () => upd(10) });
}

function chip(parent, lbl, fg, bg) {
    const c = el({ backgroundColor: bg, paddingLeft: 12, paddingRight: 12, paddingTop: 6, paddingBottom: 6, marginRight: 8, marginBottom: 8 }, parent);
    text(lbl, { fontSize: 13, color: fg }, c);
}
function renderBadges(root) {
    head(root, 'Badges', 'Status chips, solid and soft (wrapping row).');
    caption(root, 'SOLID');
    const r1 = el({ flexDirection: 'row', flexWrap: 'wrap' }, root);
    [['Success', C.success], ['Warning', C.warning], ['Error', C.danger], ['Info', C.info],
     ['New', C.purple], ['Active', C.success], ['Beta', C.slate]].forEach(([n, c]) => chip(r1, n, '#ffffff', c));

    caption(root, 'SOFT');
    const r2 = el({ flexDirection: 'row', flexWrap: 'wrap' }, root);
    [['Success', C.success, '#dcfce7'], ['Warning', C.warning, '#fef3c7'], ['Error', C.danger, '#fee2e2'],
     ['Info', C.info, '#e0f2fe'], ['New', C.purple, '#ede9fe']].forEach(([n, fg, bg]) => chip(r2, n, fg, bg));
}

function renderCards(root) {
    head(root, 'Cards', 'Composable surfaces with header, body, and actions.');
    const grid = el({ flexDirection: 'row', flexWrap: 'wrap' }, root);
    [['Analytics', 'Traffic overview', C.primary],
     ['Revenue', 'Monthly earnings', C.success],
     ['Alerts', '3 issues to review', C.danger]].forEach(([title, sub, accent]) => {
        const card = el({ width: 300, backgroundColor: C.surface, marginRight: 16, marginBottom: 16, flexDirection: 'column' }, grid);
        el({ height: 6, backgroundColor: accent }, card);
        const body = el({ padding: 18, flexDirection: 'column' }, card);
        const headRow = el({ flexDirection: 'row', alignItems: 'center', marginBottom: 14 }, body);
        el({ width: 42, height: 42, backgroundColor: accent, marginRight: 12 }, headRow);
        const ht = el({ flexDirection: 'column' }, headRow);
        text(title, { fontSize: 16, color: C.ink }, ht);
        text(sub, { fontSize: 13, color: C.muted }, ht);
        text('Composed from views, text, and Flexbox layout.', { fontSize: 13, color: C.slate, marginBottom: 16 }, body);
        const actions = el({ flexDirection: 'row' }, body);
        button(actions, 'Open', { h: 34, px: 16, fs: 14, bg: accent });
        button(actions, 'Dismiss', { h: 34, px: 16, fs: 14, bg: C.border, fg: C.ink });
    });
}

const RENDER = {
    Buttons: renderButtons, Toggle: renderToggle, Tabs: renderTabs,
    Progress: renderProgress, Badges: renderBadges, Cards: renderCards,
};

select('Buttons');
console.log('components.js: click sections in the sidebar');
