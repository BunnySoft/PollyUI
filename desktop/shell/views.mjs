import { button } from './desktop/shared/ui/button.mjs';
export { button };
export { settingsView } from './desktop/apps/settings/ui/appearance.mjs';
export { shortcutsView } from './desktop/apps/settings/ui/keyboard.mjs';
export { displaysView } from './desktop/apps/settings/ui/displays.mjs';
import { h } from './gui/sdk/js/reconciler.mjs';
import { DESKTOP_THEMES } from './desktop/shell/themes.mjs';


import { trayView } from './desktop/shell/tray.mjs';
import { themeTextSize } from './desktop/shell/theme-layout.mjs';
import { isLuna, lunaBands, lunaButtonPaint, lunaButtonDetail, lunaVisualEvents, lunaSymbol } from './desktop/shell/luna-primitives.mjs';
import { desktopCommand, desktopText, settingsCard, scrollDesktop } from './desktop/shell/presentation.mjs';

export { wallpaper } from './desktop/shell/appearance.mjs';

const row = { flexDirection: 'row', alignItems: 'center' };
const center = { alignItems: 'center', justifyContent: 'center' };
const gradient = (from, to) => ({ backgroundColor: from, gradientFrom: from, gradientTo: to });
const labelFor = theme => (value, color, size = 12) =>
  h('view', { style: { color, fontSize: themeTextSize(theme, size), flexShrink: 0 } }, value);

function windowButtons(theme, windows, toggle, actions, compact = false) {
  return h('view', { id: 'shell-window-list', style: {
    ...row, flexGrow: 1, flexBasis: 0, minWidth: 0, gap: theme.layout.windowGap, overflow: 'scroll',
  }, onWheel: event => {
    event.preventDefault();
    const node = event.currentTarget;
    const extent = node.childNodes.reduce((maximum, child) =>
      Math.max(maximum, child.offsetLeft + child.offsetWidth - node.offsetLeft), 0);
    node.scrollLeft = Math.max(0, Math.min(extent - node.offsetWidth,
      Number(node.scrollLeft) + (event.deltaX || event.deltaY)));
  } }, windows.map(window => {
    const title = window.title || window.appId || 'Untitled';
    const short = Array.from(title).slice(0, compact ? theme.layout.dockTitleLimit : theme.layout.windowTitleLimit).join('');
    const node = button('shell-window-' + window.id,
      (window.minimized ? '[min] ' : '') + short, theme, () => toggle(window.id), window.active,
      { width: compact ? theme.layout.dockWindowWidth : theme.layout.windowButtonWidth,
        height: compact ? theme.panel.height - theme.layout.panelItemInset : theme.layout.buttonHeight,
        overflow: 'hidden', ...(window.active ? gradient(theme.colors.selection, theme.colors.selection) : {}) });
    if (!compact && isLuna(theme, 'panel')) {
      Object.assign(node.props.style, lunaButtonPaint(theme, { selected: window.active, variant: 'task' }),
        { height: theme.panel.height - theme.layout.panelItemInset, alignItems: 'center',
          justifyContent: 'flex-start', flexDirection: 'row', gap: 5, paddingLeft: 7 });
      Object.assign(node.props, lunaVisualEvents(theme, { selected: window.active, variant: 'task' }));
      const caption = labelFor(theme)(short, theme.panel.text);
      caption.props.style.pointerEvents = 'none';
      node.children = [
        lunaButtonDetail(theme, 'task'), lunaSymbol('document'),
        caption,
      ];
    }
    node.props['aria-label'] = title;
    node.props.onClick = event => {
      if (event.button === 0) { event.stopPropagation(); toggle(window.id); }
    };
    node.props.onContextmenu = event => { event.preventDefault(); event.stopPropagation(); actions(window.id); };
    const activate = node.props.onKeydown;
    node.props.onKeydown = event => {
      if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
        event.preventDefault(); actions(window.id);
      } else activate(event);
    };
    return node;
  }));
}

