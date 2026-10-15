import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
register('./root-loader.mjs', import.meta.url);
const { parseThemeCatalog, parseThemeFile, applyThemeOverrides } = await import('../shared/ui/theme-schema.mjs');
const { dockSurfaceWidth, applicationMenuPlacement, applicationMenuHeight } = await import('../shared/ui/theme-layout.mjs');
const { panelView, dockView, applicationsView } = await import('../shell/views.mjs');
const { desktopCommand } = await import('../shared/ui/presentation.mjs');
const catalog = parseThemeCatalog(readFileSync(new URL('../resources/themes/builtin.json', import.meta.url), 'utf8'));
const recovery = parseThemeCatalog(readFileSync(new URL('../resources/themes/fallback.json', import.meta.url), 'utf8'));
assert.deepEqual(catalog, recovery);
const find = (node, id) => node.props?.id === id ? node : node.children?.map(child => find(child, id)).find(Boolean);
const action = () => {};
const apps = [{ id: 'org.pollyui.settings', name: 'Settings', comment: '', keywords: [] }];
let toggled = 0, launched = 0;
for (const theme of catalog.themes) {
  const bad = JSON.parse(JSON.stringify(theme));
  bad.window.controlWidth = 97;
  assert.throws(() => parseThemeFile(JSON.stringify({ schemaVersion: 1, theme: bad })), RangeError);
  bad.window.controlWidth = 46; bad.window.controlTop = bad.window.titleHeight;
  assert.throws(() => parseThemeFile(JSON.stringify({ schemaVersion: 1, theme: bad })), /fit/);
  const windows = [{ id: 1, title: 'Sample', active: true, minimized: true }];
  const panel = panelView(theme, '10:31', action, '', action, windows, () => toggled++, action);
  assert.ok(find(panel, 'shell-menu'));
  const menu = applicationsView(theme, apps, '', action, () => launched++, action, action);
  assert.equal(find(menu, 'shell-app-search').props.role, 'textbox');
  find(menu, 'shell-app-org.pollyui.settings').props.onKeydown({ key: 'Enter', preventDefault() {}, stopPropagation() {} });
  if (theme.panel.kind === 'dock') {
    const dock = dockView(theme, action, action, action, windows, () => toggled++, action);
    const win = find(dock, 'shell-window-1');
    assert.equal(win.props['aria-label'], 'Sample');
    win.props.onKeydown({ key: 'Enter', preventDefault() {} });
    assert.ok(find(dock, 'shell-dock-separator'));
    const strip = find(dock, 'shell-dock-windows');
    assert.equal(strip.props.style.overflow, 'scroll');
    assert.equal(strip.props.style.minWidth, 0);
    assert.equal(find(dock, 'shell-dock-applications').props.style.flexShrink, 0);
    const viewport = { offsetLeft: 180, offsetWidth: 100, scrollLeft: 0,
      childNodes: [{ offsetLeft: 180, offsetWidth: 54 }, { offsetLeft: 236, offsetWidth: 54 }] };
    strip.props.onWheel({ currentTarget: viewport, deltaX: 0, deltaY: 1000, preventDefault() {} });
    assert.equal(viewport.scrollLeft, 10);
    strip.props.onWheel({ currentTarget: viewport, deltaX: -1000, deltaY: 0, preventDefault() {} });
    assert.equal(viewport.scrollLeft, 0);
    assert.equal(dockSurfaceWidth(theme, 1, 1280), (theme.layout.dockPadding * 2) +
      3 * theme.layout.dockTileWidth + 13 + theme.layout.dockWindowWidth + 3 * theme.layout.dockGap);
    assert.equal(dockSurfaceWidth(theme, 100, 320), 320 - theme.layout.screenInset * 2);
  } else {
    find(panel, 'shell-window-1').props.onKeydown({ key: 'Enter', preventDefault() {}, stopPropagation() {} });
  }
  assert.equal(applicationMenuPlacement(theme).anchors.includes('left'), theme.panel.surfaceStyle !== 'fluent');
  const disabled = desktopCommand('disabled', 'Unavailable', theme, () => { throw new Error('disabled activated'); },
    { enabled: false });
  disabled.props.onClick({ button: 0 });
  assert.equal(disabled.props.tabIndex, -1);
}
assert.equal(toggled, 6);
assert.equal(launched, 6);
assert.equal(catalog.default, 'modern');
const narrow = JSON.parse(JSON.stringify(catalog.themes.find(theme => theme.id === 'modern')));
Object.assign(narrow.window, { controlWidth: 8, controlSize: 16, glyphRadius: 3, glyphThickness: 1, closeThickness: 4 });
assert.throws(() => parseThemeFile(JSON.stringify({ schemaVersion: 1, theme: narrow })), /fit/);
narrow.window.controlWidth = 14;
assert.doesNotThrow(() => parseThemeFile(JSON.stringify({ schemaVersion: 1, theme: narrow })));
assert.ok(find(applicationsView(catalog.themes[0], apps, '', action, action, action, action), 'shell-start-profile'));
assert.ok(find(applicationsView(catalog.themes[0], apps, '', action, action, action, action), 'shell-start-links'));
const server = catalog.themes.find(theme => theme.id === 'server2003');
const serverMenu = applicationsView(server, apps, '', action, action, action, action);
assert.equal(server.panel.menuStyle, 'two-column');
assert.ok(find(serverMenu, 'shell-start-profile'));
assert.equal(find(serverMenu, 'shell-start-links').props.style.width, 184);
assert.equal(find(serverMenu, 'shell-start-links').props.style.backgroundColor, server.colors.body);
assert.equal(find(serverMenu, 'shell-start-profile').props.style.gradientDir, 'horizontal');
assert.equal(serverMenu.props.style.borderRadius, 0);
assert.equal(applicationMenuHeight(server, 480), 442);
assert.equal(applicationMenuHeight(server, 240), 204);
assert.equal(applicationMenuHeight(server, 0), 1);
const legacy = applyThemeOverrides(catalog, JSON.stringify({ schemaVersion: 1,
  themes: { server2003: { panel: { menuStyle: 'legacy' } } } })).themes.find(theme => theme.id === 'server2003');
const legacyMenu = applicationsView(legacy, apps, '', action, action, action, action);
assert.ok(find(legacyMenu, 'shell-start-brand'));
assert.equal(find(legacyMenu, 'shell-start-profile'), undefined);
assert.equal(find(legacyMenu, 'shell-app-org.pollyui.settings').props.style.height, 22);
assert.ok(find(legacyMenu, 'shell-app-org.pollyui.settings').children
  .filter(child => child.props?.['aria-hidden'] === 'true' && child.props?.style?.width)
  .every(child => child.props.style.width <= 22));
for (const theme of catalog.themes.filter(theme => theme.id !== 'server2003'))
  assert.equal(applicationMenuHeight(theme, 480),
    Math.max(1, Math.min(theme.layout.menuHeight, 480 - theme.panel.height - theme.layout.overlayInset * 2)));
assert.throws(() => applyThemeOverrides(catalog, JSON.stringify({ schemaVersion: 1,
  themes: { server2003: { panel: { menuStyle: 'arbitrary-code' } } } })), /unsupported/);
console.log('PASS: six-theme geometry, menu activation, Dock keyboard behavior, disabled commands, recovery parity and placement seams');
