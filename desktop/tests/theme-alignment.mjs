import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
register('./root-loader.mjs', import.meta.url);
const { parseThemeCatalog, parseThemeFile, applyThemeOverrides } = await import('../shared/ui/theme-schema.mjs');
const { dockSurfaceWidth, applicationMenuPlacement, applicationMenuHeight } = await import('../shared/ui/theme-layout.mjs');
const { panelView, dockView, applicationsView } = await import('../shell/views.mjs');
const { desktopCommand } = await import('../shared/ui/presentation.mjs');
const { surfacePaint, surfaceEvents, bevel } = await import('../shared/ui/surface-primitives.mjs');
const { lunaVisualEvents } = await import('../shared/ui/luna-primitives.mjs');
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
      3 * theme.layout.dockTileWidth + 13 + theme.layout.dockWindowWidth + 4 * theme.layout.dockGap);
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
for (const theme of catalog.themes) {
  for (const count of [0, 1, 2]) {
    const generic = { ...theme, panel: { ...theme.panel, surfaceStyle: 'generic' } };
    assert.equal(dockSurfaceWidth(generic, count, 10000),
      theme.layout.dockBaseWidth + count * (theme.layout.dockWindowWidth + theme.layout.windowGap));
    if (!['tiger', 'lion', 'bigsur'].includes(theme.panel.surfaceStyle)) {
      assert.equal(dockSurfaceWidth(theme, count, 10000), dockSurfaceWidth(generic, count, 10000));
      continue;
    }
    for (const gap of [0, theme.layout.dockGap, 12]) {
      const custom = { ...theme, layout: { ...theme.layout, dockGap: gap } };
      const windows = Array.from({ length: count }, (_, i) => ({ id: i + 1 }));
      const dock = dockView(custom, action, action, action, windows, action, action);
      const children = dock.children.filter(child => child.props.style.position !== 'absolute');
      const naturalWidth = dock.props.style.paddingLeft + dock.props.style.paddingRight +
        children.reduce((total, child) => {
          const style = child.props.style;
          const width = child.props.id === 'shell-dock-windows' ?
            child.children.reduce((sum, slot) => sum + slot.props.style.width, 0) +
              Math.max(0, child.children.length - 1) * style.gap : style.width;
          return total + width + (style.marginLeft || 0) + (style.marginRight || 0);
        }, 0) + Math.max(0, children.length - 1) * dock.props.style.gap;
      const exactAvailable = naturalWidth + 2 * custom.layout.screenInset;
      assert.equal(dockSurfaceWidth(custom, count, 10000), naturalWidth);
      assert.equal(dockSurfaceWidth(custom, count, exactAvailable), naturalWidth);
      assert.equal(dockSurfaceWidth(custom, count, exactAvailable - 1), naturalWidth - 1);
      assert.equal(dockSurfaceWidth(custom, count, 100), 100 - 2 * custom.layout.screenInset);
    }
  }
}
{
  const theme = catalog.themes.find(theme => theme.id === 'modern');
  const panel = panelView(theme, '10:31', action, '', action,
    [{ id: 1, title: 'Selected', active: true }, { id: 2, title: 'Running', active: false }], action, action);
  const task = find(panel, 'shell-window-2'), focus = { style: {} };
  const node = { style: { ...task.props.style }, querySelector: selector => selector === '.theme-focus-ring' ? focus : null };
  assert.equal(node.style.backgroundColor, 'transparent');
  task.props.onMouseenter({ currentTarget: node });
  assert.equal(node.style.backgroundColor, theme.colors.selection);
  task.props.onUpdate(node);
  assert.equal(node.style.backgroundColor, theme.colors.selection);
  task.props.onMousedown({ currentTarget: node, button: 0 });
  assert.equal(node.style.backgroundColor, theme.button.to);
  task.props.onMousecancel({ currentTarget: node });
  assert.equal(node.style.backgroundColor, 'transparent');
  task.props.onFocus({ currentTarget: node });
  assert.equal(focus.style.opacity, '1');
  task.props.onBlur({ currentTarget: node });
  assert.equal(focus.style.opacity, '0');
  assert.equal(surfacePaint(theme, { variant: 'task', selected: true }).backgroundColor, theme.button.from);
  assert.equal(find(panel, 'shell-window-list').props.style.minWidth, theme.layout.windowButtonWidth);
  assert.equal(find(panel, 'shell-centered-tasks').props.style.overflow, 'scroll');
  const entries = [{ id: 'last', name: 'Last' }];
  const menu = applicationsView(theme, entries, '', action, action, action, action, '', action,
    { has: () => false, add: action });
  const viewport = { id: 'shell-start-apps', offsetTop: 124, offsetHeight: 16, scrollTop: 0,
    childNodes: [{ offsetTop: 132, offsetHeight: 102 }, { offsetTop: 242, offsetHeight: 102 }] };
  const nested = { parentNode: viewport };
  const item = { style: {}, querySelector: () => null, parentNode: nested, offsetTop: 242, offsetHeight: 80 };
  find(menu, 'shell-app-last').props.onFocus({ currentTarget: item });
  assert.equal(viewport.scrollTop, 118);
  find(menu, 'shell-app-last').props.onFocus({ currentTarget: item });
  assert.equal(viewport.scrollTop, 118);
  item.offsetTop = 324; item.offsetHeight = 20;
  find(menu, 'shell-app-pin-last').props.onFocus({ currentTarget: item });
  assert.equal(viewport.scrollTop, 200);
}
{
  const xp = catalog.themes.find(theme => theme.id === 'xp');
  const custom = applyThemeOverrides(catalog, JSON.stringify({ schemaVersion: 1,
    themes: { xp: { layout: { launcherWidth: 123 } } } })).themes.find(theme => theme.id === 'xp');
  assert.equal(find(panelView(xp, '', action), 'shell-menu').props.style.width, 97);
  assert.equal(find(panelView(custom, '', action), 'shell-menu').props.style.width, 123);
  for (const theme of catalog.themes) {
    const menu = applicationsView(theme, apps, '', action, action, action, action);
    const links = find(menu, 'shell-start-links');
    if (theme.id === 'xp') {
      assert.equal(links.props.style.minHeight, 0);
      assert.equal(links.props.style.overflow, 'scroll');
      assert.equal(typeof links.props.onWheel, 'function');
      const close = find(menu, 'shell-app-close');
      const strip = { id: 'shell-start-links', offsetTop: 88, offsetHeight: 100, scrollTop: 0,
        childNodes: [{ offsetTop: 94, offsetHeight: 34 }, { offsetTop: 134, offsetHeight: 34 },
          { offsetTop: 174, offsetHeight: 34 }], style: { padding: 6 } };
      const node = { parentNode: strip, offsetTop: 174, offsetHeight: 34 };
      close.props.onFocus({ currentTarget: node });
      assert.equal(strip.scrollTop, 20);
      close.props.onFocus({ currentTarget: node });
      assert.equal(strip.scrollTop, 20);
    } else if (links) {
      assert.equal(links.props.style.overflow, undefined, theme.id + ' right column unchanged');
      assert.equal(links.props.onWheel, undefined, theme.id + ' wheel route unchanged');
    }
  }
}
for (const id of ['aqua', 'lion', 'bigsur']) {
  const theme = applyThemeOverrides(catalog, JSON.stringify({ schemaVersion: 1,
    themes: { [id]: { panel: { from: '#804020', to: '#204080' } } } })).themes.find(theme => theme.id === id);
  const dock = dockView(theme, action, action, action, [{ id: 1, minimized: true }]);
  if (id === 'lion') {
    const shelf = dock.children[0];
    assert.equal(shelf.children.length, 25);
    shelf.children.slice(0, 24).forEach((row, y) => {
      assert.equal(row.props.style.left, 12 - y / 2);
      assert.equal(row.props.style.right, 12 - y / 2);
      assert.equal(row.props.style.backgroundColor, y === 0 ? '#eeeeee' : y < 12 ? '#804020' : '#999999');
    });
    assert.equal(shelf.children[24].props.style.backgroundColor, '#204080');
    assert.equal(shelf.children[24].props.style.borderColor, '#d6d6d6');
  } else {
    assert.equal(dock.props.style.gradientFrom, '#804020');
    assert.equal(dock.props.style.gradientTo, '#204080');
  }
}
for (const id of ['aqua', 'lion', 'bigsur']) {
  for (const painted of [false, true]) {
    const theme = painted ? applyThemeOverrides(catalog, JSON.stringify({ schemaVersion: 1,
      themes: { [id]: { button: { surfaceStyle: 'aqua' } } } })).themes.find(theme => theme.id === id) :
      catalog.themes.find(theme => theme.id === id);
    const menu = find(panelView(theme, '10:31', action, '', action), 'shell-menu');
    const node = { style: { ...menu.props.style }, querySelector: () => null };
    assert.equal(node.style.borderRadius, 0);
    for (const name of ['onMouseenter', 'onMousedown', 'onMouseup', 'onMouseleave', 'onFocus', 'onBlur']) {
      menu.props[name]?.({ currentTarget: node, button: 0 });
      assert.equal(node.style.borderRadius, 0, id + ' menubar radius during ' + name);
    }
    if (menu.props.onMouseenter) {
      const event = { currentTarget: node, button: 0 };
      menu.props.onMouseenter(event);
      const rebuilt = find(panelView(theme, '10:32', action, '', action), 'shell-menu');
      rebuilt.props.onFocus(event);
      assert.equal(node.style.backgroundColor, theme.colors.selection, 'Stable theme retains hover after rebuild/focus');
      rebuilt.props.onMousedown(event);
      const held = find(panelView(theme, '10:33', action, '', action), 'shell-menu');
      held.props.onMouseup(event);
      assert.equal(node.style.backgroundColor, theme.colors.selection, 'Stable theme retains hover after held rebuild/release');
      const rethemed = { ...theme, colors: { ...theme.colors, selection: '#112233' } };
      const updated = find(panelView(rethemed, '10:34', action, '', action), 'shell-menu');
      updated.props.onFocus(event);
      assert.equal(node.style.backgroundColor, 'transparent', 'New theme does not inherit old hover state');
      updated.props.onMouseenter(event);
      assert.equal(node.style.backgroundColor, '#112233', 'New theme uses its own palette');
      assert.equal(node.style.borderRadius, 0);
    }
    const ordinary = desktopCommand('ordinary', 'Ordinary', theme, action);
    const ordinaryNode = { style: { ...ordinary.props.style }, querySelector: () => null };
    ordinary.props.onFocus?.({ currentTarget: ordinaryNode });
    assert.equal(ordinaryNode.style.borderRadius, theme.button.radius);
  }
}
for (let size = 2; size <= 12; size++) {
  const theme = applyThemeOverrides(catalog, JSON.stringify({ schemaVersion: 1,
    themes: { aqua: { layout: { dockIndicatorSize: size } } } })).themes.find(theme => theme.id === 'aqua');
  const dock = dockView(theme, action, action, action, [{ id: 1, active: false, minimized: true }]);
  const indicator = find(dock, 'shell-window-1').children[1];
  assert.equal(indicator.props.style.width, size);
  assert.equal(indicator.props.style.height, 4);
  assert.equal(indicator.props.style.bottom, 1);
  assert.equal(indicator.children.length, 4);
  const rows = indicator.children.map(node => node.props.style);
  rows.forEach((row, y) => {
    assert.ok(Number.isInteger(row.left) && Number.isInteger(row.width));
    assert.ok(row.width > 0 && row.left >= 0 && row.left + row.width <= size);
    assert.equal(row.left * 2 + row.width, size);
    assert.equal(row.top, y);
    assert.equal(row.height, 1);
    if (y) assert.ok(row.width >= rows[y - 1].width);
  });
  assert.equal(rows[3].width, size);
  if (size === 7) assert.deepEqual(rows.map(row => [row.left, row.width]), [[3, 1], [2, 3], [1, 5], [0, 7]]);
}
for (const [id, width, height, color] of [['lion', 8, 3, '#bde8ff'], ['bigsur', 4, 4, '#303030']]) {
  const theme = catalog.themes.find(theme => theme.id === id);
  const indicator = find(dockView(theme, action, action, action, [{ id: 1, minimized: true }]), 'shell-window-1').children[1];
  assert.equal(indicator.props.style.width, width);
  assert.equal(indicator.props.style.height, height);
  assert.equal(indicator.props.style.backgroundColor, color);
  assert.equal(indicator.children.length, 0);
}
assert.equal(catalog.default, 'modern');
const narrow = JSON.parse(JSON.stringify(catalog.themes.find(theme => theme.id === 'modern')));
Object.assign(narrow.window, { controlWidth: 8, controlSize: 16, glyphRadius: 3, glyphThickness: 1, closeThickness: 4 });
assert.throws(() => parseThemeFile(JSON.stringify({ schemaVersion: 1, theme: narrow })), /fit/);
narrow.window.controlWidth = 14;
assert.doesNotThrow(() => parseThemeFile(JSON.stringify({ schemaVersion: 1, theme: narrow })));
assert.ok(find(applicationsView(catalog.themes[0], apps, '', action, action, action, action), 'shell-start-profile'));
assert.ok(find(applicationsView(catalog.themes[0], apps, '', action, action, action, action), 'shell-start-links'));
const server = catalog.themes.find(theme => theme.id === 'server2003');
assert.equal(server.panel.taskTexture, 'stipple');
const flatServer = applyThemeOverrides(catalog, JSON.stringify({ schemaVersion: 1,
  themes: { server2003: { panel: { taskTexture: 'flat' } } } })).themes.find(theme => theme.id === 'server2003');
