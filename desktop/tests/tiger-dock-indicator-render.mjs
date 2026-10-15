import { h, render } from './gui/sdk/js/reconciler.mjs';
import { getDesktopTheme } from './desktop/shared/ui/themes.mjs';
import { dockView } from './desktop/shell/views.mjs';
import { dockSurfaceWidth } from './desktop/shared/ui/theme-layout.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
const rect = node => [node.offsetLeft, node.offsetTop, node.offsetWidth, node.offsetHeight];
const action = () => {};
const get = id => document.getElementById(id);
const windows = [{ id: 1, title: 'Active', active: true },
  { id: 2, title: 'Minimized', active: false, minimized: true }];

export function checkTigerDockIndicators(directory, verify = true) {
  check(host.width === 400 && host.height === 100, 'Unscaled 400x100 Tiger fixture');
  const base = getDesktopTheme('aqua');
  const activations = [];
  const scene = (theme, items = windows, width = dockSurfaceWidth(theme, items.length, host.width)) => {
    render(h('view', { style: { width: '100%', height: '100%', backgroundColor: '#406080' } },
      h('view', { style: { position: 'absolute', left: 16, top: 16, width, height: theme.panel.height } },
        dockView(theme, action, action, action, items, id => { activations.push(id); }, action))), document.body);
    host.render(); document.activeElement?.blur(); host.mouse('mousemove', 0, 0); host.render();
  };
  for (const size of [7, 2, 12]) {
    const theme = { ...base, layout: { ...base.layout, dockIndicatorSize: size } };
    scene(theme);
    const triangles = windows.map(item => get('shell-window-' + item.id).childNodes[1]);
    const rows = triangles.map(triangle => {
      const [left, top, width, height] = rect(triangle);
      check(width === size && height === 4, 'Existing configured width and fixed four-row height');
      return Array.from({ length: 4 }, (_, y) => {
        const ink = [];
        for (let x = -8; x < size + 8; x++)
          if (host.pixel(left + x, top + y).toLowerCase() === '#111111') ink.push(x);
        check(y === 3 && !verify ? ink.length === 0 : ink.length > 0,
          verify ? 'Every running triangle row is actually visible' :
            'Baseline retains the observed bottom-rim clipping');
        if (verify && ink.length) {
          check(ink[0] >= 0 && ink[ink.length - 1] < size, 'Running triangle ink stays inside its container');
          check(ink[0] + ink[ink.length - 1] === size - 1, 'Each integer-pixel row is centered');
          check(ink.length === ink[ink.length - 1] - ink[0] + 1, 'Triangle rows remain contiguous');
        }
        return [ink[0] ?? null, ink[ink.length - 1] ?? null, ink.length];
      });
    });
    if (verify) for (const triangle of triangles) {
      const [left, , width] = rect(triangle);
      const lines = triangle.childNodes.map(rect);
      check(lines.every(([x, , w], y) => x >= left && x + w <= left + width &&
        2 * (x - left) + w === size && (!y || w >= lines[y - 1][2])),
      'All four geometric rows are bounded, centered and nondecreasing');
      check(lines[3][2] === size, 'Geometric base fills configured width');
    }
    if (size === 7) check(JSON.stringify(rows[0]) === JSON.stringify([
      [3, 3, 1], [2, 4, 3], [1, 5, 5], verify ? [0, 6, 7] : [null, null, 0]]),
      'Default triangle has the expected actual visible rows, without masking the bottom');
    if (verify) for (const triangle of triangles) {
      const [left, top, width, height] = rect(triangle);
      check(host.pixel(left, top + height).toLowerCase() === '#eeeeee' &&
        host.pixel(left + width - 1, top + height).toLowerCase() === '#eeeeee',
      'The unchanged bottom rim remains visible immediately below the complete triangle');
    }
    const positions = triangles.map(rect);
    check(host.save(directory + '\\tiger-indicator-' + size + '.png'), 'Save actual Tiger Dock pixels');
    const pixels = [];
    for (let y = 0; y < host.height; y++) for (let x = 0; x < host.width; x++) pixels.push(host.pixel(x, y));
    let hash = 2166136261;
    for (const pixel of pixels) for (let i = 0; i < pixel.length; i++)
      hash = Math.imul(hash ^ pixel.charCodeAt(i), 16777619) >>> 0;
    scene(theme, windows.map(item => ({ ...item, active: !item.active, minimized: !item.minimized })));
    let changed = 0;
    for (let y = 0; y < host.height; y++) for (let x = 0; x < host.width; x++)
      changed += Number(host.pixel(x, y) !== pixels[y * host.width + x]);
    check(changed === 0, 'Active/minimized state changes do not change running indicator truth or pixels');
    console.log('TIGER_INDICATOR ' + JSON.stringify({ size, viewport: [host.width, host.height],
      scale: 1, dock: rect(get('shell-dock')), slots: windows.map(item => rect(get('shell-window-' + item.id))),
      containers: positions, rows, hash, stateChangedPixels: changed }));
  }
  const many = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, title: 'Window ' + (i + 1), minimized: i === 19 }));
  scene(base, many, dockSurfaceWidth(base, many.length, 320));
  const strip = get('shell-dock-windows'), last = get('shell-window-20');
  const fixed = ['shell-dock-applications', 'shell-dock-settings', 'shell-dock-about'].map(get);
  const positions = fixed.map(rect);
  const x = strip.offsetLeft + strip.offsetWidth / 2, y = strip.offsetTop + 20;
  host.scroll(x, y, 100000); host.render();
  check(Number(strip.scrollLeft) > 0, 'Narrow Tiger window strip actually scrolls');
  const bounds = last.getBoundingClientRect();
  const viewport = strip.getBoundingClientRect();
  check(bounds.x >= viewport.x && bounds.x + bounds.width <= viewport.x + viewport.width,
    'Last minimized window is fully reachable');
  for (const kind of ['mousedown', 'mouseup', 'click']) host.mouse(kind, bounds.x + bounds.width / 2, bounds.y + 20);
  host.render();
  check(activations.length === 1 && activations[0] === 20,
    'Last minimized window activates exactly once through actual pointer input');
  host.scroll(x, y, -100000); host.render();
  check(Number(strip.scrollLeft) === 0, 'Reverse scroll returns to first window');
  last.focus(); host.render();
  check(document.activeElement === last && Number(strip.scrollLeft) > 0, 'Focus reveals the last window');
  check(fixed.every((node, i) => JSON.stringify(rect(node)) === JSON.stringify(positions[i])),
    'Fixed actions retain their geometry through scrolling and focus');
  console.log('TIGER_NARROW ' + JSON.stringify({ dock: rect(get('shell-dock')), fixed: positions,
    strip: rect(strip), last: rect(last), scrollLeft: strip.scrollLeft, activations, focused: document.activeElement === last }));
  console.log('PASS: actual Tiger Dock running state, narrow scroll/click/focus; ' +
    (verify ? 'all four configured integer-pixel rows visible, bounded and centered' : 'before geometry recorded'));
}
