import { h } from './gui/sdk/js/reconciler.mjs';
import { DESKTOP_THEMES } from './desktop/shell/themes.mjs';
import { shortcutText } from './desktop/shell/shortcuts.mjs';
import { displayField, setDisplayField } from './desktop/shell/displays.mjs';
import { trayView } from './desktop/shell/tray.mjs';
import { themeTextSize } from './desktop/shell/theme-layout.mjs';
import { isLuna, lunaBands, lunaButtonPaint, lunaButtonDetail, lunaVisualEvents, lunaSymbol } from './desktop/shell/luna-primitives.mjs';
export { wallpaper } from './desktop/shell/appearance.mjs';

const row = { flexDirection: 'row', alignItems: 'center' };
const center = { alignItems: 'center', justifyContent: 'center' };
const gradient = (from, to) => ({ backgroundColor: from, gradientFrom: from, gradientTo: to });
const labelFor = theme => (value, color, size = 12) =>
  h('view', { style: { color, fontSize: themeTextSize(theme, size), flexShrink: 0 } }, value);

export function button(id, text, theme, action, selected = false, extra = {}) {
  const activate = event => { event.stopPropagation(); action(); };
  const luna = isLuna(theme);
  const label = labelFor(theme)(text, theme.colors.text);
  if (luna) label.props.style.pointerEvents = 'none';
  return h('view', {
    id, role: 'button', 'aria-label': text, 'aria-pressed': String(selected), tabIndex: 0,
    style: { ...center, height: theme.layout.buttonHeight,
      paddingLeft: theme.layout.buttonPaddingX, paddingRight: theme.layout.buttonPaddingX, flexShrink: 0,
      borderWidth: theme.layout.borderWidth, borderColor: selected ? theme.colors.accent : theme.colors.border,
      borderRadius: theme.button.radius, ...gradient(theme.button.from, theme.button.to),
      ...(luna ? { ...lunaButtonPaint(theme, { selected }), overflow: 'hidden', position: 'relative' } : {}), ...extra },
    hoverStyle: luna ? {} : { borderColor: theme.colors.accent },
    focusStyle: luna ? {} : { borderColor: theme.colors.focus },
    ...(luna ? lunaVisualEvents(theme, { selected }) : {}),
    onClick: activate,
    onKeydown: event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(event); }
    },
  }, luna ? lunaButtonDetail(theme) : null, label);
}

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
        tray?.items.length ? trayView(theme, tray.items, tray.activate, tray.scroll) : null,
        notifications ? tool('shell-notifications', 'Notifications ' + notifications.count, 'notification', notifications.open) : null,
        h('view', { id: 'shell-clock', style: { color: panel.text, fontSize: theme.layout.fontSize,
          paddingLeft: 5, flexShrink: 0 } }, clock)));
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
  tray?.items.length ? trayView(theme, tray.items, tray.activate, tray.scroll) : null,
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

