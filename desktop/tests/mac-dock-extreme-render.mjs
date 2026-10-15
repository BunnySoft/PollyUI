import { h, render } from './gui/sdk/js/reconciler.mjs';
import { BUILTIN_THEME_CATALOG } from './desktop/shared/ui/themes.mjs';
import { applyThemeOverrides } from './desktop/shared/ui/theme-schema.mjs';
import { dockSurfaceWidth } from './desktop/shared/ui/theme-layout.mjs';
import { dockView } from './desktop/shell/views.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
const get = id => document.getElementById(id);
const box = node => {
  const { x, y, width, height } = node.getBoundingClientRect();
  return { x, y, width, height };
};
const settle = () => { for (let i = 0; i < 4; i++) host.render(); };

export function checkMacDockExtremes(directory, verify = true) {
  check(host.width === 560 && host.height === 180, 'Unscaled 560x180 Dock extreme-width fixture');
  const windows = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, title: 'Window ' + (i + 1),
    active: i === 0, minimized: i === 19 }));
  const custom = (id, layout = {}, panel = {}) => applyThemeOverrides(BUILTIN_THEME_CATALOG,
    JSON.stringify({ schemaVersion: 1, themes: { [id]: { layout: { dockGap: 32, ...layout }, panel } } }))
    .themes.find(theme => theme.id === id);
  const calls = [];
  const scene = (theme, items = windows, width = 304) => {
    render(h('view', { style: { width: '100%', height: '100%', backgroundColor: '#406080' } },
      h('view', { style: { position: 'absolute', left: 8, top: 16, width, height: theme.panel.height } },
        dockView(theme, () => calls.push('settings'), () => calls.push('about'),
          () => calls.push('apps'), items, id => calls.push('window:' + id), () => {}))), document.body);
    settle();
  };
  const reset = () => { render(h('view', {}), document.body); settle(); calls.length = 0; };
  const point = node => {
    const bounds = box(node), viewport = box(get('shell-dock-viewport'));
    const left = Math.max(bounds.x, viewport.x), right = Math.min(bounds.x + bounds.width, viewport.x + viewport.width);
    check(right - left === Math.min(bounds.width, viewport.width), 'Focused control is fully or maximally visible');
    return [left + (right - left) / 2, bounds.y + bounds.height / 2];
  };
  const click = node => {
    node.focus(); settle();
    const [x, y] = point(node);
    for (const kind of ['mousedown', 'mouseup', 'click']) host.mouse(kind, x, y);
    settle();
  };
  const wheel = (node, delta) => {
    const bounds = box(node);
    host.scroll(bounds.x + Math.min(1, bounds.width / 2), bounds.y + bounds.height / 2, delta);
    settle();
  };
  for (const id of ['aqua', 'lion', 'bigsur']) {
    reset();
    const theme = custom(id);
    scene(theme);
    const strip = get('shell-dock-windows'), surface = get('shell-dock'), viewport = get('shell-dock-viewport');
    console.log('MAC_DOCK_EXTREME_REPRO ' + JSON.stringify({ id, surface: box(surface),
      viewport: viewport ? box(viewport) : null, strip: box(strip) }));
    check(host.save(directory + '\\' + id + '-gap32.png'), 'Save extreme-width Dock');
    if (!verify) continue;
    check(viewport.offsetWidth === 304 && surface.offsetWidth === dockSurfaceWidth(theme, 1, Infinity) &&
      strip.offsetWidth === theme.layout.dockWindowWidth, 'Extreme Dock keeps one complete inner window slot');
    for (const target of ['applications', 'settings', 'about', 'window-1', 'window-20'])
      click(get(target.startsWith('window-') ? 'shell-' + target : 'shell-dock-' + target));
    check(JSON.stringify(calls) === '["apps","settings","about","window:1","window:20"]',
      'All fixed actions and first/last real windows activate exactly once');
    wheel(viewport, 100000);
    check(Number(viewport.scrollLeft) === surface.offsetWidth - viewport.offsetWidth, 'Outer forward clamp');
    const surfaceBounds = box(surface);
    const material = host.pixel(surfaceBounds.x + surfaceBounds.width - 4,
      surfaceBounds.y + (id === 'lion' ? surfaceBounds.height - 2 : Math.floor(surfaceBounds.height / 2))).toLowerCase();
    check(material !== '#406080', 'Right-hand controls retain their actual Dock material underneath');
    if (id === 'lion') check(surface.firstChild.offsetWidth === surface.offsetWidth &&
      material === theme.panel.to, 'Entire Lion shelf scrolls with its full-width controls');
    if (id === 'bigsur') {
      const maximum = Number(strip.scrollLeft), outer = Number(viewport.scrollLeft);
      wheel(strip, -1);
      check(Number(strip.scrollLeft) === maximum - 1 && Number(viewport.scrollLeft) === outer,
        'Movable inner wheel does not scroll the outer Dock');
      const manual = Number(strip.scrollLeft);
      scene(theme);
      check(Number(strip.scrollLeft) === manual && Number(viewport.scrollLeft) === outer,
        'Unchanged reconciliation does not undo manual scrolling to reveal active focus');
      wheel(strip, -100000);
      check(Number(strip.scrollLeft) === 0 && Number(viewport.scrollLeft) === outer, 'Inner reverse clamp');
      wheel(strip, -100000);
      check(Number(viewport.scrollLeft) === 0, 'Wheel at inner boundary chains to outer reverse clamp');
      console.log('MAC_DOCK_EXTREME_WHEEL ' + JSON.stringify({ innerMaximum: maximum,
        outerMaximum: outer, manualInner: manual, reverseInner: strip.scrollLeft, reverseOuter: viewport.scrollLeft }));
      const first = get('shell-window-1');
      first.focus(); settle();
      const [x, y] = point(first);
      host.mouse('mousemove', x, y); host.mouse('mousedown', x, y); host.render();
      scene(theme);
      check(get('shell-window-1') === first, 'Extreme reconstruction retains held slot identity');
      host.mouse('mouseup', x, y); host.mouse('click', x, y); settle();
      check(calls.length === 6 && calls.at(-1) === 'window:1', 'Extreme held reconstruction releases exactly once');
      const last = get('shell-window-20');
      last.focus(); settle();
      scene(theme, windows, 544);
      check(get('shell-dock-viewport') === viewport && get('shell-dock-windows') === strip &&
        document.activeElement === last && Number(viewport.scrollLeft) === 0,
      'Widening keeps the same nodes and active focus while clearing stale outer scroll');
      point(last);
      console.log('MAC_DOCK_EXTREME_GROW ' + JSON.stringify({ width: viewport.offsetWidth,
        outer: viewport.scrollLeft, inner: strip.scrollLeft, focused: document.activeElement.id }));
      scene(theme);
      const settings = get('shell-dock-settings');
      settings.focus(); settle(); wheel(viewport, 100000);
      scene(theme, []);
      check(document.activeElement === settings && Number(viewport.scrollLeft) === 0 &&
        !get('shell-dock-windows'), 'Shorter empty content restores outer zero without losing retained focus');
      console.log('MAC_DOCK_EXTREME_SHRINK ' + JSON.stringify({ width: viewport.offsetWidth,
        outer: viewport.scrollLeft, surface: surface.offsetWidth, focused: document.activeElement.id }));
      scene(theme, windows);
    }
    get('shell-window-20').focus(); settle(); wheel(viewport, 100000);
    check(host.save(directory + '\\' + id + '-last-material.png'), 'Save full material under last control');
    console.log('MAC_DOCK_EXTREME_INPUT ' + JSON.stringify({ id, calls, material,
      viewport: box(viewport), surface: box(surface), strip: box(get('shell-dock-windows')) }));
  }
  if (!verify) { console.log('BASELINE: configured gap32 leaves no usable window viewport'); return; }
  for (const [name, theme, items, width] of [
    ['empty80', custom('bigsur'), [], 80],
    ['unequal100', custom('bigsur', { dockTileWidth: 64, dockWindowWidth: 80 }), windows, 100],
    ['physical40', custom('bigsur', { dockIconSize: 96, dockTileWidth: 96, dockWindowWidth: 96 },
      { height: 108 }), windows, 40],
  ]) {
    reset(); scene(theme, items, width);
    for (const id of ['shell-dock-applications', 'shell-dock-settings', 'shell-dock-about',
      ...(items.length ? ['shell-window-1', 'shell-window-20'] : [])]) click(get(id));
    check(JSON.stringify(calls) === JSON.stringify(['apps', 'settings', 'about',
      ...(items.length ? ['window:1', 'window:20'] : [])]), name + ' keeps every entry as its own single real callback');
    check(get('shell-dock-applications').offsetWidth === theme.layout.dockTileWidth &&
      (!items.length || get('shell-window-20').offsetWidth === theme.layout.dockWindowWidth),
    name + ' never silently shrinks unequal or physically oversized slots');
    for (let i = 0; i < 2; i++) wheel(get('shell-dock-viewport'), -100000);
    check(Number(get('shell-dock-viewport').scrollLeft) === 0, name + ' outer reverse clamp');
    check(host.save(directory + '\\' + name + '.png'), 'Save physical extreme-width control');
    console.log('MAC_DOCK_EXTREME_SMALL ' + JSON.stringify({ name, width, calls,
      surface: box(get('shell-dock')), viewport: box(get('shell-dock-viewport')) }));
  }
  console.log('PASS: extreme Dock material/control scrolling, chained wheel/focus, resize clamp and input');
}
