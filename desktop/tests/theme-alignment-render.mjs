import { h, render } from './gui/sdk/js/reconciler.mjs';
import { DESKTOP_THEMES } from './desktop/shell/themes.mjs';
import { panelView, dockView, applicationsView, button } from './desktop/shell/views.mjs';
import * as layout from './desktop/shell/theme-layout.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
const rectangle = node => node ? [node.offsetLeft, node.offsetTop, node.offsetWidth, node.offsetHeight] : null;
const action = () => {};
const entries = [
  { id: 'org.pollyui.settings', name: 'Settings', comment: 'System settings', keywords: ['preferences'] },
  { id: 'org.pollyui.files', name: 'Files', comment: 'Browse files', keywords: ['folders'] },
  { id: 'org.pollyui.terminal', name: 'Terminal', comment: 'Command line', keywords: ['console'] },
  { id: 'org.pollyui.processes', name: 'Processes', comment: 'System processes', keywords: ['tasks'] },
];
const windows = [{ id: 1, appId: 'org.pollyui.files', title: 'Documents', active: true },
  { id: 2, appId: 'org.pollyui.terminal', title: 'Terminal', minimized: true }];

export function captureThemeComponents(directory) {
  check(host.width === 1280 && host.height === 900, 'Capture requires an unscaled 1280x900 surface');
  for (const theme of DESKTOP_THEMES) {
    const dock = theme.panel.kind === 'dock';
    const width = Math.min(theme.layout.menuWidth, host.width - 24);
    const height = Math.min(theme.layout.menuHeight, host.height - theme.panel.height - 24);
    const top = dock ? theme.layout.menuBarHeight + 8 : host.height - theme.panel.height - height - theme.layout.menuGap;
    const dockWidth = dock ? layout.dockSurfaceWidth ?
      layout.dockSurfaceWidth(theme, windows.length, host.width) :
      theme.layout.dockBaseWidth + windows.length * (theme.layout.dockWindowWidth + theme.layout.windowGap) : 0;
    const menuLeft = theme.panel.surfaceStyle === 'fluent' ? (host.width - width) / 2 : 12;
    render(h('view', { style: { width: '100%', height: '100%', position: 'relative',
      backgroundColor: theme.desktop.from } },
      h('view', { style: { position: 'absolute', left: 16, top: dock ? 42 : 16,
        fontSize: 12, color: '#ffffff', pointerEvents: 'none' } },
        'Actual PollyUI component fixture - not a native desktop capture'),
      h('view', { id: 'fixture-menu', style: { position: 'absolute', left: menuLeft, top, width, height } },
        applicationsView(theme, entries, '', action, action, action, action, '', action)),
      h('view', { id: 'fixture-control', style: { position: 'absolute', right: 24, top: 70,
        width: 120, height: theme.layout.buttonHeight } }, button('fixture-button', 'OK', theme, action)),
      h('view', { style: { position: 'absolute', left: 0, right: 0,
        [dock ? 'top' : 'bottom']: 0, height: dock ? theme.layout.menuBarHeight : theme.panel.height } },
        panelView(theme, '10:31 AM', action, '', action, windows, action, action,
          { name: 'Workspaces', open: action }, { count: 1, open: action })),
      dock ? h('view', { id: 'fixture-dock', style: { position: 'absolute',
        left: (host.width - dockWidth) / 2, bottom: theme.panel.inset, width: dockWidth, height: theme.panel.height } },
        dockView(theme, action, action, action, windows, action, action)) : null), document.body);
    host.render();
    document.activeElement?.blur();
    host.render();
    const element = id => document.getElementById(id);
    check(element('shell-panel').offsetHeight === (dock ? theme.layout.menuBarHeight : theme.panel.height),
      theme.id + ' actual panel height differs from the catalog');
    const file = directory + '\\components-' + theme.id + '-1280x900.png';
    check(host.save(file), 'Cannot save actual component evidence: ' + file);
    console.log('GEOMETRY ' + JSON.stringify({ theme: theme.id, viewport: [1280, 900], scale: 1,
      menu: rectangle(element('shell-applications')), panel: rectangle(element('shell-panel')),
      dock: rectangle(element('shell-dock')), launcher: rectangle(element('shell-menu')),
      task: rectangle(element('shell-window-1')), search: rectangle(element('shell-app-search')),
      button: rectangle(element('fixture-button')), file }));
    const buttonNode = element('fixture-button');
    buttonNode.focus(); host.render();
    check(document.activeElement === buttonNode, 'Themed button lost keyboard focus');
    const x = buttonNode.offsetLeft + buttonNode.offsetWidth / 2;
    const y = buttonNode.offsetTop + buttonNode.offsetHeight / 2;
    host.mouse('mousemove', x, y); host.mouse('mousedown', x, y); host.render();
    host.mouse('mouseup', x, y); host.render();
    check(document.activeElement === buttonNode, 'Pointer state painting changed keyboard focus');
  }

  console.log('PASS: actual six-theme component bytes and layout, focus and pointer state paths');
}

