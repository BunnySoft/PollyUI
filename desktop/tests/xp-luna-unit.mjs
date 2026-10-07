import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
register('./root-loader.mjs', import.meta.url);

const { parseThemeCatalog, parseThemeFile, applyThemeOverrides } = await import('../shell/theme-schema.mjs');
const { isLuna, lunaBandColor, lunaBands, lunaButtonPaint, lunaCaptionGlyph, lunaVisualEvents } =
  await import('../shell/luna-primitives.mjs');
const { panelView, settingsView, applicationsView } = await import('../shell/views.mjs');
const catalog = parseThemeCatalog(readFileSync(new URL('../themes/builtin.json', import.meta.url), 'utf8'));
const recovery = parseThemeCatalog(readFileSync(new URL('../themes/fallback.json', import.meta.url), 'utf8'));
const xp = catalog.themes[0];
const clone = value => JSON.parse(JSON.stringify(value));
const parse = theme => parseThemeFile(JSON.stringify({ schemaVersion: 1, theme }));
const find = (node, id) => node.props?.id === id ? node :
  node.children?.map(child => find(child, id)).find(Boolean);
assert.deepEqual(recovery.themes[0], xp);
assert.equal(xp.panel.height, 30);
assert.equal(xp.window.titleHeight, 30);
assert.equal(xp.window.controlSize, 21);
assert.equal(xp.window.controlGap, 2);
assert.equal(xp.window.controlInset, 6);
assert.equal(xp.layout.fontSize, 11);
assert.equal(xp.layout.buttonHeight, 21);
assert.equal(xp.window.fontWeight, 700);
assert.equal(xp.window.shadow, 0);
assert.ok(Object.isFrozen(xp.window));
const legacy = clone(xp);
for (const group of ['window', 'button', 'panel']) delete legacy[group].surfaceStyle;
assert.doesNotThrow(() => parse(legacy));
assert.equal(isLuna(legacy), false);
for (const group of ['window', 'button', 'panel']) {
  const bad = clone(xp);
  bad[group].surfaceStyle = 'run-arbitrary-code';
  assert.throws(() => parse(bad), /unsupported/);
}
const bad = clone(xp);
bad.window.borderWidth = 0;
bad.window.titleHeight = 22;
assert.throws(() => parse(bad), /fit/);
const overridden = applyThemeOverrides(catalog, JSON.stringify({
  schemaVersion: 1, themes: { xp: { window: { surfaceStyle: 'generic' } } },
}));
assert.equal(overridden.themes[0].window.surfaceStyle, 'generic');
assert.equal(xp.window.surfaceStyle, 'luna');
for (const theme of catalog.themes.slice(1)) {
  assert.equal(isLuna(theme), false);
  assert.equal(isLuna(theme, 'window'), false);
  assert.equal(isLuna(theme, 'panel'), false);
  const baseline = JSON.parse(readFileSync(new URL('../themes/xp-reference.json', import.meta.url), 'utf8'));
  assert.equal(theme.panel.height, baseline.unchangedPanelHeights[theme.id]);
}
const bands = lunaBands(xp, 'title', xp.window.titleHeight);
assert.equal(bands.children.length, 30);
assert.equal(bands.props.style.pointerEvents, 'none');
assert.notEqual(lunaBandColor(xp, 'title', 1.5, 30), lunaBandColor(xp, 'title', 13.5, 30));
assert.throws(() => lunaBandColor(xp, 'unknown', 0, 30), /Unknown/);
const normal = lunaButtonPaint(xp), pressed = lunaButtonPaint(xp, { pressed: true });
assert.notEqual(normal.gradientTo, lunaButtonPaint(xp, { selected: true }).gradientTo);
assert.equal(normal.gradientFrom, pressed.gradientTo);
assert.equal(normal.gradientTo, pressed.gradientFrom);
const disabled = lunaButtonPaint(xp, { disabled: true });
assert.equal(disabled.gradientFrom, xp.colors.body);
assert.equal(disabled.borderColor, xp.colors.dark);
assert.equal(lunaCaptionGlyph(xp, 'close').children.length, 2);
assert.equal(lunaCaptionGlyph(xp, 'maximize', true).children.length, 3);
let calls = 0;
const action = () => { calls++; };
const panel = panelView(xp, '10:31 AM', action, '', action, [{
  id: 1, title: 'Sample', appId: 'org.pollyui.fixture', active: true,
}], action, action, { name: 'Workspaces', open: action }, { count: 0, open: action });
const validTree = node => {
  assert.equal(typeof node.type, 'string');
  for (const child of node.children) validTree(child);
};
validTree(panel);
assert.equal(find(panel, 'shell-menu').props.style.width, 97);
assert.equal(find(panel, 'shell-menu').props.style.height, 30);
assert.equal(find(panel, 'shell-window-1').props.style.height, 26);
for (const id of ['shell-menu', 'shell-panel-settings', 'shell-workspaces', 'shell-notifications'])
  assert.equal(find(panel, id).props.role, 'button');
