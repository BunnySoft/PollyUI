// winui.mjs — a WinUI 3 Gallery-style app on PollyUI. Frameless custom title
// bar + NavigationView, with pages that exercise the real component library:
// the global Naive theme is retinted to Fluent colors (so all 85 components
// render Fluent-blue), plus a pack of Fluent-styled SFC controls (js/fluent.mjs).
//   pollyui js/winui.mjs

import {
  ref, reactive, watch, createApp, h,
  NButton, NInput, NInputNumber, NSelect, NCheckbox, NRadioGroup, NSlider, NRate,
  NDataTable, NList, NTree, NTabs, NModal, NDrawer, NPopover, NTooltip, NTag,
  NProgress, NSteps, NDescriptions, NSpin,
  theme, dialog,
} from './js/pollyui.mjs';
import { animate } from './js/anim.mjs';
import './js/fluent.mjs'; // <fluent-card|button|infobar|toggle|hyperlink|badge|progressbar|expander>

// ---- Fluent palette ---------------------------------------------------------
const C = {
  accent: '#0067C0', bg: '#f3f3f3', card: '#fbfbfb', border: '#e5e5e5',
  text: '#1a1a1a', sub: '#5f6368', rail: '#eaeaec', sel: '#dfdfe2',
};
// Retint the live Naive theme to Fluent so every N* control looks native here.
Object.assign(theme, {
  primary: C.accent, info: C.accent, success: '#0f7b0f', warning: '#9d5d00', error: '#c42b1c',
  text: C.text, textSecondary: C.sub, textDisabled: '#a0a0a0',
  border: C.border, card: '#ffffff', body: C.bg,
  solidText: '#ffffff', railOff: '#d0d0d0', trackBg: '#e9e9e9',
});

const cl = (o) => { const r = {}; for (const k in o) if (o[k] != null) r[k] = o[k]; return r; };
const txt = (s, o = {}) => h('view', { style: cl({ color: o.color || C.text, fontSize: o.size || 14, fontWeight: o.weight, lineHeight: o.lh }) }, s);

// ---- state ------------------------------------------------------------------
const s = reactive({
  nav: 'Basic input', clicks: 0, sound: true, wifi: false, airplane: false, tip: false,
  text: 'Contoso', qty: 1, combo: 'cat', agree: false, plan: 'standard', volume: 40, rating: 3,
  tab: 'all', treeExp: ['fruits'], treeSel: ['apple'], tableSel: [], sortBy: 'name', sortOrder: 'asc',
  modalOpen: false, drawerOpen: false, exp1: true, exp2: false,
});

// ---- title bar (frameless / draggable, OS-aware) ---------------------------
const winCtl = (m) => { if (typeof window !== 'undefined' && window[m]) window[m](); };
const isMac = (typeof window !== 'undefined' && window.platform) === 'macos';

// Windows / Linux: — ▢ ✕ caption buttons on the right.
const winBtn = (g, m, danger) => h('view', { style: cl({ width: 46, height: 40, alignItems: 'center', justifyContent: 'center', appRegion: 'no-drag' }), hoverStyle: { backgroundColor: danger ? '#e81123' : '#e3e3e6' }, onClick: () => winCtl(m) }, txt(g, { size: 11, color: C.sub }));

