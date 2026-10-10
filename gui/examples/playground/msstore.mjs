// msstore.mjs — a Microsoft Store (Windows 11 / Fluent) demo built on PollyUI.
//   pollyui gui/examples/playground/msstore.mjs
// Pages: Home (hero + trending), Games (poster grid), Detail (product page).
// No image assets — icons/posters are gradient tiles, styled to match Fluent.

import { createApp, ref, h, NOverlayHost } from './gui/sdk/js/pollyui.mjs';

// ---- Fluent palette ---------------------------------------------------------
const C = {
  accent: '#0067C0', accentHover: '#1975C5', body: '#f5f5f7', rail: '#eeeef0',
  card: '#ffffff', text: '#1a1a1a', sub: '#5f6368', border: '#e6e6e6',
  green: '#107C10', amber: '#f2a900', dark: '#26303a',
};
const cl = (o) => { const r = {}; for (const k in o) if (o[k] != null) r[k] = o[k]; return r; };
const txt = (s, o = {}) => h('view', { style: cl({ color: o.color || C.text, fontSize: o.size || 14, fontWeight: o.weight, letterSpacing: o.ls }) }, s);
const initials = (n) => n.split(/[\s:&-]+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();

// ---- data -------------------------------------------------------------------
const games = [
  { name: 'Roblox', pub: 'Roblox Corporation', price: 'Free', badge: null, g: ['#d94a3d', '#a8322a'], cat: 'Action & adventure' },
  { name: 'Minecraft Launcher', pub: 'Mojang', price: 'Free', badge: 'Game Pass', g: ['#5fb854', '#3d8b40'], cat: 'Adventure' },
  { name: 'eFootball', pub: 'Konami', price: 'Free', badge: null, g: ['#2c3e50', '#161f29'], cat: 'Sports' },
  { name: 'Fortnite', pub: 'Epic Games', price: 'Free', badge: null, g: ['#5b6dd8', '#3a4bb0'], cat: 'Action' },
  { name: 'Asphalt Legends', pub: 'Gameloft', price: 'Free', badge: 'Game Pass', g: ['#16a085', '#0c5d4c'], cat: 'Racing' },
  { name: 'Minecraft Java & Bedrock', pub: 'Mojang', price: '$29.99', badge: 'Game Pass', g: ['#7cb342', '#4e7a26'], cat: 'Adventure' },
  { name: 'Call of Duty Warzone', pub: 'Activision', price: 'Free', badge: 'Game Pass', g: ['#37474f', '#161d21'], cat: 'Shooter' },
  { name: 'Modern Warfare II', pub: 'Activision', price: 'Free', badge: 'Game Pass', g: ['#455a64', '#1c262b'], cat: 'Shooter' },
  { name: 'Modern Warfare III', pub: 'Activision', price: 'Free', badge: 'Game Pass', g: ['#6d4c41', '#3e2723'], cat: 'Shooter' },
  { name: 'Candy Crush Saga', pub: 'King', price: 'Free', badge: null, g: ['#f39c12', '#d35400'], cat: 'Puzzle' },
  { name: 'Angry Birds 2', pub: 'Rovio', price: 'Free', badge: null, g: ['#e74c3c', '#b03224'], cat: 'Puzzle' },
  { name: 'Asphalt 8 Airborne', pub: 'Gameloft', price: 'Free', badge: null, g: ['#2980b9', '#1a5276'], cat: 'Racing' },
];
const apps = [
  { name: 'Discord', pub: 'Discord Inc.', price: 'Free', c: '#5865F2', cat: 'Social' },
  { name: 'ChatGPT', pub: 'OpenAI', price: 'Free', c: '#10a37f', cat: 'Productivity' },
  { name: 'WhatsApp', pub: 'Meta', price: 'Free', c: '#25D366', cat: 'Social' },
  { name: 'Netflix', pub: 'Netflix Inc.', price: 'Free', c: '#E50914', cat: 'Entertainment' },
  { name: 'Instagram', pub: 'Meta', price: 'Free', c: '#E1306C', cat: 'Social' },
  { name: 'WhatsApp Beta', pub: 'Meta', price: 'Free', c: '#128C7E', cat: 'Social' },
];

// ---- hero carousel slides ---------------------------------------------------
const HERO = [
  { tag: 'New Season', title: 'THE BEAR', sub: 'Now Streaming on Hulu', g: ['#1b4965', '#0a2540'], action: () => games[0] },
  { tag: 'Now Available', title: 'STARFIELD', sub: 'Explore a thousand planets', g: ['#3d2b56', '#190f30'], action: () => games[6] },
  { tag: 'Featured', title: 'FORZA HORIZON 5', sub: 'Race across Mexico', g: ['#1f7a33', '#0c3318'], action: () => games[4] },
  { tag: 'New Movie', title: 'DUNE: PART TWO', sub: 'Stream the epic now', g: ['#8a5a2b', '#3e2710'], action: () => games[3] },
  { tag: 'Trending', title: 'HALO INFINITE', sub: 'Master Chief returns', g: ['#0d47a1', '#05224d'], action: () => games[1] },
];

// ---- state ------------------------------------------------------------------
const page = ref('home');     // 'home' | 'games' | 'detail'
const nav = ref('Home');
const sel = ref(games[0]);
const heroIndex = ref(0);
const open = (item) => { sel.value = item; page.value = 'detail'; };

// Auto-advance the hero every 4.5s with setTimeout, NOT a requestAnimationFrame
// loop: a perpetual rAF loop reschedules every frame, and the frame pump treats
// "a rAF callback ran" as "repaint needed" -> a full 60fps repaint at idle
// (~20-30% CPU). setTimeout only wakes every 4.5s -> ~0% idle CPU. It's started
// only in the windowed app (a pending timer would keep the headless --test run
// loop alive forever).
let _heroOn = false;
function startHeroCarousel() {
  if (_heroOn) return; _heroOn = true;
  const tick = () => { heroIndex.value = (heroIndex.value + 1) % HERO.length; setTimeout(tick, 4500); };
  setTimeout(tick, 4500);
}

// ---- shared pieces ----------------------------------------------------------
const tile = (item, size, radius) => {
  const c = item.g ? item.g[0] : item.c, c2 = item.g ? item.g[1] : item.c;
  return h('view', { style: cl({ width: size, height: size, borderRadius: radius, gradientFrom: c, gradientTo: c2, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }) },
    txt(initials(item.name), { color: '#ffffff', size: Math.round(size * 0.32), weight: 'bold' }));
};
const storeBtn = (label, o = {}) => h('view', {
  style: cl({ height: 32, paddingLeft: 22, paddingRight: 22, borderRadius: 4, backgroundColor: o.bg || C.accent, alignItems: 'center', justifyContent: 'center' }),
  hoverStyle: { backgroundColor: o.hover || C.accentHover }, onClick: o.onClick,
}, txt(label, { color: '#ffffff', size: 14, weight: '600' }));

const ratingBadge = (label, desc) => h('view', { style: cl({ flexDirection: 'row', gap: 8, alignItems: 'center' }) },
  h('view', { style: cl({ width: 22, height: 22, borderRadius: 3, borderWidth: 1, borderColor: C.sub, alignItems: 'center', justifyContent: 'center' }) }, txt('▣', { size: 12, color: C.sub })),
  h('view', { style: { flexDirection: 'column' } }, txt(label, { size: 11, weight: '600' }), desc ? txt(desc, { size: 10, color: C.sub }) : null));

// ---- sidebar ----------------------------------------------------------------
const NAV_TOP = [['⌂', 'Home'], ['⊞', 'Apps'], ['◉', 'Gaming'], ['✦', 'AI Hub'], ['◐', 'Themes']];
const NAV_BOT = [['✸', "What's New"], ['⤓', 'Downloads'], ['▤', 'Library']];
const sideItem = ([icon, label]) => {
  const active = nav.value === label;
  return h('view', {
    style: cl({ height: 54, borderRadius: 6, alignItems: 'center', justifyContent: 'center', gap: 3, position: 'relative', backgroundColor: active ? C.card : 'transparent' }),
    hoverStyle: { backgroundColor: active ? C.card : '#e3e3e6' },
    onClick: () => { nav.value = label; if (label === 'Home') page.value = 'home'; else if (label === 'Gaming') page.value = 'games'; },
  },
    active ? h('view', { style: cl({ position: 'absolute', left: 0, top: 15, width: 3, height: 24, borderRadius: 2, backgroundColor: C.accent }) }) : null,
    txt(icon, { size: 18, color: active ? C.accent : C.text }),
    txt(label, { size: 10, color: active ? C.accent : C.sub }));
};
const sidebar = () => h('view', { style: cl({ width: 66, backgroundColor: C.rail, paddingTop: 10, paddingLeft: 6, paddingRight: 6, gap: 4, flexDirection: 'column' }) },
  ...NAV_TOP.map(sideItem), h('view', { style: { flexGrow: '1' } }), ...NAV_BOT.map(sideItem));

// ---- top bar (doubles as the custom title bar in frameless mode) ------------
// Window controls; the host's `window` object exists only in the windowed app.
const winCtl = (m) => { if (typeof window !== 'undefined' && window[m]) window[m](); };
const winBtn = (c, m, danger) => h('view', { style: cl({ width: 46, height: 48, alignItems: 'center', justifyContent: 'center', appRegion: 'no-drag' }), hoverStyle: { backgroundColor: danger ? '#e81123' : '#e1e1e3' }, onClick: () => winCtl(m) }, txt(c, { size: 11, color: C.sub }));
// `appRegion: 'drag'` marks the bar draggable; interactive children opt out with
// 'no-drag' so their clicks aren't swallowed by the window move.
const noDrag = { appRegion: 'no-drag' };
const topbar = () => h('view', { style: cl({ height: 48, flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 10, backgroundColor: C.rail, borderColor: C.border, borderBottomWidth: 1, appRegion: 'drag' }) },
  h('view', { style: cl({ width: 32, height: 32, borderRadius: 4, alignItems: 'center', justifyContent: 'center', ...noDrag }), hoverStyle: { backgroundColor: '#e1e1e3' }, onClick: () => { page.value = 'home'; nav.value = 'Home'; } }, txt('‹', { size: 20, color: C.sub })),
  txt('Microsoft Store', { size: 13, weight: '600' }),
  h('view', { style: { flexGrow: '1', flexDirection: 'row', justifyContent: 'center' } },
    h('view', { style: cl({ width: 460, height: 32, borderRadius: 6, backgroundColor: C.card, borderWidth: 1, borderColor: C.border, flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 12, ...noDrag }), hoverStyle: { borderColor: '#c4c4c4' } },
      txt('⌕', { size: 15, color: C.sub }), txt('Search apps, games, and more', { size: 13, color: C.sub }))),
  h('view', { style: cl({ width: 30, height: 30, borderRadius: 15, backgroundColor: '#d6d6d8', alignItems: 'center', justifyContent: 'center', ...noDrag }) }, txt('◔', { size: 14, color: '#666' })),
  h('view', { style: { width: '8' } }),
  winBtn('—', 'minimize'), winBtn('▢', 'maximize'), winBtn('✕', 'close', true));

// ---- section header ---------------------------------------------------------
const secHead = (title, onMore) => h('view', { style: cl({ flexDirection: 'row', alignItems: 'center', gap: 8 }), onClick: onMore },
  txt(title, { size: 20, weight: 'bold' }), txt('›', { size: 20, color: C.sub }));

// ---- HOME -------------------------------------------------------------------
const heroSmall = (title, grad, h0) => h('view', { style: cl({ height: h0, borderRadius: 8, overflow: 'hidden', gradientFrom: grad[0], gradientTo: grad[1], padding: 16, justifyContent: 'flex-end' }) },
  txt(title, { color: '#ffffff', size: 16, weight: 'bold' }));

// Cards flex to fill the row but keep a minimum width via flexBasis; the row
// wraps (flexWrap) so when the window is too narrow the cards drop to the next
// line instead of squishing below a usable size — a responsive grid.
// flexBasis = the wrap threshold (≈ min width); maxWidth caps growth so a lone
// card on the last wrapped line can't stretch to full width.
const homeGameCard = (g) => h('view', {
  style: cl({ flexGrow: 1, flexBasis: 140, minWidth: 140, maxWidth: 220, borderRadius: 8, overflow: 'hidden', backgroundColor: C.card, borderWidth: 1, borderColor: C.border }),
  hoverStyle: { borderColor: '#c4c4c4' }, onClick: () => open(g),
},
  h('view', { style: cl({ height: 96, gradientFrom: g.g[0], gradientTo: g.g[1], alignItems: 'center', justifyContent: 'center' }) }, txt(initials(g.name), { color: '#ffffff', size: 30, weight: 'bold' })),
  h('view', { style: cl({ padding: 10, gap: 4 }) }, txt(g.name, { size: 13, weight: '600' }), txt(g.price, { size: 12, color: C.sub })));

const homeAppCard = (a) => h('view', {
  style: cl({ flexGrow: 1, flexBasis: 225, minWidth: 225, maxWidth: 360, flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 8, backgroundColor: C.card, borderWidth: 1, borderColor: C.border }),
  hoverStyle: { borderColor: '#c4c4c4' }, onClick: () => open(a),
},
  tile(a, 48, 10),
  h('view', { style: { flexGrow: '1', flexDirection: 'column', gap: '2' } }, txt(a.name, { size: 14, weight: '600' }), txt(a.cat, { size: 12, color: C.sub })),
  txt(a.price, { size: 12, color: C.sub }));

// A section: heading + a responsive wrapping grid of cards (gap applies to both
// the row gaps and the gaps between wrapped lines).
const rowSection = (title, cards, onMore) => h('view', { style: cl({ flexDirection: 'column', gap: 14 }) },
  secHead(title, onMore),
  h('view', { style: cl({ flexDirection: 'row', flexWrap: 'wrap', gap: 16 }) }, ...cards));

const heroBanner = () => { const s = HERO[heroIndex.value];
  // flexBasis:0 + minWidth:0 so the banner's width comes from flexGrow (filling
  // the space left of the fixed 340px promo column), NOT from its title text —
  // otherwise a long title ("DUNE: PART TWO") + the 340 column overflows the row
  // (Yoga won't shrink a content-basis flex child), pushing the side cards under
  // the scrollbar.
  return h('view', { style: cl({ flexGrow: 2, flexBasis: 0, minWidth: 0, borderRadius: 8, overflow: 'hidden', gradientFrom: s.g[0], gradientTo: s.g[1], padding: 28, justifyContent: 'flex-end', gap: 10 }) },
    txt(s.tag, { color: '#cfe3ef', size: 13, weight: '600' }),
    txt(s.title, { color: '#ffffff', size: 38, weight: 'bold', ls: 1 }),
    txt(s.sub, { color: '#bcd3e0', size: 13 }),
    h('view', { style: { width: '90' } }, storeBtn('Get', { onClick: () => open(s.action()) }))); };

const heroDots = () => h('view', { style: cl({ flexDirection: 'row', gap: 6, justifyContent: 'center' }) },
  ...HERO.map((_, i) => { const on = heroIndex.value === i;
    return h('view', { style: cl({ width: on ? 18 : 6, height: 6, borderRadius: 3, backgroundColor: on ? C.accent : '#c8c8cc' }),
      hoverStyle: { backgroundColor: on ? C.accent : '#a8a8ac' }, onClick: () => { heroIndex.value = i; } }); }));

const home = () => h('view', { style: cl({ flexDirection: 'column', gap: 28, paddingTop: 4 }) },
  // hero: auto-advancing carousel (left) + fixed-width promo cards (right, so the
  // row never overflows the content width — which would hide the v-scrollbar)
  h('view', { style: cl({ flexDirection: 'row', gap: 16, height: 230 }) },
    heroBanner(),
    h('view', { style: cl({ width: 340, flexShrink: 0, flexDirection: 'column', gap: 12 }) },
      heroSmall('30 years of JAY-Z', ['#3a3a3a', '#111111'], 110),
      h('view', { style: cl({ flexDirection: 'row', gap: 12, height: 108 }) },
        h('view', { style: cl({ flexGrow: 1, flexBasis: 0, minWidth: 0 }) }, heroSmall('Flight Simulator 2024', ['#5a7d9a', '#2c4a63'], 108)),
        h('view', { style: cl({ flexGrow: 1, flexBasis: 0, minWidth: 0 }) }, heroSmall('Score With XBOX', ['#107C10', '#0b5e0b'], 108))))),
  heroDots(),
  rowSection('Trending games', games.slice(0, 6).map(homeGameCard), () => { page.value = 'games'; nav.value = 'Gaming'; }),
  rowSection('Trending apps', apps.slice(0, 4).map(homeAppCard)),
  rowSection('Top free games', games.slice(6, 12).map(homeGameCard)));

// ---- GAMES (poster grid) ----------------------------------------------------
const poster = (g) => h('view', {
  style: cl({ width: 168, borderRadius: 8, overflow: 'hidden', backgroundColor: C.card, borderWidth: 1, borderColor: C.border }),
  hoverStyle: { borderColor: '#bdbdbd' }, onClick: () => open(g),
},
  h('view', { style: cl({ height: 210, gradientFrom: g.g[0], gradientTo: g.g[1], alignItems: 'center', justifyContent: 'center', position: 'relative', paddingLeft: 8, paddingRight: 8 }) },
    g.badge ? h('view', { style: cl({ position: 'absolute', top: 0, left: 0, right: 0, height: 22, backgroundColor: C.green, alignItems: 'center', justifyContent: 'center' }) }, txt(g.badge, { color: '#ffffff', size: 11, weight: '600' })) : null,
    txt(g.name, { color: '#ffffff', size: 17, weight: 'bold' })),
  h('view', { style: cl({ padding: 10, gap: 4 }) }, txt(g.name, { size: 13, weight: '600' }), txt(g.price, { size: 12, color: C.sub })));

const gamesPage = () => h('view', { style: cl({ flexDirection: 'column', gap: 18 }) },
  h('view', { style: cl({ flexDirection: 'row', alignItems: 'center' }) },
    txt('Trending games', { size: 26, weight: 'bold' }),
    h('view', { style: { flexGrow: '1' } }),
    h('view', { style: cl({ flexDirection: 'row', gap: 6, alignItems: 'center', height: 32, paddingLeft: 12, paddingRight: 12, borderRadius: 4, borderWidth: 1, borderColor: C.border, backgroundColor: C.card }), hoverStyle: { backgroundColor: '#f0f0f2' } },
      txt('☰', { size: 13, color: C.sub }), txt('Filters', { size: 13 }), txt('▾', { size: 11, color: C.sub }))),
  h('view', { style: cl({ flexDirection: 'row', gap: 16, flexWrap: 'wrap' }) }, ...games.concat(games.slice(0, 6)).map(poster)));

// ---- DETAIL -----------------------------------------------------------------
const infoCell = (label, value) => h('view', { style: cl({ width: 200, flexDirection: 'column', gap: 3 }) },
  txt(label, { size: 12, color: C.sub }), txt(value, { size: 13, color: C.accent }));
const ratingBar = (frac) => h('view', { style: cl({ flexDirection: 'row', alignItems: 'center', gap: 8 }) },
  h('view', { style: cl({ width: 200, height: 8, borderRadius: 4, backgroundColor: '#e9e9ec', overflow: 'hidden' }) },
    h('view', { style: cl({ width: Math.round(frac * 200), height: 8, backgroundColor: C.amber }) })));
const card = (...kids) => h('view', { style: cl({ backgroundColor: C.card, borderRadius: 8, borderWidth: 1, borderColor: C.border, padding: 22, flexDirection: 'column', gap: 14 }) }, ...kids.filter(Boolean));
const sectionTitle = (t) => txt(t, { size: 18, weight: 'bold' });

const discoverRow = (g) => h('view', { style: cl({ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 8, borderRadius: 6 }), hoverStyle: { backgroundColor: '#f0f0f2' }, onClick: () => open(g) },
  h('view', { style: cl({ width: 56, height: 40, borderRadius: 6, gradientFrom: g.g[0], gradientTo: g.g[1], alignItems: 'center', justifyContent: 'center', position: 'relative' }) },
    g.badge ? h('view', { style: cl({ position: 'absolute', top: 0, left: 0, right: 0, height: 12, backgroundColor: C.green }) }) : null,
    txt(initials(g.name), { color: '#ffffff', size: 13, weight: 'bold' })),
  h('view', { style: { flexGrow: '1', flexDirection: 'column', gap: '2' } }, txt(g.name, { size: 13, weight: '600' })),
  txt(g.price, { size: 12, color: C.sub }));

const detail = () => {
  const s = sel.value;
  return h('view', { style: cl({ flexDirection: 'row', gap: 24 }) },
    // main column
    h('view', { style: cl({ flexGrow: 1, flexDirection: 'column', gap: 18 }) },
      // header
      h('view', { style: cl({ flexDirection: 'row', gap: 20, alignItems: 'flex-start' }) },
        tile(s, 100, 18),
        h('view', { style: cl({ flexGrow: 1, flexDirection: 'column', gap: 8 }) },
          txt(s.name + ' - Windows', { size: 28, weight: 'bold' }),
          txt(s.pub || 'Publisher', { size: 13, color: C.accent }),
          h('view', { style: cl({ flexDirection: 'row', gap: 8, alignItems: 'center' }) },
            txt('4.0', { size: 13 }), txt('★★★★☆', { size: 14, color: C.amber }), txt('16K ratings', { size: 13, color: C.sub }),
            txt('•', { size: 13, color: C.sub }), txt((s.cat || 'Apps') + ' +3', { size: 13, color: C.accent })),
          h('view', { style: cl({ flexDirection: 'row', gap: 12, alignItems: 'center', paddingTop: 4 }) },
            h('view', { style: { width: '120' } }, storeBtn(s.price === 'Free' ? 'Get' : s.price, {})),
            h('view', { style: cl({ width: 32, height: 32, borderRadius: 4, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' }), hoverStyle: { backgroundColor: '#f0f0f2' } }, txt('⇪', { size: 14, color: C.sub }))),
          h('view', { style: { paddingTop: '4' } }, ratingBadge('TEEN', 'Diverse Content. Discretion Advised.')))),
      // screenshots
      card(sectionTitle('Screenshots'),
        h('view', { style: cl({ flexDirection: 'row', gap: 12 }) },
          ...[0, 1, 2].map(i => h('view', { style: cl({ flexGrow: 1, height: 150, borderRadius: 6, gradientFrom: s.g ? s.g[0] : s.c, gradientTo: s.g ? s.g[1] : s.c, alignItems: 'center', justifyContent: 'center' }) }, txt('▷', { size: 22, color: '#ffffffcc' }))))),
      // description
      card(sectionTitle('Description'),
        txt(s.name.toUpperCase() + ' — GREAT EXPERIENCES ACROSS EVERY GENRE. PLAY FREE.', { size: 13, weight: '600' }),
        h('view', { style: { flexDirection: 'column', gap: '6' } },
          txt('The range of experiences is unmatched. Relax with cooking, building and', { size: 13, color: C.sub }),
          txt('simulator games, or jump into racing, shooter battles, and survival games.', { size: 13, color: C.sub })),
        txt('Show more', { size: 13, color: C.accent })),
      // ratings
      card(sectionTitle('Ratings and reviews'),
        h('view', { style: cl({ flexDirection: 'row', gap: 28, alignItems: 'center' }) },
          h('view', { style: cl({ flexDirection: 'column', gap: 2, alignItems: 'center' }) },
            txt('4.0', { size: 46, weight: 'bold' }), txt('★★★★☆', { size: 14, color: C.amber }), txt('16,457 ratings', { size: 12, color: C.sub })),
          h('view', { style: cl({ flexDirection: 'column', gap: 5 }) }, ...[0.7, 0.15, 0.06, 0.04, 0.05].map(ratingBar))),
        h('view', { style: cl({ height: 1, backgroundColor: C.border }) }),
        h('view', { style: cl({ flexDirection: 'column', gap: 4 }) },
          txt('★★★★★  WORST UPDATE   ·   David Sir', { size: 13, weight: '600' }),
          txt('Remove rl ava and afces we grew with classic, bring classic face back. Giving for free to make a feel good sir.', { size: 13, color: C.sub }))),
      // features
      card(sectionTitle('Features'),
        ...['Millions of experiences', 'Explore together anytime, anywhere', 'Be anything you can imagine', 'Chat with friends'].map(f =>
          h('view', { style: cl({ flexDirection: 'row', gap: 10, alignItems: 'center' }) }, txt('•', { size: 14, color: C.accent }), txt(f, { size: 13 })))),
      // system requirements
      card(sectionTitle('System Requirements'),
        h('view', { style: cl({ flexDirection: 'row', gap: 10, alignItems: 'center' }) },
          h('view', { style: cl({ width: 18, height: 18, borderRadius: 9, backgroundColor: C.green, alignItems: 'center', justifyContent: 'center' }) }, txt('✓', { size: 11, color: '#ffffff' })),
          txt('This product should work on your device.', { size: 13 }))),
      // additional info
      card(sectionTitle('Additional information'),
        h('view', { style: cl({ flexDirection: 'row', flexWrap: 'wrap', gap: 20 }) },
          infoCell('Published by', s.pub || '—'), infoCell('Release date', '9/12/2025'), infoCell('Genres', s.cat || 'Apps'),
          infoCell('Approximate size', '342.2 MB'), infoCell('Installation', 'Install on a Windows PC'), infoCell('Supported languages', 'English (United States)')))),
    // discover sidebar
    h('view', { style: cl({ width: 280, flexDirection: 'column', gap: 4 }) },
      h('view', { style: { paddingLeft: '8', paddingBottom: '6' } }, secHead('Discover more')),
      ...games.slice(1, 8).map(discoverRow)));
};

// ---- root -------------------------------------------------------------------
const App = {
  setup() {
    if (typeof host === 'undefined') startHeroCarousel(); // windowed only (a pending timer would hang --test)
    if (typeof window !== 'undefined' && window.setFrameless) window.setFrameless(true); // custom title bar

    return () => {
      document.body.style.backgroundColor = C.body;
      const content = page.value === 'home' ? home() : page.value === 'games' ? gamesPage() : detail();
      return h('view', { style: cl({ width: '100%', height: '100%', flexDirection: 'column', backgroundColor: C.body }) },
        topbar(),
        // flexBasis:0 + flexGrow:1 makes the row fill exactly the space below the
        // top bar (Yoga defaults flex-shrink to 0, so a content-basis row would
        // never shrink into the viewport and overflow:scroll wouldn't engage).
        h('view', { style: cl({ flexDirection: 'row', flexGrow: 1, flexBasis: 0, minHeight: 0 }) },
          sidebar(),
          h('view', { id: 'mc', style: cl({ flexGrow: 1, flexBasis: 0, minWidth: 0, minHeight: 0, overflow: 'scroll', paddingTop: 20, paddingLeft: 32, paddingRight: 32, paddingBottom: 32, backgroundColor: C.body }) },
            content)),
        NOverlayHost());
    };
  },
};

createApp(App).mount(document.body);

if (typeof host !== 'undefined') {
  document.body.style.width = '100%'; document.body.style.height = '100%';
  host.render(); host.save('build/win-clang/msstore.png');
  page.value = 'games'; host.flush(); host.render(); host.save('build/win-clang/msstore-games.png');
  page.value = 'detail'; host.flush(); host.render(); host.save('build/win-clang/msstore-detail.png');
  console.log('msstore rendered: home + games + detail');
}