export function checkDockOverflow() {
  const theme = DESKTOP_THEMES.find(item => item.id === 'lion');
  const normalWidth = layout.dockSurfaceWidth(theme, windows.length, 1280);
  render(h('view', { style: { width: normalWidth, height: theme.panel.height } },
    dockView(theme, action, action, action, windows, action, action)), document.body);
  host.render();
  const normalFixed = ['shell-dock-applications', 'shell-dock-settings', 'shell-dock-about']
    .map(id => document.getElementById(id));
  check(normalWidth === 317 && document.getElementById('shell-dock').offsetWidth === 317,
    'The ordinary two-window Dock must retain its frozen surface width');
  check(normalFixed.every((node, i) => node.offsetWidth === 56 &&
    (!i || node.offsetLeft - normalFixed[i - 1].offsetLeft === 58)),
  'Ordinary fixed Dock actions must retain their slot width and spacing');
  const many = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, title: 'Window ' + (i + 1) }));
  let activated = 0;
  const width = layout.dockSurfaceWidth(theme, many.length, 320);
  render(h('view', { style: { width, height: theme.panel.height } },
    dockView(theme, action, action, action, many, id => { activated = id; }, action)), document.body);
  host.render();
  const get = id => document.getElementById(id);
  const strip = get('shell-dock-windows'), last = get('shell-window-20');
  check(strip.offsetWidth > 0 && strip.offsetWidth < 2 * theme.layout.dockWindowWidth,
    'Clamped Dock must give window slots a bounded, nonzero scroll viewport');
  const fixed = ['shell-dock-applications', 'shell-dock-settings', 'shell-dock-about'].map(get);
  const positions = fixed.map(rectangle);
  check(fixed.every(node => node.offsetLeft >= 0 && node.offsetLeft + node.offsetWidth <= width),
    'Fixed Dock actions must remain visible when window slots overflow');
  const x = strip.offsetLeft + strip.offsetWidth / 2, y = strip.offsetTop + 20;
  host.scroll(x, y, 100000); host.render();
  check(Number(strip.scrollLeft) > 0, 'Actual wheel dispatch must scroll the window strip');
  const visibleLeft = last.offsetLeft - Number(strip.scrollLeft);
  console.log('DOCK_OVERFLOW ' + JSON.stringify({ strip: rectangle(strip), scrollLeft: strip.scrollLeft,
    last: rectangle(last), bounds: last.getBoundingClientRect(), visibleLeft }));
  check(visibleLeft >= strip.offsetLeft && visibleLeft + last.offsetWidth <= strip.offsetLeft + strip.offsetWidth,
    'The last running window must be fully reachable after horizontal scrolling');
  host.mouse('mousedown', visibleLeft + last.offsetWidth / 2, last.offsetTop + 20);
  host.mouse('mouseup', visibleLeft + last.offsetWidth / 2, last.offsetTop + 20);
  host.mouse('click', visibleLeft + last.offsetWidth / 2, last.offsetTop + 20); host.render();
  check(activated === 20, 'The reached window must retain actual pointer activation');
  host.scroll(x, y, -100000); host.render();
  check(Number(strip.scrollLeft) === 0, 'Reverse wheel dispatch must return to the first window');
  last.focus(); host.render();
  check(document.activeElement === last && Number(strip.scrollLeft) > 0,
    'Keyboard focus must reveal an offscreen window slot');
  check(fixed.every((node, i) => JSON.stringify(rectangle(node)) === JSON.stringify(positions[i])),
    'Scrolling and focus must not move or shrink the fixed Dock actions');
  console.log('PASS: actual clamped Dock wheel reachability, pointer activation, focus reveal and fixed actions');
}