export function panelView(theme, clock, openMenu, error = '', openSettings = openMenu,
  windows = [], toggle = () => {}, actions = () => {}, workspace = null, notifications = null, tray = null) {
  const panel = theme.panel;
  const label = labelFor(theme);
  if (isLuna(theme, 'panel') && panel.kind === 'taskbar') {
    const tool = (id, name, symbol, callback) => {
      const node = button(id, name, theme, callback, false, {
        height: theme.layout.compactButtonHeight, width: 24, paddingLeft: 0, paddingRight: 0,
        ...lunaButtonPaint(theme, { variant: 'tool' }),
      });
      Object.assign(node.props, lunaVisualEvents(theme, { variant: 'tool' }));
      node.children = [lunaButtonDetail(theme, 'tool'), lunaSymbol(symbol)];
      return node;
    };
    const launcher = button('shell-menu', 'Polly', theme, openMenu, false, {
      height: panel.height, width: 97, borderWidth: 0, borderRadius: 0,
      paddingLeft: 7, paddingRight: 10, flexDirection: 'row', gap: 5,
      ...lunaButtonPaint(theme, { variant: 'launcher' }),
    });
    Object.assign(launcher.props, lunaVisualEvents(theme, { variant: 'launcher' }));
    launcher.children = [lunaButtonDetail(theme, 'launcher'), lunaSymbol('polly', panel.launcherText, 22),
      h('view', { style: { color: panel.launcherText, fontSize: 18, fontWeight: 700,
        fontStyle: 'italic', pointerEvents: 'none' } }, 'Polly')];
    return h('view', { id: 'shell-panel', style: {
      ...row, width: '100%', height: '100%', gap: theme.layout.panelGap,
      paddingLeft: theme.layout.panelPaddingLeft, paddingRight: theme.layout.panelPaddingRight,
      ...gradient(panel.from, panel.to), position: 'relative',
    } }, lunaBands(theme, 'panel', panel.height), launcher,
      tool('shell-panel-settings', 'Settings', 'appearance', openSettings),
      workspace ? tool('shell-workspaces', workspace.name, 'workspace', workspace.open) : null,
      windowButtons(theme, windows, toggle, actions),
      error ? label('Desktop needs attention', panel.text, 11) : null,
      h('view', { id: 'shell-notification-area', style: {
        ...row, flexShrink: 0, height: panel.height, position: 'relative',
        paddingLeft: 8, paddingRight: 10, gap: theme.layout.trayGap,
        borderLeftWidth: 1, borderColor: '#095bc9', backgroundColor: '#1285e1',
      } }, lunaBands(theme, 'tray', panel.height),
        tray?.items.length || tray?.error ? trayView(theme, tray.items, tray.activate, tray.scroll, tray.error) : null,
        notifications ? tool('shell-notifications', 'Notifications ' + notifications.count, 'notification', notifications.open) : null,
        h('view', { id: 'shell-clock', style: { color: panel.text, fontSize: theme.layout.fontSize,
          paddingLeft: 5, flexShrink: 0 } }, clock)));
  }
  if (theme.id === 'modern') {
    return h('view', { id: 'shell-panel', style: { ...row, width: '100%', height: '100%',
      gap: 8, paddingLeft: 12, paddingRight: 16, backgroundColor: panel.from,
      borderTopWidth: 1, borderColor: theme.colors.border } },
    desktopCommand('shell-menu', 'Polly', theme, openMenu, { icon: 'apps', quiet: true }),
    desktopCommand('shell-panel-settings', 'Settings', theme, openSettings, { icon: 'appearance', quiet: true }),
    workspace ? desktopCommand('shell-workspaces', Array.from(workspace.name).slice(0, 18).join(''), theme,
      workspace.open, { icon: 'displays', quiet: true, style: { maxWidth: 160, overflow: 'hidden' } }) : null,
    windowButtons(theme, windows, toggle, actions),
    error ? desktopText('Needs attention', theme.colors.text, 12) : null,
    tray?.items.length || tray?.error ? trayView(theme, tray.items, tray.activate, tray.scroll, tray.error) : null,
    notifications ? desktopCommand('shell-notifications', String(notifications.count), theme, notifications.open,
      { icon: 'info', quiet: true, style: { paddingLeft: 8, paddingRight: 8 } }) : null,
    desktopText(clock, panel.text, 13));
  }
  return h('view', { id: 'shell-panel', style: {
    ...row, width: '100%', height: '100%', gap: theme.layout.panelGap,
    paddingLeft: theme.layout.panelPaddingLeft, paddingRight: theme.layout.panelPaddingRight,
    ...gradient(panel.from, panel.to), borderWidth: theme.layout.borderWidth, borderColor: theme.colors.light,
  } },
  button('shell-menu', 'Polly', theme, openMenu, false, {
    height: panel.kind === 'dock' ? theme.layout.compactButtonHeight : theme.layout.buttonHeight,
    ...gradient(panel.launcherFrom, panel.launcherTo),
  }),
  button('shell-panel-settings', 'Settings', theme, openSettings, false, { height: theme.layout.compactButtonHeight }),
  workspace ? button('shell-workspaces', Array.from(workspace.name).slice(0, theme.layout.workspaceTitleLimit).join(''),
    theme, workspace.open, false, { height: theme.layout.compactButtonHeight, maxWidth: theme.layout.workspaceWidth, overflow: 'hidden' }) :
    label('PollyDesktop', panel.text, 12),
  panel.kind === 'taskbar' ? windowButtons(theme, windows, toggle, actions) :
    h('view', { style: { flexGrow: 1 } }),
  error ? label('Desktop needs attention', panel.text, 11) : null,
  tray?.items.length || tray?.error ? trayView(theme, tray.items, tray.activate, tray.scroll, tray.error) : null,
  notifications ? button('shell-notifications', 'Notifications ' + notifications.count, theme,
    notifications.open, false, { height: theme.layout.compactButtonHeight }) : null,
  label(clock, panel.text, 12));
}

