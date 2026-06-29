// winui.mjs — a WinUI 3 Gallery-style demo on PollyUI: frameless custom title
// bar, a NavigationView rail, and pages of Fluent controls (authored as Vue SFCs
// in js/fluent.mjs, used here as custom element tags).
//   pollyui js/winui.mjs

import { ref, reactive, watch, createApp, h } from './js/pollyui.mjs';
import { animate } from './js/anim.mjs';
import './js/fluent.mjs'; // registers <fluent-card>, <fluent-button>, <fluent-infobar>, <fluent-toggle>

// ---- Fluent palette ---------------------------------------------------------
const C = {
  accent: '#0067C0', bg: '#f3f3f3', card: '#fbfbfb', border: '#e5e5e5',
  text: '#1a1a1a', sub: '#5f6368', rail: '#eaeaec', sel: '#dfdfe2',
};
const cl = (o) => { const r = {}; for (const k in o) if (o[k] != null) r[k] = o[k]; return r; };
const txt = (s, o = {}) => h('view', { style: cl({ color: o.color || C.text, fontSize: o.size || 14, fontWeight: o.weight }) }, s);

// ---- state ------------------------------------------------------------------
const s = reactive({ nav: 'Basic input', clicks: 0, sound: true, wifi: false, airplane: false, tip: false });