// macOS uses the real system traffic lights (setTitleBarStyle('overlay')), so the
// app reserves space on the left for them instead of drawing its own.
const titleBar = () => isMac
  ? h('view', { style: cl({ height: 40, flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 80, backgroundColor: C.rail, appRegion: 'drag' }) },
      txt('WinUI 3 Gallery', { size: 12, weight: '600' }),
      h('view', { style: { flexGrow: '1' } }))
  : h('view', { style: cl({ height: 40, flexDirection: 'row', alignItems: 'center', paddingLeft: 14, gap: 10, backgroundColor: C.rail, appRegion: 'drag' }) },
      h('view', { style: cl({ width: 18, height: 18, borderRadius: 4, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' }) }, txt('◆', { size: 10, color: '#fff' })),
      txt('WinUI 3 Gallery', { size: 12, weight: '600' }),
      h('view', { style: { flexGrow: '1' } }),
      winBtn('—', 'minimize'), winBtn('▢', 'maximize'), winBtn('✕', 'close', true));

// ---- NavigationView rail ----------------------------------------------------
const NAV = [['⌂', 'Home'], ['⌨', 'Basic input'], ['▤', 'Collections'], ['◳', 'Dialogs'], ['◐', 'Styles']];
const navItem = ([icon, label]) => { const on = s.nav === label;
  return h('view', { style: cl({ height: 36, flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 12, marginLeft: 4, marginRight: 4, borderRadius: 5, position: 'relative', backgroundColor: on ? C.sel : C.rail }), transition: { duration: 110, props: ['backgroundColor'] }, hoverStyle: { backgroundColor: on ? C.sel : '#e0e0e3' }, onClick: () => s.nav = label },
    h('transition', { duration: 130, enter: { opacity: 0, translateX: -6 }, leave: { opacity: 0, translateX: -6 } },
      on && h('view', { style: cl({ position: 'absolute', left: 0, top: 8, width: 3, height: 20, borderRadius: 2, backgroundColor: C.accent }) })),
    txt(icon, { size: 16, color: on ? C.accent : C.text }), txt(label, { size: 14, weight: on ? '600' : '400' })); };
const navView = () => h('view', { style: cl({ width: 220, backgroundColor: C.rail, paddingTop: 8, flexDirection: 'column', gap: 2 }) }, ...NAV.map(navItem));

// ---- building blocks (WinUI "ControlExample" / "SettingsCard" patterns) -----
const sample = (title, ...body) => h('view', { style: cl({ flexDirection: 'column', gap: 10 }) },
  txt(title, { size: 16, weight: '600' }),
  h('view', { style: cl({ backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 8, padding: 20, gap: 14, flexDirection: 'column' }) }, ...body.filter(Boolean)));

const settingsCard = (icon, title, desc, trailing) => h('view', { style: cl({ flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 8, paddingLeft: 16, paddingRight: 16, paddingTop: 14, paddingBottom: 14 }) },
  h('view', { style: cl({ width: 30, height: 30, borderRadius: 6, backgroundColor: '#eef3f8', alignItems: 'center', justifyContent: 'center' }) }, txt(icon, { size: 15, color: C.accent })),
  h('view', { style: cl({ flexGrow: 1, flexDirection: 'column', gap: 1 }) }, txt(title, { size: 14, weight: '600' }), txt(desc, { size: 12, color: C.sub })),
  trailing);

const row = (...k) => h('view', { style: cl({ flexDirection: 'row', gap: 12, alignItems: 'center', flexWrap: 'wrap' }) }, ...k.filter(Boolean));
const labeled = (label, ctl) => h('view', { style: cl({ flexDirection: 'column', gap: 6 }) }, txt(label, { size: 13, color: C.sub }), ctl);

// ---- page: Home -------------------------------------------------------------
const featureCard = (icon, title, desc) => h('view', { style: cl({ width: 230, flexBasis: 230, flexGrow: 1, minWidth: 200, backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 8, padding: 18, gap: 8, flexDirection: 'column' }) },
  txt(icon, { size: 22, color: C.accent }), txt(title, { size: 15, weight: '600' }), txt(desc, { size: 13, color: C.sub, lh: 18 }));
const stat = (n, l) => h('view', { style: cl({ flexDirection: 'column', gap: 2, paddingRight: 28 }) }, txt(n, { size: 26, weight: 'bold', color: C.accent }), txt(l, { size: 12, color: C.sub }));

const pageHome = () => h('view', { style: cl({ flexDirection: 'column', gap: 18 }) },
  h('view', { style: cl({ backgroundColor: '#eaf2fb', borderWidth: 1, borderColor: '#cfe4f7', borderRadius: 10, padding: 26, flexDirection: 'column', gap: 8 }) },
    txt('A native UI framework, in C + JS', { size: 22, weight: 'bold' }),
    txt('This WinUI 3 Gallery is reimplemented on PollyUI — Skia/ANGLE rendering, Yoga layout, a QuickJS script engine, and a Vue-style component framework. Every control on these pages is drawn by PollyUI, not native WinUI.', { size: 14, color: C.sub, lh: 21 }),
    h('view', { style: { flexDirection: 'row', gap: 10, paddingTop: 6 } },
      h('fluent-button', { accent: true, onClick: () => s.nav = 'Basic input' }, 'Explore controls'),
      h('fluent-hyperlink', { onClick: () => s.nav = 'Styles' }, 'View styles →'))),
  h('view', { style: { flexDirection: 'row', flexWrap: 'wrap', paddingTop: 2, paddingBottom: 2 } },
    stat('90', 'controls'), stat('306', 'tests pass'), stat('0ms', 'idle CPU'), stat('~1ms', 'frame present')),
  h('view', { style: { flexDirection: 'row', gap: 14, flexWrap: 'wrap' } },
    featureCard('◆', 'Skia + ANGLE', 'GPU rendering through ANGLE → D3D11, with a raster fallback.'),
    featureCard('▤', 'Yoga layout', 'Flexbox layout with skip-when-clean incremental recalculation.'),
    featureCard('⌨', 'QuickJS engine', 'A full JS runtime; the framework + every component is plain JS.'),
    featureCard('✶', 'Transitions', 'Declarative tweens + <Transition> enter/leave, render-only fast path.')),
  h('fluent-infobar', { title: 'WinUI on PollyUI', message: 'Switch sections in the navigation rail — each page is built from the live component library.' }));

// ---- page: Basic input ------------------------------------------------------
const PETS = [{ label: 'Cat', value: 'cat' }, { label: 'Dog', value: 'dog' }, { label: 'Bird', value: 'bird' }, { label: 'Fish', value: 'fish' }];
const PLANS = [{ label: 'Free', value: 'free' }, { label: 'Standard', value: 'standard' }, { label: 'Premium', value: 'premium' }];

const pageBasicInput = () => h('view', { style: cl({ flexDirection: 'column', gap: 22 }) },
  sample('Button',
    row(
      h('fluent-button', { accent: true, onClick: () => s.clicks++ }, 'Accent button'),
      h('fluent-button', { onClick: () => s.clicks++ }, 'Standard button'),
      h('fluent-hyperlink', { onClick: () => s.clicks++ }, 'Hyperlink')),
    txt('Clicked ' + s.clicks + ' time' + (s.clicks === 1 ? '' : 's'), { size: 13, color: C.sub })),
  sample('TextBox',
    row(NInput({ id: 'wf-name', value: s.text, onInput: (v) => s.text = v, width: 280, placeholder: 'Enter your name' })),
    txt('Hello, ' + (s.text || '…'), { size: 13, color: C.sub })),
  sample('NumberBox',
    row(NInputNumber({ value: s.qty, onUpdate: (v) => s.qty = v, min: 0, max: 99 }), txt('Quantity: ' + s.qty, { size: 13, color: C.sub }))),
  sample('ComboBox',
    NSelect({ id: 'wf-combo', value: s.combo, options: PETS, onUpdate: (v) => s.combo = v, width: 220 })),
  sample('CheckBox & RadioButtons',
    row(
      labeled('Agreement', NCheckbox({ checked: s.agree, onChange: (v) => s.agree = v }, 'I accept the terms')),
      labeled('Plan', NRadioGroup({ value: s.plan, onUpdate: (v) => s.plan = v, vertical: true, options: PLANS })))),
  sample('Slider',
    row(NSlider({ value: s.volume, onUpdate: (v) => s.volume = v, width: 260 }), txt(s.volume + '%', { size: 13, color: C.sub }))),
  sample('ToggleSwitch',
    row(h('fluent-toggle', { on: s.sound, onToggle: () => s.sound = !s.sound }), txt(s.sound ? 'Sound: On' : 'Sound: Off', { size: 13, color: C.sub }))),
  sample('RatingControl',
    row(NRate({ value: s.rating, onUpdate: (v) => s.rating = v }), txt(s.rating + ' / 5', { size: 13, color: C.sub }))),
  sample('Transition',
    row(h('fluent-button', { accent: true, onClick: () => s.tip = !s.tip }, s.tip ? 'Hide message' : 'Show message')),
    h('transition', { duration: 150, enter: { opacity: 0, translateY: 12 }, leave: { opacity: 0, translateY: 12 } },
      s.tip && h('fluent-infobar', { title: 'Animated InfoBar', message: 'Fades and slides in/out via <transition> — opacity + translateY, no relayout.' }))));

// ---- page: Collections ------------------------------------------------------
const PEOPLE = [
  { name: 'Ada Lovelace', role: 'Engineer', status: 'Active' },
  { name: 'Alan Turing', role: 'Researcher', status: 'Active' },
  { name: 'Grace Hopper', role: 'Architect', status: 'Away' },
  { name: 'Linus Pauling', role: 'Designer', status: 'Offline' },
];
const STATUS_TYPE = { Active: 'success', Away: 'warning', Offline: 'default' };
const TREE = [
  { key: 'fruits', label: 'Fruits', children: [{ key: 'apple', label: 'Apple' }, { key: 'banana', label: 'Banana' }, { key: 'cherry', label: 'Cherry' }] },
  { key: 'veg', label: 'Vegetables', children: [{ key: 'carrot', label: 'Carrot' }, { key: 'pea', label: 'Peas' }] },
];

const pageCollections = () => {
  const sorted = PEOPLE.slice().sort((a, b) => {
    const k = s.sortBy || 'name'; const d = s.sortOrder === 'desc' ? -1 : 1;
    return a[k] < b[k] ? -d : a[k] > b[k] ? d : 0;
  });
  return h('view', { style: cl({ flexDirection: 'column', gap: 22 }) },
    sample('DataGrid',
      NDataTable({
        data: sorted, selectable: true, selectedKeys: s.tableSel, rowKey: (r) => r.name,
        onSelectionChange: (k) => s.tableSel = k,
        sortBy: s.sortBy, sortOrder: s.sortOrder, onSort: (k, o) => { s.sortBy = k; s.sortOrder = o; },
        columns: [
          { title: 'Name', key: 'name', sortable: true },
          { title: 'Role', key: 'role', sortable: true },
          { title: 'Status', key: 'status', width: 130, render: (r) => NTag({ type: STATUS_TYPE[r.status] }, r.status) },
        ],
      }),
      txt(s.tableSel.length + ' selected', { size: 13, color: C.sub })),
    sample('TreeView',
      NTree({ data: TREE, expandedKeys: s.treeExp, selectedKeys: s.treeSel,
        onExpand: (k) => s.treeExp = k, onSelect: (k) => s.treeSel = k })),
    sample('Tabs',
      NTabs({ value: s.tab, onUpdate: (v) => s.tab = v, panes: [
        { name: 'all', label: 'All', content: () => txt('Every item in the collection.', { color: C.sub }) },
        { name: 'fav', label: 'Favorites', content: () => txt('Items you starred.', { color: C.sub }) },
        { name: 'rec', label: 'Recent', content: () => txt('Recently viewed items.', { color: C.sub }) },
      ] })),
    sample('GridView',
      h('view', { style: { flexDirection: 'row', gap: 12, flexWrap: 'wrap' } },
        ...['Photos', 'Music', 'Videos', 'Documents', 'Downloads', 'Desktop'].map((t, i) =>
          h('view', { style: cl({ width: 130, flexBasis: 130, flexGrow: 1, minWidth: 110, height: 84, borderRadius: 8, backgroundColor: '#eef3f8', borderWidth: 1, borderColor: C.border, padding: 12, flexDirection: 'column', justifyContent: 'space-between' }) },
            txt(['🖼', '♪', '▶', '📄', '⬇', '🖥'][i], { size: 18 }), txt(t, { size: 13, weight: '600' }))))));
};

// ---- page: Dialogs ----------------------------------------------------------
const pageDialogs = () => h('view', { style: cl({ flexDirection: 'column', gap: 22 }) },
  sample('ContentDialog',
    row(
      h('fluent-button', { accent: true, onClick: () => s.modalOpen = true }, 'Open dialog'),
      h('fluent-button', { onClick: () => s.drawerOpen = true }, 'Open drawer'))),
  sample('Standard dialogs (dialog API)',
    row(
      NButton({ onClick: () => dialog.info({ title: 'Information', content: 'A Fluent content dialog rendered through the dialog API.', positiveText: 'Got it' }) }, 'Info'),
      NButton({ type: 'success', onClick: () => dialog.success({ title: 'Success', content: 'Your changes were saved.', positiveText: 'Nice' }) }, 'Success'),
      NButton({ type: 'warning', onClick: () => dialog.warning({ title: 'Heads up', content: 'This action needs your attention.', positiveText: 'OK', negativeText: 'Cancel' }) }, 'Warning'),
      NButton({ type: 'error', onClick: () => dialog.error({ title: 'Delete file?', content: 'This cannot be undone.', positiveText: 'Delete', negativeText: 'Cancel' }) }, 'Error'))),
  sample('Flyout & Tooltip',
    row(
      NPopover({ width: 240, content: h('view', { style: { flexDirection: 'column', gap: 6 } }, txt('Flyout', { weight: '600' }), txt('A lightweight popup anchored to its trigger.', { size: 13, color: C.sub })) },
        NButton({}, 'Show flyout')),
      NTooltip({ content: 'A helpful tooltip', placement: 'bottom' }, NButton({}, 'Hover me')))),
  sample('TeachingTip',
    h('fluent-infobar', { title: 'Did you know?', message: 'Overlays render into a top-level layer, so they’re never clipped by scroll containers.' })));

// ---- page: Styles -----------------------------------------------------------
const swatch = (name, color) => h('view', { style: cl({ flexDirection: 'column', gap: 6, alignItems: 'center' }) },
  h('view', { style: cl({ width: 56, height: 56, borderRadius: 8, backgroundColor: color, borderWidth: 1, borderColor: '#00000014' }) }),
  txt(name, { size: 12, color: C.sub }));

const pageStyles = () => h('view', { style: cl({ flexDirection: 'column', gap: 22 }) },
  sample('Typography',
    txt('Display  ·  30px bold', { size: 30, weight: 'bold' }),
    txt('Title  ·  22px semibold', { size: 22, weight: '600' }),
    txt('Subtitle  ·  18px', { size: 18 }),
    txt('Body  ·  14px', { size: 14 }),
    txt('Caption  ·  12px', { size: 12, color: C.sub }),
    h('fluent-hyperlink', { onClick: () => {} }, 'Hyperlink text')),
  sample('Color',
    row(swatch('Accent', C.accent), swatch('Success', '#0f7b0f'), swatch('Caution', '#9d5d00'), swatch('Critical', '#c42b1c'), swatch('Neutral', '#5f6368'))),
  sample('ProgressBar',
    ...[25, 50, 75, 100].map((v) => h('view', { style: { flexDirection: 'row', gap: 12, alignItems: 'center' } },
      h('view', { style: { width: '100%', flexGrow: 1 } }, h('fluent-progressbar', { value: v })),
      txt(v + '%', { size: 12, color: C.sub })))),
  sample('Badges & Tags',
    row(h('fluent-badge', { value: 4 }), h('fluent-badge', { value: 99, color: C.accent }), h('fluent-badge', { value: 'NEW', color: '#0f7b0f' })),
    row(...['default', 'primary', 'success', 'warning', 'error'].map((t) => NTag({ type: t }, t)))),
  sample('Steps',
    NSteps({ current: 1, steps: [{ title: 'Account' }, { title: 'Profile' }, { title: 'Done' }] })),
  h('fluent-expander', { title: 'Acrylic & Mica', expanded: s.exp1, onToggle: () => s.exp1 = !s.exp1 },
    txt('This window requests a Mica backdrop (DWM) and a frameless custom title bar. Material layering composites with the desktop behind the window.', { size: 13, color: C.sub, lh: 19 })),
  h('fluent-expander', { title: 'Loading indicators', expanded: s.exp2, onToggle: () => s.exp2 = !s.exp2 },
    row(NSpin({ size: 28 }), txt('ProgressRing-style spinner (animate by passing a rotation).', { size: 13, color: C.sub }))));

const pages = {
  'Home': pageHome,
  'Basic input': pageBasicInput,
  'Collections': pageCollections,
  'Dialogs': pageDialogs,
  'Styles': pageStyles,
};

// ---- root -------------------------------------------------------------------
const App = {
  setup() {
    if (typeof window !== 'undefined') {
      // macOS: transparent title bar keeping native traffic lights; elsewhere a
      // frameless window with the app-drawn caption.
      if (isMac && window.setTitleBarStyle) window.setTitleBarStyle('overlay');
      else if (window.setFrameless) window.setFrameless(true);
      if (window.setBackdrop) window.setBackdrop(2); // Mica (Win11)
    }
    // Fade the page content in whenever the section changes (the content view
    // persists across nav changes — only its children swap — so drive it live).
    watch(() => s.nav, () => {
      const el = typeof document !== 'undefined' && document.getElementById('page-content');
      if (el) { el.style.opacity = '0'; animate(el, { opacity: [0, 1], translateY: [6, 0] }, { duration: 130, easing: 'easeOutCubic' }); }
    });
    return () => {
      document.body.style.backgroundColor = C.bg;
      const page = (pages[s.nav] || pages.Home)();
      return h('view', { style: cl({ width: '100%', height: '100%', flexDirection: 'column', backgroundColor: C.bg }) },
        titleBar(),
        h('view', { style: cl({ flexDirection: 'row', flexGrow: 1, flexBasis: 0, minHeight: 0 }) },
          navView(),
          h('view', { id: 'page-content', style: cl({ flexGrow: 1, flexBasis: 0, minWidth: 0, minHeight: 0, overflow: 'scroll', paddingTop: 16, paddingLeft: 32, paddingRight: 32, paddingBottom: 32, flexDirection: 'column', gap: 18 }) },
            txt(s.nav, { size: 30, weight: 'bold' }),
            page)),
        // top-level overlays (modal / drawer render full-viewport, gated by state)
        NModal({ show: s.modalOpen, title: 'Save changes?', width: 440, onClose: () => s.modalOpen = false },
          txt('Do you want to save your changes before closing the document?', { size: 14, color: C.sub, lh: 20 }),
          h('view', { style: { flexDirection: 'row', gap: 10, justifyContent: 'flex-end', paddingTop: 6 } },
            NButton({ onClick: () => s.modalOpen = false }, 'Don’t save'),
            NButton({ type: 'primary', onClick: () => s.modalOpen = false }, 'Save'))),
        NDrawer({ show: s.drawerOpen, title: 'Settings', width: 340, onClose: () => s.drawerOpen = false },
          settingsCard('📶', 'Wi-Fi', 'Connect to a wireless network', h('fluent-toggle', { on: s.wifi, onToggle: () => s.wifi = !s.wifi })),
          settingsCard('✈', 'Airplane mode', 'Disable all wireless', h('fluent-toggle', { on: s.airplane, onToggle: () => s.airplane = !s.airplane }))),
        h('overlay-host', {}));
    };
  },
};

createApp(App).mount(document.body);

if (typeof host !== 'undefined') {
  document.body.style.width = '100%'; document.body.style.height = '100%';
  let t = 1000;
  for (const name of ['Home', 'Basic input', 'Collections', 'Dialogs', 'Styles']) {
    s.nav = name; host.flush();
    host.render(t);        // start the page-fade (opacity 0)
    host.render(t + 300);  // advance past it (opacity 1) before capturing
    host.save('build/win-clang/winui-' + name.toLowerCase().replace(/ /g, '-') + '.png');
    t += 1000;
  }
  console.log('winui rendered: ' + Object.keys(pages).join(', '));
}