export function dockView(theme, openSettings, openAbout, openApplications = openSettings,
  windows = [], toggle = () => {}, actions = () => {}) {
  const panel = theme.panel;
  const tile = { height: panel.height - theme.layout.panelItemInset, width: theme.layout.dockTileWidth,
    borderRadius: theme.icons.dockTiles ? theme.icons.radius : theme.button.radius };
  return h('view', { id: 'shell-dock', style: {
    ...row, justifyContent: 'center', width: '100%', height: '100%', gap: theme.layout.dockGap,
    borderWidth: theme.layout.borderWidth, borderColor: theme.colors.light, borderRadius: panel.radius,
    ...gradient(panel.from, panel.to),
  } },
  button('shell-dock-applications', 'Apps', theme, openApplications, false, tile),
  button('shell-dock-settings', 'Settings', theme, openSettings, false, tile),
  button('shell-dock-about', 'About', theme, openAbout, false, tile),
  windows.length ? windowButtons(theme, windows, toggle, actions, true) : null);
}

export function applicationsView(theme, entries, query, changeQuery, launch, refresh, close, error = '', logout = null, desktop = null) {
  const label = labelFor(theme);
  const filtered = entries.filter(entry =>
    (entry.name + ' ' + (entry.genericName || '') + ' ' + entry.comment + ' ' +
      entry.keywords.join(' ')).toLowerCase().includes(query.toLowerCase()));
  return h('view', { id: 'shell-applications', style: {
    width: '100%', height: '100%', padding: theme.layout.compactPadding, gap: theme.layout.contentGap, backgroundColor: theme.colors.body,
    borderWidth: theme.layout.borderWidth, borderColor: theme.colors.border,
    borderRadius: isLuna(theme) ? 0 : theme.window.radius,
  } },
  h('view', { style: { ...row, gap: theme.layout.contentGap,
    ...(isLuna(theme) ? { padding: 6, ...gradient(theme.window.titleFrom, theme.window.titleTo) } : {}) } },
    label('Applications', isLuna(theme) ? theme.window.titleText : theme.colors.text, 16),
    h('view', { style: { flexGrow: 1 } }), button('shell-app-refresh', 'Refresh', theme, refresh),
    button('shell-app-close', 'Close', theme, close)),
  h('view', { id: 'shell-app-search', role: 'textbox', 'aria-label': 'Search applications', tabIndex: 0,
    style: { padding: theme.layout.serviceButtonPadding, height: theme.layout.choiceHeight + 2 * theme.layout.borderWidth, flexShrink: 0, backgroundColor: theme.colors.surface,
      borderWidth: theme.layout.borderWidth, borderColor: theme.colors.border,
      borderRadius: isLuna(theme) ? 0 : theme.button.radius },
    focusStyle: { borderColor: theme.colors.accent },
    onTextinput: event => changeQuery(Array.from(query + event.data).slice(0, 128).join('')),
    onKeydown: event => {
      if (event.key === 'Backspace') { event.preventDefault(); changeQuery(Array.from(query).slice(0, -1).join('')); }
      if (event.key === 'Enter' && filtered[0]) { event.preventDefault(); launch(filtered[0].id); }
    },
  }, label(query || 'Type to search...', query ? theme.colors.text : theme.colors.muted)),
  h('view', { style: { flexGrow: 1, flexBasis: 0, minHeight: 0, overflow: 'scroll', gap: theme.layout.windowGap } },
    filtered.slice(0, 100).map(entry => entry.unavailable
      ? h('view', { id: 'shell-app-' + entry.id, 'aria-disabled': 'true', style: {
          padding: theme.layout.serviceButtonPadding, gap: theme.layout.contentGap / 2, opacity: theme.layout.disabledOpacity, flexShrink: 0,
        } }, label(entry.name, isLuna(theme) ? theme.colors.muted : theme.colors.text),
          label(entry.unavailable, theme.colors.muted, 10))
      : h('view', { style: { ...row, gap: 6, flexShrink: 0 } },
        desktopCommand('shell-app-' + entry.id, entry.name, theme, () => launch(entry.id),
          { icon: entry.id === 'org.pollyui.settings' ? 'appearance' : entry.id.includes('files') ? 'folder' : 'apps',
            quiet: true, style: { height: 54, paddingLeft: 16, flexGrow: 1, flexBasis: 0, minWidth: 0 } }),
        desktop ? desktopCommand('shell-app-pin-' + entry.id, desktop.has(entry.id) ? 'Remove shortcut' : 'Add to desktop',
          theme, () => desktop.has(entry.id) ? desktop.remove(entry.id) : desktop.add(entry.id),
          { quiet: true, icon: desktop.has(entry.id) ? '' : 'add' }) : null)),
    !filtered.length ? label('No matching applications', theme.colors.muted) : null),
  filtered.length > 100 ? label('Showing 100 matches; refine the search.', theme.colors.muted, 10) : null,
  h('view', { style: { ...row, flexShrink: 0, borderTopWidth: 1, borderColor: theme.colors.border, paddingTop: 12, gap: 10 } },
    desktopText('Your applications', theme.colors.muted, 13), h('view', { style: { flexGrow: 1 } }),
    logout ? desktopCommand('shell-app-logout', 'Log out...', theme, logout, { quiet: true }) : null),
  error ? h('view', { role: 'alert', style: { padding: theme.layout.controlGap, backgroundColor: theme.colors.selection } },
    label(error, theme.colors.text, 11)) : null);
}