const taskPanel = panelView(server, '10:31', action, '', action, [{ id: 1, active: true }]);
const flatPanel = panelView(flatServer, '10:31', action, '', action, [{ id: 1, active: true }]);
assert.equal(find(taskPanel, 'shell-window-1').children.filter(node => node.type === 'canvas').length, 1);
assert.equal(find(flatPanel, 'shell-window-1').children.filter(node => node.type === 'canvas').length, 0);
assert.throws(() => applyThemeOverrides(catalog, JSON.stringify({ schemaVersion: 1,
  themes: { server2003: { panel: { taskTexture: 'external-bitmap' } } } })), /unsupported/);
const serverMenu = applicationsView(server, apps, '', action, action, action, action);
assert.equal(server.panel.menuStyle, 'two-column');
assert.ok(find(serverMenu, 'shell-start-profile'));
assert.equal(find(serverMenu, 'shell-start-links').props.style.width, 184);
assert.equal(find(serverMenu, 'shell-start-links').props.style.backgroundColor, server.colors.body);
assert.equal(find(serverMenu, 'shell-start-profile').props.style.gradientDir, 'horizontal');
assert.equal(serverMenu.props.style.borderRadius, 0);
assert.equal(applicationMenuHeight(server, 480), 444);
assert.equal(applicationMenuHeight(server, 240), 208);
assert.equal(applicationMenuHeight(server, 0), 1);
assert.deepEqual(applicationMenuPlacement(server).margins, { left: 2, bottom: 24 });
assert.equal(applicationMenuPlacement(server, 320).width, 316);
assert.equal(applicationMenuPlacement(server, 0).width, 1);
const activePaint = surfacePaint(server, { selected: true, variant: 'task' });
assert.equal(activePaint.gradientFrom, activePaint.gradientTo);
assert.equal(activePaint.borderWidth, 0, 'the bevel painter owns Classic task edges without a generic overlay');
const pieces = { '.bevel-top': { style: {} }, '.bevel-inner-top': { style: {} },
  '.bevel-inner-left': { style: {} }, '.classic-task-content': { style: {} } };