assert.ok(find(panel, 'shell-clock'));
assert.equal(find(panel, 'shell-clock').props.style.fontSize, 11);
const task = find(panel, 'shell-window-1');
assert.equal(task.children.at(-1).props.style.pointerEvents, 'none',
  'caption text cannot steal non-bubbling hover events from the button');
const rings = { '.luna-hot-ring': { style: {} }, '.luna-focus-ring': { style: {} },
  '.luna-launcher-tint': { style: {} } };
const target = { style: {}, querySelector: key => rings[key] };
const event = { currentTarget: target, button: 0, stopPropagation() {}, preventDefault() {} };
task.props.onMousedown(event);
assert.equal(calls, 0, 'painting must not activate windows');
task.props.onMouseleave(event);
assert.equal(target.style.gradientFrom, task.props.style.gradientFrom, 'leaving cancels only the visual press');
find(panel, 'shell-menu').props.onKeydown({ ...event, key: 'Enter' });
assert.equal(calls, 1, 'existing keyboard activation is unchanged');
const events = lunaVisualEvents(xp);
events.onMouseenter(event);
assert.equal(rings['.luna-hot-ring'].style.opacity, '1');
events.onFocus(event);
assert.equal(rings['.luna-focus-ring'].style.opacity, '1');
const repaintedEvents = lunaVisualEvents(xp);
repaintedEvents.onMouseenter(event);
assert.equal(rings['.luna-focus-ring'].style.opacity, '1', 'reconciling visual handlers preserves focus painting');
events.onMousedown(event);
assert.equal(target.style.gradientFrom, pressed.gradientFrom);
events.onMouseup(event);
assert.equal(target.style.gradientFrom, normal.gradientFrom);
events.onBlur(event);
assert.equal(rings['.luna-focus-ring'].style.opacity, '0');
const launcherEvents = lunaVisualEvents(xp, { variant: 'launcher' });
launcherEvents.onMouseenter(event);
assert.equal(rings['.luna-launcher-tint'].style.opacity, '0.12');
launcherEvents.onMousedown(event);
assert.equal(rings['.luna-launcher-tint'].style.backgroundColor, '#000000');
launcherEvents.onMouseup(event);
assert.equal(rings['.luna-launcher-tint'].style.backgroundColor, '#ffffff');
const settings = settingsView(xp, action, action, action);
assert.ok(find(settings, 'shell-theme-xp').props.onMouseenter);
const apps = applicationsView(xp, [], '', action, action, action, action);
assert.equal(find(apps, 'shell-app-search').props.style.borderRadius, 0);
const classicPanel = panelView(catalog.themes[1], '10:31 AM', action);
assert.equal(find(classicPanel, 'shell-menu').props.style.height, 28);
assert.equal(find(classicPanel, 'shell-notification-area'), undefined);
if (process.argv[2]) {
  const data = readFileSync(process.argv[2], 'utf8').trim().split(/\s+/).slice(4).map(Number);
  assert.equal(data.length, 180);
  for (let y = 0; y < 30; y++) {
    const rgb = data.slice(y * 6 + 3, y * 6 + 6).map(value => value.toString(16).padStart(2, '0')).join('');
    assert.equal(lunaBandColor(xp, 'title', y + 0.5, 30), '#' + rgb);
  }
  console.log('PASS: JS preview and actual native C title-band samples agree at 96 DPI');
}
console.log('PASS: Luna schema compatibility, recovery parity, geometry, primitives, state painting and unchanged activation');