export function windowActionsView(theme, window, action, close, error = '', workspaces = [], move = () => {}) {
  const label = labelFor(theme);
  return h('view', { id: 'shell-window-actions', style: {
    width: '100%', height: '100%', padding: theme.layout.contentPadding, gap: theme.layout.contentGap, overflow: 'scroll',
    backgroundColor: theme.colors.body, borderWidth: theme.layout.borderWidth, borderColor: theme.colors.border,
    borderRadius: theme.window.radius,
  } },
  label(window.title || window.appId || 'Untitled', theme.colors.text, 14),
  button('shell-window-activate', 'Activate', theme, () => action('activateWindow')),
  button('shell-window-minimize', window.minimized ? 'Restore' : 'Minimize', theme,
    () => action(window.minimized ? 'restoreWindow' : 'minimizeWindow')),
  button('shell-window-maximize', window.maximized ? 'Unmaximize' : 'Maximize', theme,
    () => action(window.maximized ? 'unmaximizeWindow' : 'maximizeWindow')),
  button('shell-window-fullscreen', window.fullscreen ? 'Leave fullscreen' : 'Fullscreen', theme,
    () => action(window.fullscreen ? 'unfullscreenWindow' : 'fullscreenWindow')),
  button('shell-window-close', 'Close application window', theme, () => action('closeWindow')),
  workspaces.length > 1 ? label('Move window family to:', theme.colors.muted, 11) : null,
  workspaces.filter(workspace => workspace.id !== window.workspaceId).map(workspace =>
    button('shell-window-workspace-' + workspace.id, workspace.name, theme, () => move(workspace.id))),
  button('shell-window-menu-close', 'Close menu', theme, close),
  error ? label(error, theme.colors.text, 11) : null);
}

