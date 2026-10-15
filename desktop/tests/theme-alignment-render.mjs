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
