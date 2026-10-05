import { h } from './js/reconciler.mjs';
import { DESKTOP_THEMES } from './desktop/shell/themes.mjs';
import { shortcutText } from './desktop/shell/shortcuts.mjs';
import { displayField, setDisplayField } from './desktop/shell/displays.mjs';
import { trayView } from './desktop/shell/tray.mjs';
export { wallpaper } from './desktop/shell/appearance.mjs';

const row = { flexDirection: 'row', alignItems: 'center' };
const center = { alignItems: 'center', justifyContent: 'center' };
const gradient = (from, to) => ({ backgroundColor: from, gradientFrom: from, gradientTo: to });
const label = (value, color, size = 12) => h('view', { style: { color, fontSize: size, flexShrink: 0 } }, value);

function button(id, text, theme, action, selected = false, extra = {}) {
  const activate = event => { event.stopPropagation(); action(); };
  return h('view', {
    id, role: 'button', 'aria-label': text, 'aria-pressed': String(selected), tabIndex: 0,
    style: { ...center, height: 28, paddingLeft: 10, paddingRight: 10, flexShrink: 0,
      borderWidth: 1, borderColor: selected ? theme.colors.accent : theme.colors.border,
      borderRadius: theme.button.radius, ...gradient(theme.button.from, theme.button.to), ...extra },
    hoverStyle: { borderColor: theme.colors.accent },
    focusStyle: { borderColor: '#ffb62b' },
    onClick: activate,
    onKeydown: event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(event); }
    },
  }, label(text, theme.colors.text));
}