export function workspacesView(theme, workspaces, activate, remove, create, close, error = '', settings = null) {
  const label = labelFor(theme);
  return h('view', { id: 'shell-workspace-menu', style: {
    width: '100%', height: '100%', padding: theme.layout.compactPadding, gap: theme.layout.contentGap,
    backgroundColor: theme.colors.body, borderWidth: theme.layout.borderWidth, borderColor: theme.colors.border,
    borderRadius: theme.window.radius,
  } },
  h('view', { style: { ...row, gap: theme.layout.contentGap } }, label('Workspaces', theme.colors.text, 16),
    h('view', { style: { flexGrow: 1 } }), button('shell-workspace-add', 'Add', theme, create),
    button('shell-workspace-close', 'Close', theme, close)),
  label('All displays switch together. Empty workspaces stay.', theme.colors.muted, 10),
  h('view', { style: { gap: theme.layout.controlGap, display: settings?.editor ? 'flex' : 'none' } },
    settings?.editor ? [
    h('view', { style: { height: Number(settings.editor.input.root.style.height) },
      onMount: node => node.appendChild(settings.editor.input.root) }),
    h('view', { style: { ...row, gap: theme.layout.controlGap } },
      button('shell-workspace-name-save', 'Save name', theme, settings.save),
      button('shell-workspace-name-cancel', 'Cancel', theme, settings.cancel))] : []),
  h('view', { style: { flexGrow: 1, flexBasis: 0, minHeight: 0, overflow: 'scroll', gap: theme.layout.controlGap } },
    workspaces.map((workspace, index) => h('view', { key: workspace.id,
      style: { gap: theme.layout.controlGap, flexShrink: 0 } },
      h('view', { style: { ...row, gap: theme.layout.controlGap } },
      button('shell-workspace-' + workspace.id, workspace.name, theme, () => activate(workspace.id),
        workspace.active, { flexGrow: 1, flexBasis: 0, minWidth: 0, overflow: 'hidden' }),
      workspace.canRemove ? button('shell-workspace-remove-' + workspace.id, 'Remove', theme,
        () => remove(workspace.id)) : label('Last workspace', theme.colors.muted, 10)),
      settings ? h('view', { style: { ...row, gap: theme.layout.controlGap } },
        button('shell-workspace-rename-' + workspace.id, 'Rename', theme, () => settings.rename(workspace.id),
          false, { height: theme.layout.compactButtonHeight }),
        index ? button('shell-workspace-earlier-' + workspace.id, 'Earlier', theme,
          () => settings.reorder(workspace.id, index - 1), false, { height: theme.layout.compactButtonHeight }) : null,
        index + 1 < workspaces.length ? button('shell-workspace-later-' + workspace.id, 'Later', theme,
          () => settings.reorder(workspace.id, index + 1), false, { height: theme.layout.compactButtonHeight }) : null) : null))),
  label('Removing a workspace moves its windows, not closes them.', theme.colors.muted, 10),
  label('Ctrl+Super+Left/Right switches workspaces.', theme.colors.muted, 10),
  settings && error ? button('shell-workspace-save-current', 'Save current layout', theme, settings.saveCurrent) : null,
  error ? label(error, theme.colors.text, 11) : null);
}

export function switcherView(theme, snapshot, accept, rows = theme.layout.switcherMaxRows) {
  const label = labelFor(theme);
  const start = Math.max(0, Math.min(snapshot.items.length - rows, snapshot.selected - Math.floor(rows / 2)));
  return h('view', { id: 'shell-window-switcher', style: {
    width: '100%', height: '100%', padding: theme.layout.contentPadding, gap: theme.layout.controlGap, backgroundColor: theme.colors.body,
    borderWidth: theme.layout.borderWidth, borderColor: theme.colors.border, borderRadius: theme.window.radius,
  } },
  label('Switch windows  ' + (snapshot.selected + 1) + ' / ' + snapshot.items.length, theme.colors.text, 15),
  snapshot.items.slice(start, start + rows).map((item, offset) =>
    button('shell-switcher-item-' + (start + offset), item.title || item.appId || 'Untitled', theme,
      () => accept(snapshot.serial, start + offset), snapshot.selected === start + offset,
      { height: theme.layout.choiceHeight, alignItems: 'flex-start', overflow: 'hidden' })),
  label('Release shortcut modifiers to activate. Esc cancels.', theme.colors.muted, 10));
}

export function displayConfirmationView(theme, remaining, keep, revert) {
  const label = labelFor(theme);
  return h('view', { id: 'shell-output-confirmation', style: {
    width: '100%', height: '100%', padding: theme.layout.contentPadding, gap: theme.layout.contentPadding, backgroundColor: theme.colors.body,
    borderWidth: theme.layout.borderWidth, borderColor: theme.colors.border, borderRadius: theme.window.radius,
  } },
  label('Keep these display settings?', theme.colors.text, 15),
  label('Reverting in ' + Math.ceil(remaining / 1000) + ' seconds.', theme.colors.muted, 12),
  h('view', { style: { ...row, gap: theme.layout.compactPadding } },
    button('shell-output-keep', 'Keep', theme, keep),
    button('shell-output-revert', 'Revert', theme, revert)),
  label('Enter keeps changes. Escape reverts.', theme.colors.muted, 10));
}
