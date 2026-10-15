import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
register('./root-loader.mjs', import.meta.url);
const { parseThemeCatalog, parseThemeFile } = await import('../shared/ui/theme-schema.mjs');
const { dockSurfaceWidth, applicationMenuPlacement } = await import('../shared/ui/theme-layout.mjs');
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
assert.ok(find(applicationsView(catalog.themes[0], apps, '', action, action, action, action), 'shell-start-profile'));
assert.ok(find(applicationsView(catalog.themes[0], apps, '', action, action, action, action), 'shell-start-links'));
console.log('PASS: six-theme geometry, menu activation, Dock keyboard behavior, disabled commands, recovery parity and placement seams');
