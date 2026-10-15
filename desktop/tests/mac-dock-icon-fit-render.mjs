import { h, render } from './gui/sdk/js/reconciler.mjs';
import { BUILTIN_THEME_CATALOG } from './desktop/shared/ui/themes.mjs';
import { applyThemeOverrides } from './desktop/shared/ui/theme-schema.mjs';
import { dockSurfaceWidth } from './desktop/shared/ui/theme-layout.mjs';
import { dockView } from './desktop/shell/views.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
const action = () => {};
const box = node => {
  const { x, y, width, height } = node.getBoundingClientRect();
  return { x, y, width, height };
};

export function checkMacDockIconFit(directory) {
  check(host.width === 560 && host.height === 160, 'Unscaled 560x160 Dock icon-fit fixture');
  const cases = [
    ['tiger-default', 'aqua', {}],
    ['lion-default', 'lion', {}],
    ['bigsur-default', 'bigsur', {}],
    ['lion-custom48', 'lion', { panel: { height: 74 }, layout: {
      dockPadding: 10, dockGap: 1, dockTileWidth: 52, dockWindowWidth: 48, dockIndicatorSize: 12 } }],
    ['bigsur-custom64', 'bigsur', { panel: { height: 88 }, layout: {
      dockIconSize: 64, dockTileWidth: 72, dockWindowWidth: 72, dockIndicatorSize: 12 } }],
    ['bigsur-icon96', 'bigsur', { panel: { height: 108 }, layout: {
      dockIconSize: 96, dockTileWidth: 96, dockWindowWidth: 96 } }],
    ['bigsur-height60', 'bigsur', { panel: { height: 60 } }],
    ['bigsur-marker12-touch', 'bigsur', { layout: { dockIndicatorSize: 12 } }],
    ['bigsur-marker12-half-gap', 'bigsur', { panel: { height: 71 }, layout: { dockIndicatorSize: 12 } }],
    ['bigsur-icon16-minimum', 'bigsur', { panel: { height: 28 }, layout: {
      dockIconSize: 16, dockTileWidth: 40, dockWindowWidth: 24 } }],
    ['bigsur-icon16-marker12-touch', 'bigsur', { panel: { height: 38 }, layout: {
      dockIconSize: 16, dockTileWidth: 40, dockWindowWidth: 24, dockIndicatorSize: 12 } }],
  ];
  const activations = [];
  for (const [index, [name, id, override]] of cases.entries()) {
    const theme = applyThemeOverrides(BUILTIN_THEME_CATALOG,
      JSON.stringify({ schemaVersion: 1, themes: { [id]: override } })).themes.find(theme => theme.id === id);
    const windows = [{ id: 1, title: name, minimized: true }];
    const width = dockSurfaceWidth(theme, 1, host.width);
    render(h('view', {}), document.body);
    const scene = () => render(h('view', { style: { width: '100%', height: '100%', backgroundColor: '#406080' } },
      h('view', { style: { position: 'absolute', left: 16, top: 16, width, height: theme.panel.height } },
        dockView(theme, action, action, action, windows, window => activations.push(window), action))), document.body);
    scene(); host.render();
    host.mouse('mousemove', 550, 150); document.activeElement?.blur(); host.render();
    const slot = document.getElementById('shell-window-1'), fixed = document.getElementById('shell-dock-applications');
    const metrics = [];
    const markerHeight = theme.panel.surfaceStyle === 'tiger' ? 4 :
      theme.panel.surfaceStyle === 'lion' ? 3 : theme.layout.dockIndicatorSize ?? 4;
    const logicalGap = (theme.panel.height + 2 - 2 * markerHeight - (theme.layout.dockIconSize ?? 48)) / 2;
    for (const focused of [false, true]) {
      if (focused) { slot.focus(); host.render(); }
      const bounds = box(slot), icon = box(slot.firstChild), marker = box(slot.childNodes[1]), fixedIcon = box(fixed.firstChild);
      const expectedIcon = theme.layout.dockIconSize ?? 48;
      check(icon.width === expectedIcon && icon.height === expectedIcon &&
        fixedIcon.width === expectedIcon && fixedIcon.height === expectedIcon, name + ' preserves explicit icon dimensions');
      const fixedBounds = box(fixed);
      check(fixedIcon.x >= fixedBounds.x && fixedIcon.x + fixedIcon.width <= fixedBounds.x + fixedBounds.width &&
        fixedIcon.y >= fixedBounds.y && fixedIcon.y + fixedIcon.height <= fixedBounds.y + fixedBounds.height,
      name + ' fixed icon fits its slot');
      check(icon.x >= bounds.x && icon.x + icon.width <= bounds.x + bounds.width &&
        icon.y >= bounds.y && icon.y + icon.height <= bounds.y + bounds.height, name + ' icon fits its slot');
      check(icon.y + icon.height <= marker.y, name + ' icon does not overlap running marker');
      check(marker.width === (theme.layout.dockIndicatorSize ?? 4) && marker.height === markerHeight &&
        marker.x >= bounds.x && marker.x + marker.width <= bounds.x + bounds.width &&
        marker.y >= bounds.y && marker.y + marker.height <= bounds.y + bounds.height,
      name + ' explicit running marker fits its slot');
      const ink = host.pixel(Math.floor(marker.x + marker.width / 2), Math.floor(marker.y + marker.height / 2)).toLowerCase();
      check(ink === (theme.panel.surfaceStyle === 'tiger' ? '#111111' :
        theme.panel.surfaceStyle === 'lion' ? '#bde8ff' : '#303030'), name + ' minimized running marker has actual ink');
      check(Math.abs(marker.y - icon.y - icon.height - logicalGap) <= 0.5, name + ' fractional gap only rounds at raster boundary');
      check(document.activeElement === slot || !focused, name + ' actual focus is retained');
      metrics.push({ focused, slot: bounds, icon, marker, ink, gap: marker.y - icon.y - icon.height });
      check(host.save(directory + '\\' + name + (focused ? '-focus' : '-normal') + '.png'), 'Save actual icon-fit boundary');
    }
    const bounds = slot.getBoundingClientRect(), x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
    host.mouse('mousemove', x, y); host.mouse('mousedown', x, y); host.render();
    scene(); host.render();
    check(document.getElementById('shell-window-1') === slot, name + ' reconstruction retains slot');
    host.mouse('mouseup', x, y); host.mouse('click', x, y); host.render();
    check(activations.length === index + 1 &&
      activations.at(-1) === 1, name + ' held/release activates minimized window once');
    console.log('MAC_DOCK_ICON_FIT ' + JSON.stringify({ name, dockWidth: width, logicalGap, metrics }));
  }
  console.log('MAC_DOCK_ICON_FIT_INPUT ' + JSON.stringify({ activations, heldReconciliations: cases.length }));
  console.log('PASS: explicit Dock icon sizes, fit/touch boundaries, focus and held input');
}