export function settingsView(theme, select, close, retry, error = '', about = false, shortcuts = null, displays = null, network = null, audio = null, themeFiles = null, power = null, embedded = false, status = '') {
  const label = labelFor(theme);
  return h('view', { id: 'shell-settings', style: {
    width: '100%', height: '100%', padding: theme.layout.contentPadding, gap: theme.layout.contentGap, overflow: 'scroll',
    backgroundColor: theme.colors.body, borderWidth: theme.layout.borderWidth, borderColor: theme.colors.border,
    borderRadius: theme.window.radius,
  } },
  h('view', { style: { ...row, gap: theme.layout.contentGap } },
    label(about ? 'PollyDesktop' : 'Desktop appearance', theme.colors.text, 16),
    h('view', { style: { flexGrow: 1 } }),
    embedded ? null : button('shell-settings-close', 'Close', theme, close)),
  about
    ? [
        label('Independent Wayland desktop', theme.colors.text, 13),
        label('PollyWM + native PollyUI surfaces', theme.colors.muted, 11),
        label('Alt+Tab switches windows. Alt+F4 closes one.', theme.colors.muted, 11),
        label('Alt+F9 minimizes. Alt+F10 maximizes.', theme.colors.muted, 11),
        label('Alt+F11 toggles fullscreen.', theme.colors.muted, 11),
        label('Alt+Escape opens logout confirmation.', theme.colors.muted, 11),
        label('Window buttons reflect live compositor state.', theme.colors.muted, 10),
        label('Login and locking depend on deployed session policy.', theme.colors.muted, 10),
      ]
    : [
        label('Changes apply now and save in your user preferences.', theme.colors.muted, 11),
        ...DESKTOP_THEMES.map(preset => button('shell-theme-' + preset.id, preset.name, theme,
          () => select(preset.id), theme.id === preset.id, { height: theme.layout.choiceHeight })),
        label('Negotiated window frames follow this appearance.', theme.colors.muted, 11),
        label('Application-drawn headers keep their own style.', theme.colors.muted, 11),
        themeFiles ? label(themeFiles.enabled ? 'User theme files enabled' : 'Using packaged themes', theme.colors.muted, 11) : null,
        themeFiles ? button('shell-theme-reload', 'Reload and apply theme files', theme, themeFiles.reload) : null,
        themeFiles ? button('shell-theme-restore', 'Use packaged themes', theme, themeFiles.restore) : null,
      ],
  shortcuts ? button('shell-keyboard-settings', 'Keyboard shortcuts', theme, shortcuts) : null,
  displays ? button('shell-display-settings', 'Displays', theme, displays) : null,
  network ? button('shell-network-settings-open', 'Wi-Fi', theme, network) : null,
  audio ? button('shell-audio-settings-open', 'Audio', theme, audio) : null,
  power ? button('shell-power-settings-open', 'Power', theme, power) : null,
  status ? h('view', { role: 'status', 'aria-live': 'polite' }, label(status, theme.colors.text, 11)) : null,
  error ? h('view', { role: 'alert', style: { gap: theme.layout.controlGap, padding: theme.layout.serviceButtonPadding, backgroundColor: theme.colors.selection } },
    label(error, theme.colors.text, 11),
    button('shell-retry', 'Retry', theme, retry)) : null,
  label(embedded ? 'Live sessions keep preferences only until reboot.' : 'Escape closes this menu.', theme.colors.muted, 10));
}

export function applicationsView(theme, entries, query, changeQuery, launch, refresh, close, error = '', logout = null) {
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
  logout ? button('shell-app-logout', 'Log out...', theme, logout) : null,
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
      : button('shell-app-' + entry.id, entry.name, theme, () => launch(entry.id), false,
          { height: theme.layout.choiceHeight, alignItems: 'flex-start' })),
    !filtered.length ? label('No matching applications', theme.colors.muted) : null),
  filtered.length > 100 ? label('Showing 100 matches; refine the search.', theme.colors.muted, 10) : null,
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