export function captureServer2003Reference(directory) {
  check(host.width === 640 && host.height === 480, 'Server reference fixture requires an unscaled 640x480 surface');
  const theme = DESKTOP_THEMES.find(item => item.id === 'server2003');
  const height = layout.applicationMenuHeight(theme, host.height);
  let launched = '';
  const menu = (apps = entries) => applicationsView(theme, apps, '', action, id => { launched = id; }, action, action, '', action);
  render(h('view', { style: { width: '100%', height: '100%', position: 'relative',
    backgroundColor: theme.desktop.from } },
    h('view', { style: { position: 'absolute', left: 0, bottom: theme.panel.height,
      width: theme.layout.menuWidth, height } }, menu()),
    h('view', { style: { position: 'absolute', left: 0, right: 0, bottom: 0, height: theme.panel.height } },
      panelView(theme, '5:05 PM', action, '', action, windows, action, action))),
  document.body);
  host.render(); document.activeElement?.blur(); host.render();
  const get = id => document.getElementById(id);
  check(get('shell-applications').offsetWidth === 380 && get('shell-applications').offsetHeight === 442,
    'Two-column menu must use measured preferred dimensions without changing screen resolution');
  check(get('shell-start-profile').offsetHeight === 40 && get('shell-start-links').offsetWidth === 184,
    'Classic header/gray second column geometry must match configured measurements');
  check(host.save(directory + '\\server2003-two-column-640x480.png'), 'Cannot save Server 2003 component evidence');
  console.log('SERVER_GEOMETRY ' + JSON.stringify({
    viewport: [640, 480], scale: 1, menu: rectangle(get('shell-applications')),
    header: rectangle(get('shell-start-profile')), links: rectangle(get('shell-start-links')),
    footer: rectangle(get('shell-start-footer')), panel: rectangle(get('shell-panel')),
    app: rectangle(get('shell-app-org.pollyui.settings')),
  }));
  const many = Array.from({ length: 20 }, (_, i) => ({ id: 'fixture-' + i, name: 'Application ' + i,
    comment: '', keywords: [] }));
  const lowHeight = layout.applicationMenuHeight(theme, 240);
  render(h('view', { style: { width: 380, height: lowHeight } }, menu(many)), document.body);
  host.render();
  const list = get('shell-start-apps'), last = get('shell-app-fixture-19');
  const footer = get('shell-start-footer'), search = get('shell-app-search');
  check(list.offsetHeight > 0 && footer.offsetTop + footer.offsetHeight <= lowHeight &&
    search.offsetTop + search.offsetHeight <= footer.offsetTop,
  'Small-height menu must retain visible search/footer and a real scrolling app viewport');
  host.scroll(list.offsetLeft + 30, list.offsetTop + list.offsetHeight / 2, 100000); host.render();
  const bounds = last.getBoundingClientRect();
  console.log('SERVER_SMALL ' + JSON.stringify({ height: lowHeight, list: rectangle(list),
    scrollTop: list.scrollTop, last: bounds, search: rectangle(search), footer: rectangle(footer) }));
  host.mouse('mousedown', bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  host.mouse('mouseup', bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  host.mouse('click', bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); host.render();
  check(launched === 'fixture-19', 'The final application must remain scrollable and actually launchable');
  search.focus(); host.render();
  check(document.activeElement === search, 'Search retains actual focus in the small-height layout');
  console.log('PASS: Server Classic two-column component dimensions, low-height scrolling, launch and focus');
}
