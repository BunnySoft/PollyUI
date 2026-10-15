import { h, render } from './gui/sdk/js/reconciler.mjs';
import { BUILTIN_THEME_CATALOG, getDesktopTheme } from './desktop/shared/ui/themes.mjs';
import { applyThemeOverrides } from './desktop/shared/ui/theme-schema.mjs';
import { dockView } from './desktop/shell/views.mjs';
import { dockSurfaceWidth } from './desktop/shared/ui/theme-layout.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
const rect = node => [node.offsetLeft, node.offsetTop, node.offsetWidth, node.offsetHeight];
const action = () => {};
const get = id => document.getElementById(id);
const pixels = () => {
  const values = [];
  for (let y = 0; y < host.height; y++) for (let x = 0; x < host.width; x++) values.push(host.pixel(x, y));
  return values;
};
const changed = (a, b) => a.reduce((n, value, i) => n + Number(value !== b[i]), 0);

export function checkLionDockSurface(directory, verify = true) {
  check(host.width === 400 && host.height === 120, 'Unscaled 400x120 Lion Dock fixture');
  const base = getDesktopTheme('lion');
  const custom = applyThemeOverrides(BUILTIN_THEME_CATALOG, JSON.stringify({ schemaVersion: 1,
    themes: { lion: { panel: { from: '#804020', to: '#204080' } } } })).themes.find(theme => theme.id === 'lion');
  const geometryTheme = applyThemeOverrides(BUILTIN_THEME_CATALOG, JSON.stringify({ schemaVersion: 1,
    themes: { lion: { panel: { from: '#804020', to: '#204080', height: 74 },
      layout: { dockPadding: 10, dockGap: 1, dockTileWidth: 52, dockWindowWidth: 48, dockIndicatorSize: 12 } } } }))
    .themes.find(theme => theme.id === 'lion');
  const windows = [{ id: 1, title: 'Active', active: true },
    { id: 2, title: 'Minimized', minimized: true }];
  const activations = [], fixedCalls = [];
  const scene = (theme, items = windows, availableWidth = 400, settle = true) => {
    const width = dockSurfaceWidth(theme, items.length, availableWidth);
    render(h('view', { style: { width: '100%', height: '100%', backgroundColor: '#406080' } },
      h('view', { style: { position: 'absolute', left: 16, top: 16, width, height: theme.panel.height } },
        dockView(theme, () => fixedCalls.push('settings'), () => fixedCalls.push('about'),
          () => fixedCalls.push('apps'), items, id => activations.push(id), action))), document.body);
    host.render();
    if (settle) { document.activeElement?.blur(); host.mouse('mousemove', 390, 110); host.render(); }
  };
  let baseline, defaultGeometry;
  for (const [name, theme] of [['default', base], ['custom', custom], ['geometry', geometryTheme]]) {
    scene(theme);
    const dock = get('shell-dock'), shelf = dock.firstChild;
    const [left, top, width, height] = rect(shelf);
    check(shelf.childNodes.length === 25 && height === 28, 'Existing 24-row perspective shelf plus four-pixel front');
    const rows = shelf.childNodes.slice(0, 24).map(rect);
    check(rows.every(([x, y, w, h], row) => {
      const style = shelf.childNodes[row].style;
      return Number(style.left) === 12 - row / 2 && Number(style.right) === 12 - row / 2 &&
        y === top + row && h === 1 && x >= left && x + w <= left + width &&
        (!row || (x <= rows[row - 1][0] && w >= rows[row - 1][2]));
    }), 'Existing half-pixel logical perspective insets and bounded raster rows');
    const sample = (x, y) => host.pixel(x, y).toLowerCase();
    const colors = {
      top: sample(left + 13, top),
      upper: sample(left + 13, top + 1),
      lower: sample(left + 3, top + 20),
      frontEdge: sample(left + 1, top + 24),
      front: sample(left + 1, top + 26),
      outside: sample(left, top),
    };
    check(colors.outside === '#406080', 'Shelf outside stays clear without pretending backdrop blur');
    if (verify || name === 'default') {
      check(colors.upper === theme.panel.from && colors.front === theme.panel.to,
        name + ' shelf consumes configured upper face and front colors');
    }
    check(colors.top === '#eeeeee' && colors.lower === '#999999',
      'Existing neutral highlight and lower band stay unchanged: ' + JSON.stringify(colors));
    const geometry = { dock: rect(dock), shelf: rect(shelf), separator: rect(get('shell-dock-separator')),
      slots: windows.map(item => rect(get('shell-window-' + item.id))) };
    if (name === 'custom') check(JSON.stringify(geometry) === JSON.stringify(defaultGeometry),
      'Palette overrides do not alter Dock geometry');
    if (name === 'default') defaultGeometry = geometry;
    check(dock.offsetHeight === theme.panel.height &&
      windows.every(item => get('shell-window-' + item.id).offsetWidth === theme.layout.dockWindowWidth),
    'Default and configured Dock height/window widths are consumed');
    const indicators = windows.map(item => get('shell-window-' + item.id).childNodes[1]);
    check(indicators.every(node => node.offsetWidth === theme.layout.dockIndicatorSize && node.offsetHeight === 3),
      'Active and minimized windows retain configured-width by three running indicators');
    const indicatorPixels = indicators.map(node => {
      const [x, y, w, h] = rect(node), colors = [];
      for (let row = 0; row < h; row++) for (let col = 0; col < w; col++)
        colors.push(host.pixel(x + col, y + row));
      check(colors.some(color => color.toLowerCase() === '#bde8ff'), 'Actual luminous running ink remains visible');
      return colors.filter(color => color.toLowerCase() === '#bde8ff').length;
    });
    check(host.save(directory + '\\lion-shelf-' + name + '.png'), 'Save actual Lion shelf');
    const normal = pixels();
    if (name === 'default') baseline = normal;
    scene(theme, windows.map(item => ({ ...item, active: !item.active, minimized: !item.minimized })));
    check(changed(normal, pixels()) === 0, 'Active/minimized state retains running pixels');
    console.log('LION_SHELF ' + JSON.stringify({ name, viewport: [400, 120], scale: 1, colors,
      geometry, changedFromDefaultPixels: changed(baseline, normal), indicators: indicators.map(rect),
      indicatorCorePixels: indicatorPixels }));
  }
  scene(custom);
  const first = get('shell-window-1'), bounds = first.getBoundingClientRect();
  const x = bounds.x + bounds.width / 2, y = bounds.y + 20;
  const idle = pixels();
  host.mouse('mousemove', x, y); host.render();
  const hovered = pixels();
  host.mouse('mousedown', x, y); host.render();
  const held = pixels();
  scene(custom, windows, 400, false);
  check(get('shell-window-1') === first, 'Palette scene reconstruction retains the window slot node');
  host.mouse('mouseup', x, y); host.mouse('click', x, y); host.render();
  check(activations.length === 1 && activations[0] === 1, 'One real window click dispatches once');
  first.focus(); host.render();
  const focused = pixels();
  check(changed(idle, hovered) > 0 && document.activeElement === first,
    'Real pointer hover has visible pixels and focus remains on the same slot');
  console.log('LION_STATES ' + JSON.stringify({ hoverChangedPixels: changed(idle, hovered),
    heldChangedPixels: changed(hovered, held), focusedChangedPixels: changed(held, focused) }));
  const many = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, title: 'Window ' + (i + 1), minimized: i === 19 }));
  scene(custom, many, 320);
  const strip = get('shell-dock-windows'), last = get('shell-window-20');
  const fixed = ['shell-dock-applications', 'shell-dock-settings', 'shell-dock-about'].map(get);
  const fixedGeometry = fixed.map(rect);
  host.scroll(strip.offsetLeft + strip.offsetWidth / 2, strip.offsetTop + 20, 100000); host.render();
  const lastBounds = last.getBoundingClientRect(), stripBounds = strip.getBoundingClientRect();
  check(lastBounds.x >= stripBounds.x && lastBounds.x + lastBounds.width <= stripBounds.x + stripBounds.width,
    'Last minimized Lion window remains fully reachable by real scroll');
  for (const kind of ['mousedown', 'mouseup', 'click'])
    host.mouse(kind, lastBounds.x + lastBounds.width / 2, lastBounds.y + 20);
  host.render();
  check(activations.length === 2 && activations[1] === 20, 'Last window click activates exactly once');
  host.scroll(stripBounds.x + stripBounds.width / 2, stripBounds.y + 20, -100000); host.render();
  check(Number(strip.scrollLeft) === 0, 'Reverse scroll reaches first Lion window');
  last.focus(); host.render();
  check(document.activeElement === last && Number(strip.scrollLeft) > 0, 'Focus reveals last window');
  check(fixed.every((node, i) => JSON.stringify(rect(node)) === JSON.stringify(fixedGeometry[i])),
    'Fixed Apps/Settings/About slots do not move');
  for (const node of fixed) {
    const box = node.getBoundingClientRect();
    for (const kind of ['mousedown', 'mouseup', 'click']) host.mouse(kind, box.x + box.width / 2, box.y + 20);
  }
  check(JSON.stringify(fixedCalls) === JSON.stringify(['apps', 'settings', 'about']), 'All fixed actions remain real callbacks');
  console.log('LION_INPUT ' + JSON.stringify({ activations, fixedCalls, fixedGeometry,
    strip: rect(strip), scrollLeft: strip.scrollLeft }));
  console.log(verify ? 'PASS: Lion shelf palette consumption, perspective geometry, running state and actual input' :
    'BASELINE: Lion shelf palette consumption and bounded surface coverage recorded');
}
