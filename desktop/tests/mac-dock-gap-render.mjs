import { h, render } from './gui/sdk/js/reconciler.mjs';
import { DESKTOP_THEMES, BUILTIN_THEME_CATALOG } from './desktop/shared/ui/themes.mjs';
import { applyThemeOverrides } from './desktop/shared/ui/theme-schema.mjs';
import { dockSurfaceWidth } from './desktop/shared/ui/theme-layout.mjs';
import { dockView } from './desktop/shell/views.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
const get = id => document.getElementById(id);
const rect = node => [node.offsetLeft, node.offsetTop, node.offsetWidth, node.offsetHeight];
const action = () => {};
const pixels = () => {
  const result = [];
  for (let y = 0; y < host.height; y++) for (let x = 0; x < host.width; x++) result.push(host.pixel(x, y));
  return result;
};
const changed = (a, b) => a.reduce((total, value, i) => total + Number(value !== b[i]), 0);

export function checkMacDockGaps(directory, verify = true) {
  check(host.width === 400 && host.height === 140, 'Unscaled 400x140 Dock fixture');
  const windows = [{ id: 1, title: 'Active', active: true }, { id: 2, title: 'Minimized', minimized: true }];
  const overrides = gap => applyThemeOverrides(BUILTIN_THEME_CATALOG, JSON.stringify({
    schemaVersion: 1, themes: { bigsur: { layout: { dockGap: gap } } },
  })).themes.find(theme => theme.id === 'bigsur');
  const themes = DESKTOP_THEMES.filter(theme => ['tiger', 'lion', 'bigsur'].includes(theme.panel.surfaceStyle));
  const activations = [], fixedCalls = [];
  const scene = (theme, items, available = host.width, settle = true) => {
    const width = dockSurfaceWidth(theme, items.length, available);
    render(h('view', { style: { width: '100%', height: '100%', backgroundColor: '#406080' } },
      h('view', { style: { position: 'absolute', left: (host.width - width) / 2, top: 16,
        width, height: theme.panel.height } },
      dockView(theme, () => fixedCalls.push('settings'), () => fixedCalls.push('about'),
        () => fixedCalls.push('apps'), items, id => activations.push(id), action))), document.body);
    host.render();
    if (settle) { document.activeElement?.blur(); host.mouse('mousemove', 390, 130); host.render(); }
  };
  const measurements = () => {
    const strip = get('shell-dock-windows'), dock = get('shell-dock');
    const viewport = get('shell-dock-viewport');
    const fixed = ['shell-dock-applications', 'shell-dock-settings', 'shell-dock-about'].map(get);
    const children = strip?.childNodes || [], last = children.at(-1);
    const contentWidth = last ? last.offsetLeft + last.offsetWidth - strip.offsetLeft : 0;
    return { dock: rect(dock), viewport: rect(viewport || dock), fixed: fixed.map(rect), strip: strip ? rect(strip) : null,
      contentWidth, shortfall: last ? contentWidth - strip.offsetWidth : 0 };
  };
  for (const theme of [...themes, overrides(0), overrides(12)]) {
    const name = theme.id + '-gap' + theme.layout.dockGap;
    render(h('view', {}), document.body);
    scene(theme, windows);
    const geometry = measurements(), strip = get('shell-dock-windows'), last = get('shell-window-2');
    check(geometry.shortfall === (verify ? 0 : theme.layout.dockGap),
      name + ' natural window viewport must include all inner gaps');
    const lastIcon = last.firstChild, clip = Math.max(0,
      lastIcon.offsetLeft + lastIcon.offsetWidth - strip.offsetLeft - strip.offsetWidth);
    if (verify) check(clip === 0, name + ' last icon must not clip at natural width');
    const x = strip.offsetLeft + strip.offsetWidth / 2, y = strip.offsetTop + 20;
    host.scroll(x, y, 100000); host.render();
    const scrollLeft = Number(strip.scrollLeft);
    check(scrollLeft === Math.max(0, geometry.shortfall), name + ' natural wheel extent');
    host.scroll(x, y, -100000); host.render();
    check(Number(strip.scrollLeft) === 0, name + ' reverse wheel clamps at zero');
    check(host.save(directory + '\\' + name + '.png'), 'Save natural Dock');
    const running = pixels();
    scene(theme, windows.map(window => ({ ...window, active: !window.active, minimized: !window.minimized })));
    check(changed(running, pixels()) === 0, name + ' active/minimized retain running indicators');
    console.log('MAC_DOCK_GAP ' + JSON.stringify({ name, ...geometry, lastIconClipped: clip, scrollLeft }));
  }
  const theme = themes.find(theme => theme.id === 'bigsur'), wideGap = overrides(12);
  for (const count of [0, 1, 2]) {
    const items = windows.slice(0, count);
    const l = wideGap.layout;
    const natural = 2 * l.dockPadding + 3 * l.dockTileWidth +
      (count ? 13 + count * l.dockWindowWidth + (count + 3) * l.dockGap : 2 * l.dockGap);
    for (const available of [natural + 2 * wideGap.layout.screenInset,
      natural + 2 * wideGap.layout.screenInset - 1]) {
      scene(wideGap, items, available);
      const result = measurements();
      const expectedWidth = Math.min(available - 2 * l.screenInset, natural - (!verify && count ? l.dockGap : 0));
      check(result.viewport[2] === expectedWidth, 'Exact client clamp boundary');
      check(result.dock[2] === (verify ? Math.max(expectedWidth, dockSurfaceWidth(wideGap, count ? 1 : 0, Infinity)) :
        expectedWidth), 'Complete material surface retains fixed entries and at least one window slot');
      if (verify && count) check(result.shortfall === natural - result.dock[2],
        'Only a physically insufficient viewport needs window scrolling');
      console.log('MAC_DOCK_CLAMP ' + JSON.stringify({ count, available, ...result }));
    }
  }
  for (const current of themes) {
    scene(current, []);
    const empty = measurements(), l = current.layout;
    check(empty.dock[2] === 2 * l.dockPadding + 3 * l.dockTileWidth + 2 * l.dockGap &&
      !empty.strip, current.id + ' empty Dock keeps its two fixed gaps');
    check(host.save(directory + '\\' + current.id + '-empty.png'), 'Save unchanged empty Dock');
  }
  scene(theme, windows);
  const first = get('shell-window-1'), bounds = first.getBoundingClientRect();
  const x = bounds.x + bounds.width / 2, y = bounds.y + 20;
  host.mouse('mousemove', x, y); host.mouse('mousedown', x, y); host.render();
  scene(theme, windows, host.width, false);
  check(get('shell-window-1') === first, 'Held reconstruction retains the same slot');
  host.mouse('mouseup', x, y); host.mouse('click', x, y); host.render();
  check(JSON.stringify(activations) === '[1]', 'Held reconstruction releases to exactly one activation');
  const released = pixels();
  host.mouse('mousemove', 390, 130); host.mouse('mousemove', x, y); host.render();
  check(changed(released, pixels()) === 0, 'Released reconstruction retains focused-hover pixels');
  const many = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, title: 'Window ' + (i + 1),
    active: i === 0, minimized: i === 19 }));
  scene(theme, many, 320);
  const strip = get('shell-dock-windows'), last = get('shell-window-20');
  const fixed = ['shell-dock-applications', 'shell-dock-settings', 'shell-dock-about'].map(get);
  const positions = fixed.map(rect), sx = strip.offsetLeft + strip.offsetWidth / 2, sy = strip.offsetTop + 20;
  check(strip.offsetWidth > 0, 'Default narrow strip remains nonzero');
  host.scroll(sx, sy, 100000); host.render();
  const end = last.getBoundingClientRect(), viewport = strip.getBoundingClientRect();
  check(end.x >= viewport.x && end.x + end.width <= viewport.x + viewport.width,
    'Default narrow final window is fully reachable');
  for (const kind of ['mousedown', 'mouseup', 'click']) host.mouse(kind, end.x + end.width / 2, end.y + 20);
  host.render();
  check(JSON.stringify(activations) === '[1,20]', 'Reached final minimized window activates once');
  host.scroll(sx, sy, -100000); host.render();
  check(Number(strip.scrollLeft) === 0, 'Default narrow reverse wheel');
  last.focus(); host.render();
  check(document.activeElement === last && Number(strip.scrollLeft) > 0, 'Focus reveals final window');
  check(fixed.every((node, i) => JSON.stringify(rect(node)) === JSON.stringify(positions[i])),
    'Window scrolling and focus preserve all fixed action rectangles');
  check(host.save(directory + '\\bigsur-narrow.png'), 'Save default narrow Dock');
  for (const node of fixed) {
    const box = node.getBoundingClientRect();
    for (const kind of ['mousedown', 'mouseup', 'click']) host.mouse(kind, box.x + box.width / 2, box.y + 20);
    host.render();
  }
  check(JSON.stringify(fixedCalls) === '["apps","settings","about"]', 'All fixed actions retain single callbacks');
  console.log('MAC_DOCK_INPUT ' + JSON.stringify({ strip: rect(strip), scrollLeft: strip.scrollLeft,
    fixed: fixed.map(rect), activations, fixedCalls, heldReconcileChangedPixels: 0 }));
  console.log('PASS: actual styled Dock gap geometry, running truth, clamp boundaries and input');
}
