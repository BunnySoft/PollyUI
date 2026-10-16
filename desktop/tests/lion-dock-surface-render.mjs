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

export async function checkDockMagnification() {
  check(host.width === 400 && host.height === 120, 'Existing unscaled 400x120 Dock scene');
  const baseline = getDesktopTheme('lion'), calls = [];
  let theme = baseline;
  const windows = [{ id: 1, title: 'Real group', grouped: true, appId: 'fixture', count: 2, active: true },
    { id: 2, title: 'Second', minimized: true }];
  windows[0].windows = [{ id: 11 }, { id: 12 }];
  const source = document.createElement('canvas');
  source.width = source.height = 16;
  const context = source.getContext('2d');
  context.fillStyle = '#2090e0'; context.fillRect(0, 0, 16, 16);
  const blob = await new Promise(resolve => source.toBlob(resolve));
  const bitmap = createBitmap(await blob.arrayBuffer(), 16 * 16);
  const images = new Map([[1, bitmap.key]]);
  let width = 368, peer = false;
  const originalRequest = globalThis.requestAnimationFrame, originalCancel = globalThis.cancelAnimationFrame;
  const pending = new Set();
  let frames = 0;
  globalThis.requestAnimationFrame = callback => {
    let id;
    id = originalRequest(time => { pending.delete(id); frames++; callback(time); });
    pending.add(id); return id;
  };
  globalThis.cancelAnimationFrame = id => { pending.delete(id); originalCancel(id); };
  const scene = () => {
    render(h('view', { style: { width: '100%', height: '100%', backgroundColor: '#406080' } },
      h('view', { style: { position: 'absolute', left: 16, top: 16, width, height: theme.panel.height } },
        dockView(theme, () => calls.push('settings'), () => calls.push('about'), () => calls.push('apps'),
          windows, id => calls.push(id), action, images)),
      peer ? h('view', { id: 'independent-dock', style: {
        position: 'absolute', left: 230, top: 16, width: 140, height: theme.panel.height } },
      dockView(baseline, action, action, action)) : null), document.body);
    host.render();
  };
  const settle = async () => {
    for (let i = 0; i < 28; i++) { await Promise.resolve(); host.render(); }
    check(pending.size === 0, 'Distance transitions and layout settlement become completely idle');
  };
  const ids = ['shell-dock-applications', 'shell-dock-settings', 'shell-dock-about', 'shell-window-1', 'shell-window-2'];
  const art = id => get(id).querySelector('.shell-dock-art');
  const scales = () => ids.map(id => Number(art(id).style.scale || 1));
  const point = id => {
    const r = art(id).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2];
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  try {
    scene(); await settle();
    check(frames === 2, 'An untouched Dock performs only its original two layout-settlement frames');
    const slots = ids.map(id => get(id)), geometry = slots.map(rect);
    const [x, y] = point(ids[1]);
    // host.render(ms) delivers that same timestamp to the real native rAF queue.
    host.mouse('mousemove', x, y); host.render(1000);
    const motion = [];
    for (let index = 1; index <= 6; index++) {
      host.mouse('mousemove', x + index * 2 - 1, y);
      host.mouse('mousemove', x + index * 2, y); host.render(1000 + index * 16);
      motion.push(scales());
    }
    console.log('DOCK_CONTINUOUS_POINTER ' + JSON.stringify({ millisecondsPerFrame: 16, pointerMovesPerFrame: 2, scales: motion }));
    check(motion[0][1] > 1 && motion.at(-1)[1] > motion[0][1],
      'Artwork follows continuous per-frame pointer movement before the pointer stops');
    for (let index = 7; index <= 17; index++) host.render(1000 + index * 16);
    check(pending.size === 0, 'The last moving target settles without a lingering frame chain');
    host.mouse('mousemove', 399, 119); await settle();
    host.mouse('mousemove', x, y); host.render();
    const entering = scales();
    check(entering.every(scale => scale === 1), 'Idle entry does not inherit an old native animation timestamp');
    scene();
    theme = { ...theme, colors: { ...theme.colors } }; scene();
    await settle();
    const centered = scales();
    check(centered[1] > centered[0] && centered[0] > 1 && centered[2] > 1,
      'Pointer center magnifies both visible neighbors, not only the hit slot');
    check(entering[1] < centered[1] && slots.every((slot, index) => get(ids[index]) === slot),
      'Entry remains a bounded transition across retained clock and immutable-theme updates');
    const [right] = point(ids[2]);
    host.mouse('mousemove', x + (right - x) / 4, y); await settle();
    const between = scales();
    check(between[1] > between[2] && between[2] > between[0] && between[0] > 1,
      'A between-centers pointer produces continuous unequal neighbor weights');
    const beforeClock = scales(), count = frames;
    scene(); await settle();
    check(same(scales(), beforeClock) && frames - count === 2, 'Clock repaint preserves pointer/scale without restarting an animation');
    theme = { ...theme, colors: { ...theme.colors, accent: '#8040a0' } };
    scene(); await settle();
    check(slots.every((slot, index) => get(ids[index]) === slot) && same(scales(), beforeClock),
      'Immutable retheme preserves the same physical pointer and instance scale');
    host.mouse('mousemove', ...point(ids[2])); await settle();
    const crossStrip = scales();
    check(crossStrip[1] > 1 && crossStrip[3] > 1 && crossStrip[2] > crossStrip[3],
      'Fixed entries and window strip share one visible neighboring sequence across the separator');
    const imageBounds = art(ids[3]).getBoundingClientRect();
    check(art(ids[3]).style.backgroundImage === bitmap.key &&
      host.pixel(Math.floor(imageBounds.x + imageBounds.width / 2),
        Math.floor(imageBounds.y + imageBounds.height / 2)).toLowerCase() === '#2090e0',
      'Registered bitmap participates in the same distance field without recoloring');
    check(same(slots.map(rect), geometry), 'Magnification changes no tile, slot or hitbox geometry');
    const [wx, wy] = point(ids[3]);
    host.mouse('mousedown', wx, wy); host.mouse('mouseup', wx, wy); host.mouse('click', wx, wy);
    await settle();
    check(same(calls, [1]), 'Original grouped-task callback still activates exactly once');
    host.mouse('mousedown', wx, wy); host.mouse('mousecancel', 0, 0); await settle();
    check(scales().every(scale => scale === 1), 'Cancellation settles all neighbors exactly to scale one');
    host.mouse('mousemove', ...point(ids[1])); await settle();
    host.mouse('mousemove', 399, 119); await settle();
    check(scales().every(scale => scale === 1), 'Leaving settles the complete sequence to one and idle');
    theme = { ...theme, icons: { ...theme.icons, dockHoverPercent: 100 } };
    scene(); await settle(); host.mouse('mousemove', ...point(ids[1])); await settle();
    check(scales().every(scale => scale === 1), 'One hundred percent disables distance magnification');
    theme = { ...theme, icons: { ...baseline.icons, dockMagnificationRadius: 0 } };
    scene(); await settle(); host.mouse('mousemove', 399, 119); host.mouse('mousemove', ...point(ids[1])); await settle();
    const legacy = scales();
    check(legacy[1] > 1 && legacy.filter(scale => scale > 1).length === 1, 'Radius zero retains single-slot hover behavior');
    const missing = { ...theme.icons }; delete missing.dockMagnificationRadius;
    theme = { ...theme, icons: missing }; scene(); await settle();
    check(same(scales(), legacy), 'Omitting radius preserves the exact existing single-hover scales');
    theme = baseline; scene(); await settle();
    check(scales()[0] > 1 && scales()[2] > 1, 'Enabling distance policy on retheme retains the stationary physical pointer');
    theme = baseline; width = 140; scene(); await settle();
    const dock = get('shell-dock-viewport'), r = dock.getBoundingClientRect();
    host.mouse('mousemove', r.x + r.width - 2, y); await settle();
    const clipped = scales();
    for (const id of ids) {
      const a = art(id).getBoundingClientRect();
      if (a.x < r.x || a.x + a.width > r.x + r.width)
        check(Number(art(id).style.scale) === 1, 'Clipped artwork cannot magnify');
    }
    host.scroll(r.x + r.width / 2, y, 10000); await settle();
    check(Number(dock.scrollLeft) > 0, 'Outer Dock wheel remains available with distance magnification');
    get(ids[0]).focus(); await settle();
    check(document.activeElement === slots[0], 'Existing focus reveal keeps its actual command');
    peer = true; scene(); await settle();
    host.mouse('mousemove', ...point(ids[0])); await settle();
    const independent = get('independent-dock').querySelector('#shell-dock-viewport');
    const peerArt = independent.querySelectorAll('.shell-dock-art');
    check(peerArt.every(node => Number(node.style.scale || 1) === 1), 'An independent Dock has no pointer-state bleed');
    const target = peerArt[1].getBoundingClientRect();
    host.mouse('mousemove', target.x + target.width / 2, target.y + target.height / 2); await settle();
    check(Number(peerArt[1].style.scale) > 1 && scales().every(scale => scale === 1),
      'Moving to a second instance magnifies only its own visible sequence');
    host.mouse('mousemove', ...point(ids[0])); host.render();
    render(null, document.body); await settle();
    check(pending.size === 0, 'Ancestor retirement stops all pending distance and layout frames');
    console.log('DOCK_DISTANCE_MAGNIFICATION ' + JSON.stringify({ entering, centered, between, crossStrip, clipped,
      geometry, calls, idleFrames: pending.size, peakPercent: 120, radius: 2,
      scope: 'Existing actual software GUI Dock artwork only; fixed hitboxes, no macOS displacement or compositor qualification' }));
  } finally {
    render(null, document.body);
    for (const id of pending) originalCancel(id);
    globalThis.requestAnimationFrame = originalRequest; globalThis.cancelAnimationFrame = originalCancel;
    bitmap.close();
  }
}