function windowButtons(theme, windows, toggle, actions, compact = false) {
  return h('view', { id: 'shell-window-list', style: {
    ...row, flexGrow: 1, flexBasis: 0, minWidth: 0, gap: 5, overflow: 'scroll',
  }, onWheel: event => {
    event.preventDefault();
    const node = event.currentTarget;
    const extent = node.childNodes.reduce((maximum, child) =>
      Math.max(maximum, child.offsetLeft + child.offsetWidth - node.offsetLeft), 0);
    node.scrollLeft = Math.max(0, Math.min(extent - node.offsetWidth,
      Number(node.scrollLeft) + (event.deltaX || event.deltaY)));
  } }, windows.map(window => {
    const title = window.title || window.appId || 'Untitled';
    const short = Array.from(title).slice(0, compact ? 5 : 20).join('');
    const node = button('shell-window-' + window.id,
      (window.minimized ? '[min] ' : '') + short, theme, () => toggle(window.id), window.active,
      { width: compact ? 64 : 150, height: compact ? theme.panel.height - 12 : 28,
        overflow: 'hidden', ...(window.active ? gradient(theme.colors.selection, theme.colors.selection) : {}) });
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
  return h('view', { id: 'shell-panel', style: {
    ...row, width: '100%', height: '100%', gap: 10, paddingLeft: 5, paddingRight: 12,
    ...gradient(panel.from, panel.to), borderWidth: 1, borderColor: theme.colors.light,
  } },
  button('shell-menu', 'Polly', theme, openMenu, false, {
    height: panel.kind === 'dock' ? 24 : 28,
    ...gradient(panel.launcherFrom, panel.launcherTo),
  }),
  button('shell-panel-settings', 'Appearance', theme, openSettings, false, { height: 24 }),
  workspace ? button('shell-workspaces', Array.from(workspace.name).slice(0, 18).join(''),
    theme, workspace.open, false, { height: 24, maxWidth: 160, overflow: 'hidden' }) :
    label('PollyDesktop', panel.text, 12),
  panel.kind === 'taskbar' ? windowButtons(theme, windows, toggle, actions) :
    h('view', { style: { flexGrow: 1 } }),
  error ? label('Desktop needs attention', panel.text, 11) : null,
  tray?.items.length ? trayView(theme, tray.items, tray.activate, tray.scroll) : null,
  notifications ? button('shell-notifications', 'Notifications ' + notifications.count, theme,
    notifications.open, false, { height: 24 }) : null,
  label(clock, panel.text, 12));
}

export function dockView(theme, openSettings, openAbout, openApplications = openSettings,
  windows = [], toggle = () => {}, actions = () => {}) {
  const panel = theme.panel;
  const tile = { height: panel.height - 12, width: theme.icons.dockTiles ? 84 : 90,
    borderRadius: theme.icons.dockTiles ? theme.icons.radius : theme.button.radius };
  return h('view', { id: 'shell-dock', style: {
    ...row, justifyContent: 'center', width: '100%', height: '100%', gap: 8,
    borderWidth: 1, borderColor: theme.colors.light, borderRadius: panel.radius,
    ...gradient(panel.from, panel.to),
  } },
  button('shell-dock-applications', 'Apps', theme, openApplications, false, tile),
  button('shell-dock-settings', 'Appearance', theme, openSettings, false, tile),
  button('shell-dock-about', 'About', theme, openAbout, false, tile),
  windows.length ? windowButtons(theme, windows, toggle, actions, true) : null);
}

export function settingsView(theme, select, close, retry, error = '', about = false, shortcuts = null, displays = null) {
  return h('view', { id: 'shell-settings', style: {
    width: '100%', height: '100%', padding: 12, gap: 8, overflow: 'scroll',
    backgroundColor: theme.colors.body, borderWidth: 1, borderColor: theme.colors.border,
    borderRadius: theme.window.radius,
  } },
  h('view', { style: { ...row, gap: 8 } },
    label(about ? 'PollyDesktop' : 'Desktop appearance', theme.colors.text, 16),
    h('view', { style: { flexGrow: 1 } }),
    button('shell-settings-close', 'Close', theme, close)),
  about
    ? [
        label('Independent Wayland desktop', theme.colors.text, 13),
        label('PollyWM + native PollyUI surfaces', theme.colors.muted, 11),
        label('Alt+Tab switches windows. Alt+F4 closes one.', theme.colors.muted, 11),
        label('Alt+F9 minimizes. Alt+F10 maximizes.', theme.colors.muted, 11),
        label('Alt+F11 toggles fullscreen.', theme.colors.muted, 11),
        label('Alt+Escape ends the development session.', theme.colors.muted, 11),
        label('Window buttons reflect live compositor state.', theme.colors.muted, 10),
        label('No login, secure lock or background blur yet.', theme.colors.muted, 10),
      ]
    : [
        label('Changes apply to the real desktop and persist.', theme.colors.muted, 11),
        ...DESKTOP_THEMES.map(preset => button('shell-theme-' + preset.id, preset.name, theme,
          () => select(preset.id), theme.id === preset.id, { height: 32 })),
        label('Negotiated window frames follow this appearance.', theme.colors.muted, 11),
        label('Application-drawn headers keep their own style.', theme.colors.muted, 11),
      ],
  shortcuts ? button('shell-keyboard-settings', 'Keyboard shortcuts', theme, shortcuts) : null,
  displays ? button('shell-display-settings', 'Displays', theme, displays) : null,
  error ? h('view', { role: 'alert', style: { gap: 6, padding: 8, backgroundColor: theme.colors.selection } },
    label(error, theme.colors.text, 11),
    button('shell-retry', 'Retry display setup', theme, retry)) : null,
  label('Escape closes this menu.', theme.colors.muted, 10));
}

export function applicationsView(theme, entries, query, changeQuery, launch, refresh, close, error = '') {
  const filtered = entries.filter(entry =>
    (entry.name + ' ' + (entry.genericName || '') + ' ' + entry.comment + ' ' +
      entry.keywords.join(' ')).toLowerCase().includes(query.toLowerCase()));
  return h('view', { id: 'shell-applications', style: {
    width: '100%', height: '100%', padding: 10, gap: 8, backgroundColor: theme.colors.body,
    borderWidth: 1, borderColor: theme.colors.border, borderRadius: theme.window.radius,
  } },
  h('view', { style: { ...row, gap: 8 } }, label('Applications', theme.colors.text, 16),
    h('view', { style: { flexGrow: 1 } }), button('shell-app-refresh', 'Refresh', theme, refresh),
    button('shell-app-close', 'Close', theme, close)),
  h('view', { id: 'shell-app-search', role: 'textbox', 'aria-label': 'Search applications', tabIndex: 0,
    style: { padding: 8, height: 34, flexShrink: 0, backgroundColor: theme.colors.surface,
      borderWidth: 1, borderColor: theme.colors.border, borderRadius: theme.button.radius },
    focusStyle: { borderColor: theme.colors.accent },
    onTextinput: event => changeQuery(Array.from(query + event.data).slice(0, 128).join('')),
    onKeydown: event => {
      if (event.key === 'Backspace') { event.preventDefault(); changeQuery(Array.from(query).slice(0, -1).join('')); }
      if (event.key === 'Enter' && filtered[0]) { event.preventDefault(); launch(filtered[0].id); }
    },
  }, label(query || 'Type to search...', query ? theme.colors.text : theme.colors.muted)),
  h('view', { style: { flexGrow: 1, flexBasis: 0, minHeight: 0, overflow: 'scroll', gap: 5 } },
    filtered.slice(0, 100).map(entry => entry.unavailable
      ? h('view', { id: 'shell-app-' + entry.id, 'aria-disabled': 'true', style: {
          padding: 8, gap: 4, opacity: 0.65, flexShrink: 0,
        } }, label(entry.name, theme.colors.text), label(entry.unavailable, theme.colors.muted, 10))
      : button('shell-app-' + entry.id, entry.name, theme, () => launch(entry.id), false,
          { height: 32, alignItems: 'flex-start' })),
    !filtered.length ? label('No matching applications', theme.colors.muted) : null),
  filtered.length > 100 ? label('Showing 100 matches; refine the search.', theme.colors.muted, 10) : null,
  error ? h('view', { role: 'alert', style: { padding: 6, backgroundColor: theme.colors.selection } },
    label(error, theme.colors.text, 11)) : null);
}

export function windowActionsView(theme, window, action, close, error = '', workspaces = [], move = () => {}) {
  return h('view', { id: 'shell-window-actions', style: {
    width: '100%', height: '100%', padding: 12, gap: 8, overflow: 'scroll',
    backgroundColor: theme.colors.body, borderWidth: 1, borderColor: theme.colors.border,
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

export function workspacesView(theme, workspaces, activate, remove, create, close, error = '') {
  return h('view', { id: 'shell-workspace-menu', style: {
    width: '100%', height: '100%', padding: 10, gap: 8,
    backgroundColor: theme.colors.body, borderWidth: 1, borderColor: theme.colors.border,
    borderRadius: theme.window.radius,
  } },
  h('view', { style: { ...row, gap: 8 } }, label('Workspaces', theme.colors.text, 16),
    h('view', { style: { flexGrow: 1 } }), button('shell-workspace-add', 'Add', theme, create),
    button('shell-workspace-close', 'Close', theme, close)),
  label('All displays switch together. Empty workspaces stay.', theme.colors.muted, 10),
  h('view', { style: { flexGrow: 1, flexBasis: 0, minHeight: 0, overflow: 'scroll', gap: 6 } },
    workspaces.map(workspace => h('view', { style: { ...row, gap: 6, flexShrink: 0 } },
      button('shell-workspace-' + workspace.id, workspace.name, theme, () => activate(workspace.id),
        workspace.active, { flexGrow: 1, flexBasis: 0, minWidth: 0, overflow: 'hidden' }),
      workspace.canRemove ? button('shell-workspace-remove-' + workspace.id, 'Remove', theme,
        () => remove(workspace.id)) : label('Last workspace', theme.colors.muted, 10)))),
  label('Removing a workspace moves its windows, not closes them.', theme.colors.muted, 10),
  label('Ctrl+Super+Left/Right switches workspaces.', theme.colors.muted, 10),
  error ? label(error, theme.colors.text, 11) : null);
}

export function shortcutsView(theme, bindings, recording, record, disable, reset, close, error = '') {
  return h('view', { id: 'shell-shortcuts', style: {
    width: '100%', height: '100%', padding: 10, gap: 8, backgroundColor: theme.colors.body,
    borderWidth: 1, borderColor: theme.colors.border, borderRadius: theme.window.radius,
  } },
  h('view', { style: { ...row, gap: 6 } }, label('Keyboard shortcuts', theme.colors.text, 15),
    h('view', { style: { flexGrow: 1 } }), button('shell-shortcuts-close', 'Close', theme, close)),
  button('shell-shortcuts-reset', 'Reset defaults', theme, reset),
  h('view', { style: { flexGrow: 1, flexBasis: 0, minHeight: 0, overflow: 'scroll', gap: 8 } },
    bindings.map(binding => h('view', { style: { padding: 6, gap: 4, flexShrink: 0,
      borderWidth: 1, borderColor: theme.colors.border } },
    label(binding.label, theme.colors.text, 12),
    h('view', { style: { ...row, gap: 6 } },
      h('view', { style: { flexGrow: 1, flexBasis: 0, overflow: 'hidden', color: theme.colors.text, fontSize: 11 } },
        recording === binding.action ? 'Press a shortcut...' : shortcutText(binding)),
      button('shell-shortcut-' + binding.action, 'Change', theme, () => record(binding.action)),
      button('shell-shortcut-disable-' + binding.action, 'Off', theme, () => disable(binding.action)))))),
  label('Shift reverses switching. Alt+Escape exits the session.', theme.colors.muted, 10),
  recording ? label('Press Escape to cancel recording.', theme.colors.muted, 10) : null,
  error ? label(error, theme.colors.text, 11) : null);
}

export function switcherView(theme, snapshot, accept, rows = 7) {
  const start = Math.max(0, Math.min(snapshot.items.length - rows, snapshot.selected - Math.floor(rows / 2)));
  return h('view', { id: 'shell-window-switcher', style: {
    width: '100%', height: '100%', padding: 12, gap: 6, backgroundColor: theme.colors.body,
    borderWidth: 1, borderColor: theme.colors.border, borderRadius: theme.window.radius,
  } },
  label('Switch windows  ' + (snapshot.selected + 1) + ' / ' + snapshot.items.length, theme.colors.text, 15),
  snapshot.items.slice(start, start + rows).map((item, offset) =>
    button('shell-switcher-item-' + (start + offset), item.title || item.appId || 'Untitled', theme,
      () => accept(snapshot.serial, start + offset), snapshot.selected === start + offset,
      { height: 32, alignItems: 'flex-start', overflow: 'hidden' })),
  label('Release shortcut modifiers to activate. Esc cancels.', theme.colors.muted, 10));
}

export function displaysView(theme, owner, draft, inputs, repaint, apply, close, error = '') {
  const field = (head, name, width) => displayField(owner, inputs, head, name, theme, width);
  return h('view', { id: 'shell-displays', style: {
    width: '100%', height: '100%', padding: 10, gap: 8, backgroundColor: theme.colors.body,
    borderWidth: 1, borderColor: theme.colors.border, borderRadius: theme.window.radius,
  } },
  h('view', { style: { ...row, gap: 6 } }, label('Displays', theme.colors.text, 16),
    h('view', { style: { flexGrow: 1 } }), button('shell-output-apply', 'Apply', theme, apply),
    button('shell-output-close', 'Close', theme, close)),
  h('view', { style: { flexGrow: 1, flexBasis: 0, minHeight: 0, overflow: 'scroll', gap: 10 } },
    draft.heads.map(head => h('view', { style: { padding: 7, gap: 7, flexShrink: 0,
      borderWidth: 1, borderColor: theme.colors.border } },
    h('view', { style: { ...row, gap: 6 } }, label(head.name, theme.colors.text, 12),
      h('view', { style: { flexGrow: 1 } }),
      button('shell-output-' + head.id + '-enabled', head.enabled ? 'On' : 'Off', theme,
        () => { head.enabled = !head.enabled; repaint(); }, head.enabled)),
    head.enabled ? [
      h('view', { style: { ...row, gap: 5 } }, field(head, 'width'), label('x', theme.colors.text),
        field(head, 'height'),
        head.modes.length ? button('shell-output-' + head.id + '-mode', 'Mode', theme, () => {
          const width = Number(inputs.get('shell-output-' + head.id + '-width')?.value);
          const height = Number(inputs.get('shell-output-' + head.id + '-height')?.value);
          const found = head.modes.findIndex(mode => mode.width === width && mode.height === height);
          const mode = head.modes[(found + 1) % head.modes.length];
          for (const name of ['width', 'height', 'refresh']) setDisplayField(inputs, head, name, mode[name]);
        }) : null),
      h('view', { style: { ...row, gap: 5 } }, label('Scale', theme.colors.text, 11), field(head, 'scale', 62),
        button('shell-output-' + head.id + '-scale-up', '+', theme, () => {
          const value = Number(inputs.get('shell-output-' + head.id + '-scale')?.value);
          setDisplayField(inputs, head, 'scale', Math.min(4, (Number.isFinite(value) ? value : head.scale) + 0.25));
        }),
        button('shell-output-' + head.id + '-rotate', String((head.transform & 3) * 90) + ' deg', theme,
          () => { head.transform = (head.transform & 4) | ((head.transform + 1) & 3); repaint(); })),
      h('view', { style: { ...row, gap: 5 } }, label('X', theme.colors.text, 11), field(head, 'x'),
        label('Y', theme.colors.text, 11), field(head, 'y')),
      h('view', { style: { ...row, gap: 5 } }, label('Refresh Hz', theme.colors.text, 11), field(head, 'refresh'),
        label('0 = auto', theme.colors.muted, 10)),
    ] : label('Enable this display to edit its configuration.', theme.colors.muted, 10)))),
  label('Keep changes within 15 seconds or they revert.', theme.colors.muted, 10),
  label('Startup display profiles are not saved yet.', theme.colors.muted, 10),
  error ? label(error, theme.colors.text, 11) : null);
}

export function displayConfirmationView(theme, remaining, keep, revert) {
  return h('view', { id: 'shell-output-confirmation', style: {
    width: '100%', height: '100%', padding: 12, gap: 12, backgroundColor: theme.colors.body,
    borderWidth: 1, borderColor: theme.colors.border, borderRadius: theme.window.radius,
  } },
  label('Keep these display settings?', theme.colors.text, 15),
  label('Reverting in ' + Math.ceil(remaining / 1000) + ' seconds.', theme.colors.muted, 12),
  h('view', { style: { ...row, gap: 10 } },
    button('shell-output-keep', 'Keep', theme, keep),
    button('shell-output-revert', 'Revert', theme, revert)),
  label('Enter keeps changes. Escape reverts.', theme.colors.muted, 10));
}