const target = { style: {}, querySelector: key => pieces[key] };
const event = { currentTarget: target, button: 0 };
const taskEvents = surfaceEvents(server, { variant: 'task' });
taskEvents.onMouseenter(event);
assert.equal(target.style.gradientFrom, target.style.gradientTo);
taskEvents.onMousedown(event);
assert.equal(pieces['.bevel-top'].style.backgroundColor, '#404040');
assert.equal(pieces['.bevel-inner-top'].style.backgroundColor, server.colors.dark);
assert.equal(pieces['.classic-task-content'].style.top, '1');
taskEvents.onMouseleave(event);
assert.equal(pieces['.bevel-top'].style.backgroundColor, server.colors.light);
assert.equal(pieces['.bevel-inner-left'].style.backgroundColor, server.colors.body);
assert.equal(pieces['.classic-task-content'].style.top, '0');
assert.equal(target.style.gradientFrom, target.style.gradientTo);
taskEvents.onMousedown(event);
taskEvents.onMousecancel(event);
assert.equal(pieces['.classic-task-content'].style.top, '0');
taskEvents.onMousedown(event);
const reloaded = { ...server, colors: { ...server.colors } };
surfaceEvents(reloaded, { variant: 'task' }).onMouseenter(event);
assert.equal(pieces['.classic-task-content'].style.top, '0', 'a new theme snapshot retires a visual press on the retained node');
const raisedFrame = bevel(server, { frame: true });
assert.equal(raisedFrame.children.find(node => node.props.className === 'bevel-top').props.style.backgroundColor, server.colors.body);
assert.equal(raisedFrame.children.find(node => node.props.className === 'bevel-inner-top').props.style.backgroundColor, server.colors.light);
const legacy = applyThemeOverrides(catalog, JSON.stringify({ schemaVersion: 1,
  themes: { server2003: { panel: { menuStyle: 'legacy' } } } })).themes.find(theme => theme.id === 'server2003');