export function shortcutsView(theme, bindings, recording, record, disable, reset, close, error = '') {
  const label = labelFor(theme);
  return h('view', { id: 'shell-shortcuts', style: {
    width: '100%', height: '100%', padding: theme.layout.compactPadding, gap: theme.layout.contentGap, backgroundColor: theme.colors.body,
    borderWidth: theme.layout.borderWidth, borderColor: theme.colors.border, borderRadius: theme.window.radius,
  } },
  h('view', { style: { ...row, gap: theme.layout.controlGap } }, label('Keyboard shortcuts', theme.colors.text, 15),
    h('view', { style: { flexGrow: 1 } }), button('shell-shortcuts-close', 'Close', theme, close)),
  button('shell-shortcuts-reset', 'Reset defaults', theme, reset),
  h('view', { style: { flexGrow: 1, flexBasis: 0, minHeight: 0, overflow: 'scroll', gap: theme.layout.contentGap } },
    bindings.map(binding => h('view', { style: { padding: theme.layout.controlGap, gap: theme.layout.contentGap / 2, flexShrink: 0,
      borderWidth: theme.layout.borderWidth, borderColor: theme.colors.border } },
    label(binding.label, theme.colors.text, 12),
    h('view', { style: { ...row, gap: theme.layout.controlGap } },
      h('view', { style: { flexGrow: 1, flexBasis: 0, overflow: 'hidden', color: theme.colors.text, fontSize: theme.layout.mutedFontSize } },
        recording === binding.action ? 'Press a shortcut...' : shortcutText(binding)),
      button('shell-shortcut-' + binding.action, 'Change', theme, () => record(binding.action)),
      button('shell-shortcut-disable-' + binding.action, 'Off', theme, () => disable(binding.action)))))),
  label('Shift reverses switching. Alt+Escape opens logout confirmation.', theme.colors.muted, 10),
  recording ? label('Press Escape to cancel recording.', theme.colors.muted, 10) : null,
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

export function displaysView(theme, owner, draft, inputs, repaint, apply, close, error = '', profile = null) {
  const label = labelFor(theme);
  const field = (head, name, width) => displayField(owner, inputs, head, name, theme, width);
  return h('view', { id: 'shell-displays', style: {
    width: '100%', height: '100%', padding: theme.layout.compactPadding, gap: theme.layout.contentGap, backgroundColor: theme.colors.body,
    borderWidth: theme.layout.borderWidth, borderColor: theme.colors.border, borderRadius: theme.window.radius,
  } },
  h('view', { style: { ...row, gap: theme.layout.controlGap } }, label('Displays', theme.colors.text, 16),
    h('view', { style: { flexGrow: 1 } }), button('shell-output-apply', 'Apply', theme, apply),
    button('shell-output-close', 'Close', theme, close)),
  h('view', { style: { flexGrow: 1, flexBasis: 0, minHeight: 0, overflow: 'scroll', gap: theme.layout.compactPadding } },
    draft.heads.map(head => h('view', { style: { padding: (theme.layout.controlGap + theme.layout.contentGap) / 2, gap: (theme.layout.controlGap + theme.layout.contentGap) / 2, flexShrink: 0,
      borderWidth: theme.layout.borderWidth, borderColor: theme.colors.border } },
    h('view', { style: { ...row, gap: theme.layout.controlGap } }, label(head.name, theme.colors.text, 12),
      h('view', { style: { flexGrow: 1 } }),
      button('shell-output-' + head.id + '-enabled', head.enabled ? 'On' : 'Off', theme,
        () => { head.enabled = !head.enabled; repaint(); }, head.enabled)),
    head.enabled ? [
      h('view', { style: { ...row, gap: theme.layout.windowGap } }, field(head, 'width'), label('x', theme.colors.text),
        field(head, 'height'),
        head.modes.length ? button('shell-output-' + head.id + '-mode', 'Mode', theme, () => {
          const width = Number(inputs.get('shell-output-' + head.id + '-width')?.value);
          const height = Number(inputs.get('shell-output-' + head.id + '-height')?.value);
          const found = head.modes.findIndex(mode => mode.width === width && mode.height === height);
          const mode = head.modes[(found + 1) % head.modes.length];
          for (const name of ['width', 'height', 'refresh']) setDisplayField(inputs, head, name, mode[name]);
        }) : null),
      h('view', { style: { ...row, gap: theme.layout.windowGap } }, label('Scale', theme.colors.text, 11), field(head, 'scale', 62),
        button('shell-output-' + head.id + '-scale-up', '+', theme, () => {
          const value = Number(inputs.get('shell-output-' + head.id + '-scale')?.value);
          setDisplayField(inputs, head, 'scale', Math.min(4, (Number.isFinite(value) ? value : head.scale) + 0.25));
        }),
        button('shell-output-' + head.id + '-rotate', String((head.transform & 3) * 90) + ' deg', theme,
          () => { head.transform = (head.transform & 4) | ((head.transform + 1) & 3); repaint(); })),
      h('view', { style: { ...row, gap: theme.layout.windowGap } }, label('X', theme.colors.text, 11), field(head, 'x'),
        label('Y', theme.colors.text, 11), field(head, 'y')),
      h('view', { style: { ...row, gap: theme.layout.windowGap } }, label('Refresh Hz', theme.colors.text, 11), field(head, 'refresh'),
        label('0 = auto', theme.colors.muted, 10)),
    ] : label('Enable this display to edit its configuration.', theme.colors.muted, 10)))),
  label('Keep changes within 15 seconds or they revert.', theme.colors.muted, 10),
  profile ? label(profile.status, theme.colors.muted, 10) : null,
  profile ? button('shell-output-forget-profile', 'Forget saved layout', theme, profile.forget) : null,
  error ? label(error, theme.colors.text, 11) : null);
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