// ---- title bar (frameless / draggable) -------------------------------------
const winCtl = (m) => { if (typeof window !== 'undefined' && window[m]) window[m](); };
const winBtn = (g, m, danger) => h('view', { style: cl({ width: 46, height: 40, alignItems: 'center', justifyContent: 'center', appRegion: 'no-drag' }), hoverStyle: { backgroundColor: danger ? '#e81123' : '#e3e3e6' }, onClick: () => winCtl(m) }, txt(g, { size: 11, color: C.sub }));
const titleBar = () => h('view', { style: cl({ height: 40, flexDirection: 'row', alignItems: 'center', paddingLeft: 14, gap: 10, backgroundColor: C.rail, appRegion: 'drag' }) },
  h('view', { style: cl({ width: 18, height: 18, borderRadius: 4, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' }) }, txt('◆', { size: 10, color: '#fff' })),
  txt('WinUI 3 Gallery', { size: 12, weight: '600' }),
  h('view', { style: { flexGrow: '1' } }),
  winBtn('—', 'minimize'), winBtn('▢', 'maximize'), winBtn('✕', 'close', true));

// ---- NavigationView rail ----------------------------------------------------
const NAV = [['⌂', 'Home'], ['⌨', 'Basic input'], ['▤', 'Collections'], ['◳', 'Dialogs'], ['◐', 'Styles']];
const navItem = ([icon, label]) => { const on = s.nav === label;
  // base background color-fades between rail<->selected; the accent bar slides
  // in/out via <transition>. (Engine hover overrides instantly, by design.)
  return h('view', { style: cl({ height: 36, flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 12, marginLeft: 4, marginRight: 4, borderRadius: 5, position: 'relative', backgroundColor: on ? C.sel : C.rail }), transition: { duration: 160, props: ['backgroundColor'] }, hoverStyle: { backgroundColor: on ? C.sel : '#e0e0e3' }, onClick: () => s.nav = label },
    h('transition', { duration: 180, enter: { opacity: 0, translateX: -6 }, leave: { opacity: 0, translateX: -6 } },
      on && h('view', { style: cl({ position: 'absolute', left: 0, top: 8, width: 3, height: 20, borderRadius: 2, backgroundColor: C.accent }) })),
    txt(icon, { size: 16, color: on ? C.accent : C.text }), txt(label, { size: 14, weight: on ? '600' : '400' })); };
const navView = () => h('view', { style: cl({ width: 220, backgroundColor: C.rail, paddingTop: 8, flexDirection: 'column', gap: 2 }) }, ...NAV.map(navItem));

// ---- control sample card (WinUI "ControlExample" pattern) -------------------
const sample = (title, ...body) => h('view', { style: cl({ flexDirection: 'column', gap: 10 }) },
  txt(title, { size: 16, weight: '600' }),
  h('view', { style: cl({ backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 8, padding: 20, gap: 14, flexDirection: 'column' }) }, ...body.filter(Boolean)));

// a WinUI SettingsCard row (icon + title/desc + trailing control)
const settingsCard = (icon, title, desc, trailing) => h('view', { style: cl({ flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 8, paddingLeft: 16, paddingRight: 16, paddingTop: 14, paddingBottom: 14 }) },
  h('view', { style: cl({ width: 30, height: 30, borderRadius: 6, backgroundColor: '#eef3f8', alignItems: 'center', justifyContent: 'center' }) }, txt(icon, { size: 15, color: C.accent })),
  h('view', { style: cl({ flexGrow: 1, flexDirection: 'column', gap: 1 }) }, txt(title, { size: 14, weight: '600' }), txt(desc, { size: 12, color: C.sub })),
  trailing);

const row = (...k) => h('view', { style: cl({ flexDirection: 'row', gap: 12, alignItems: 'center', flexWrap: 'wrap' }) }, ...k.filter(Boolean));

// ---- pages ------------------------------------------------------------------
const pageBasicInput = () => h('view', { style: cl({ flexDirection: 'column', gap: 22 }) },
  sample('Button',
    row(
      h('fluent-button', { accent: true, onClick: () => s.clicks++ }, 'Accent button'),
      h('fluent-button', { onClick: () => s.clicks++ }, 'Standard button')),
    txt('Clicked ' + s.clicks + ' time' + (s.clicks === 1 ? '' : 's'), { size: 13, color: C.sub })),
  sample('ToggleSwitch',
    row(h('fluent-toggle', { on: s.sound, onToggle: () => s.sound = !s.sound }), txt(s.sound ? 'Sound: On' : 'Sound: Off', { size: 13, color: C.sub }))),
  sample('InfoBar',
    h('fluent-infobar', { title: 'Update available', message: 'A new version of the Gallery is ready to install.' })),
  sample('Transition',
    row(h('fluent-button', { accent: true, onClick: () => s.tip = !s.tip }, s.tip ? 'Hide message' : 'Show message')),
    h('transition', { duration: 220, enter: { opacity: 0, translateY: 12 }, leave: { opacity: 0, translateY: 12 } },
      s.tip && h('fluent-infobar', { title: 'Animated InfoBar', message: 'Fades and slides in/out via <transition> — opacity + translateY, no relayout.' }))),
  txt('Settings', { size: 16, weight: '600' }),
  h('view', { style: cl({ flexDirection: 'column', gap: 8 }) },
    settingsCard('📶', 'Wi-Fi', 'Connect to a wireless network', h('fluent-toggle', { on: s.wifi, onToggle: () => s.wifi = !s.wifi })),
    settingsCard('✈', 'Airplane mode', 'Turn off all wireless communication', h('fluent-toggle', { on: s.airplane, onToggle: () => s.airplane = !s.airplane }))));

const pageGeneric = (name, blurb) => h('view', { style: cl({ flexDirection: 'column', gap: 16 }) },
  h('fluent-card', { title: name }, txt(blurb, { size: 14, color: C.sub })),
  h('fluent-infobar', { title: 'WinUI on PollyUI', message: 'Every control here is a Vue SFC drawn with Skia — no native WinUI.' }));

const pages = {
  'Basic input': pageBasicInput,
  'Home': () => pageGeneric('Welcome', 'A WinUI 3 Gallery-style app, reimplemented on PollyUI with Fluent controls authored as Vue single-file components.'),
  'Collections': () => pageGeneric('Collections', 'ListView / GridView / TreeView samples would live here.'),
  'Dialogs': () => pageGeneric('Dialogs', 'ContentDialog / TeachingTip / Flyout samples would live here.'),
  'Styles': () => pageGeneric('Styles', 'Acrylic, Mica, typography ramp and color samples would live here.'),
};

// ---- root -------------------------------------------------------------------
const App = {
  setup() {
    if (typeof window !== 'undefined' && window.setFrameless) window.setFrameless(true);
    if (typeof window !== 'undefined' && window.setBackdrop) window.setBackdrop(2); // Mica (Win11)
    // Fade the page content in whenever the section changes. We drive this
    // imperatively (animate the live element) rather than declaratively because
    // the content view persists across nav changes — only its children swap.
    watch(() => s.nav, () => {
      const el = typeof document !== 'undefined' && document.getElementById('page-content');
      if (el) { el.style.opacity = '0'; animate(el, { opacity: [0, 1], translateY: [8, 0] }, { duration: 240, easing: 'easeOutCubic' }); }
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
        h('overlay-host', {}));
    };
  },
};

createApp(App).mount(document.body);

if (typeof host !== 'undefined') {
  document.body.style.width = '100%'; document.body.style.height = '100%';
  host.render(); host.save('build/win-clang/winui.png');
  s.nav = 'Home'; host.flush(); host.render(); host.save('build/win-clang/winui-home.png');
  console.log('winui rendered: basic-input + home');
}