const legacyMenu = applicationsView(legacy, apps, '', action, action, action, action);
assert.ok(find(legacyMenu, 'shell-start-brand'));
assert.equal(find(legacyMenu, 'shell-start-profile'), undefined);
assert.equal(find(legacyMenu, 'shell-app-org.pollyui.settings').props.style.height, 22);
assert.ok(find(legacyMenu, 'shell-app-org.pollyui.settings').children
  .filter(child => child.props?.['aria-hidden'] === 'true' && child.props?.style?.width)
  .every(child => child.props.style.width <= 22));
for (const theme of catalog.themes.filter(theme => theme.id !== 'server2003')) {
  assert.equal(applicationMenuHeight(theme, 480),
    Math.max(1, Math.min(theme.layout.menuHeight, 480 - theme.panel.height - theme.layout.overlayInset * 2)));
  assert.equal(applicationMenuPlacement(theme, 320).width,
    Math.max(1, Math.min(theme.layout.menuWidth, 320 - theme.layout.screenInset * 2)));
  assert.equal(Object.hasOwn(applicationMenuPlacement(theme), 'width'), false);
}
assert.throws(() => applyThemeOverrides(catalog, JSON.stringify({ schemaVersion: 1,
  themes: { server2003: { panel: { menuStyle: 'arbitrary-code' } } } })), /unsupported/);
for (const preset of catalog.themes) {
  const custom = { ...preset, layout: { ...preset.layout, disabledOpacity: 0.37 } };
  const command = desktopCommand('disabled-state', 'Selected unavailable', custom,
    () => { throw new Error('Disabled action ran'); }, { enabled: false, selected: true });
  assert.equal(command.props.style.opacity, 0.37, preset.id + ' preserves configured disabled opacity');
  assert.equal(command.props['aria-pressed'], 'true');
  assert.equal(command.props['aria-disabled'], 'true');
  assert.equal(command.props.tabIndex, -1);
  command.props.onClick({ button: 0 });
  const callerOpacity = desktopCommand('caller-opacity', 'Unavailable', custom, action,
    { enabled: false, style: { opacity: 0.23 } });
  assert.equal(callerOpacity.props.style.opacity, 0.23, 'caller opacity is not replaced by a painter');
}
const visualTarget = () => {
  const parts = Object.fromEntries(['.theme-focus-ring', '.luna-focus-ring', '.luna-hot-ring',
    '.luna-launcher-tint', '.bevel-top'].map(key => [key, { style: { opacity: '1' } }]));
  const node = { style: { opacity: 0.37 }, disabled: 'false', parts,
    getAttribute: name => name === 'aria-disabled' ? node.disabled : null,
    querySelector: key => parts[key] || null, ownerDocument: {} };
  node.ownerDocument.activeElement = node;
  return node;
};
for (const [name, theme, factory, ring] of [
  ['Classic', server, surfaceEvents, '.theme-focus-ring'],
  ['Luna', catalog.themes[0], lunaVisualEvents, '.luna-focus-ring'],
]) {
  const node = visualTarget(), event = { currentTarget: node, button: 0 };
  const events = factory(theme);
  events.onMouseenter(event); events.onMousedown(event); events.onFocus(event);
  assert.equal(Number(node.parts[ring].style.opacity), 1, name + ' enabled focus remains visible');
  node.disabled = 'true';
  events.onUpdate(node);
  assert.equal(Number(node.parts[ring].style.opacity), 0, name + ' disabled reconciliation clears focus visuals');
  assert.equal(node.ownerDocument.activeElement, node, 'visual cleanup does not move actual focus');
  const disabledStyle = { ...node.style };
  for (const key of ['onMouseenter', 'onMousedown', 'onMouseup', 'onFocus', 'onBlur'])
    events[key](event);
  assert.deepEqual(node.style, disabledStyle, name + ' disabled input cannot repaint the face or opacity');
  node.disabled = 'false';
  events.onMouseenter(event);
  assert.equal(node.style.opacity, 0.37, 'paint does not own caller opacity in the enabled state either');
  if (name === 'Classic') assert.equal(node.parts['.bevel-top'].style.backgroundColor, theme.colors.light);
  else assert.equal(Number(node.parts['.luna-hot-ring'].style.opacity), 1);
  node.disabled = 'true';
  factory({ ...theme }).onMount(node);
  assert.equal(Number(node.parts[ring].style.opacity), 0, 'disabled mount/retheme remains quiet');
  const explicit = factory(theme, { disabled: true });
  node.disabled = 'false';
  explicit.onUpdate(node); explicit.onMousedown(event);
  assert.equal(Number(node.parts[ring].style.opacity), 0, 'native disabled option also suppresses active visuals');
}
console.log('PASS: six-theme geometry, menu activation, Dock keyboard behavior, disabled commands, recovery parity and placement seams');
