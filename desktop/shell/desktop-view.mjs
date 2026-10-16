import { bodyFont } from './desktop/shared/ui/body-font.mjs';
import { h } from './gui/sdk/js/reconciler.mjs';
import { wallpaper } from './desktop/shell/appearance.mjs';
import { desktopIcon, themedText, desktopCommand, selectionInk } from './desktop/shell/presentation.mjs';
import { DESKTOP_GRID } from './desktop/shell/desktop-shortcuts.mjs';
import { panelViewport } from './desktop/shared/ui/panel-viewport.mjs';

function shortcutLabel(theme, name, selected) {
  const shadow = !selected && theme.icons.desktopLabelStyle === 'shadow';
  return h('view', { style: { maxWidth: DESKTOP_GRID.width - 10, maxHeight: 44, overflow: 'hidden', pointerEvents: 'none',
    padding: 2, borderRadius: 3, backgroundColor: selected ? theme.colors.selection : shadow ? 'transparent' : '#243348',
    color: selected ? selectionInk(theme, theme.colors.text) : '#ffffff', ...bodyFont(theme), fontSize: 12, textAlign: 'center',
    ...(shadow ? { position: 'relative' } : {}) } },
  // The direct text retains native wrapping; the decorative copy uses its same content width.
  shadow ? h('view', { 'aria-hidden': 'true', style: { position: 'absolute', left: 2, right: 2, top: 3,
    color: '#000000', ...bodyFont(theme), fontSize: 12, textAlign: 'center', pointerEvents: 'none' } }, name) : null, name);
}

export function desktopView(theme, asset, state, entries, message = '', images = new Map()) {
  const art = wallpaper(theme, 'shell-wallpaper', asset);
  art.props.style.pointerEvents = 'none';
  const catalog = new Map(entries.map(entry => [entry.id, entry]));
  return h('view', { id: 'shell-desktop', role: 'group', 'aria-label': 'Desktop shortcuts',
    style: { position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', overflow: 'hidden' } },
  art,
  h('view', { id: 'shell-desktop-icons', role: 'listbox', 'aria-label': 'Applications on this desktop',
    'aria-multiselectable': 'true', style: { position: 'absolute', left: 0, top: 0, width: '100%', height: '100%' } },
  state.items.map(item => {
    const entry = catalog.get(item.id), unavailable = !entry || !!entry.unavailable;
    const name = entry?.name || item.name, selected = state.selected.has(item.id);
    const glyph = item.id === 'org.pollyui.settings' ? 'appearance' :
      ['org.pollyui.files', 'polly-files.desktop', 'bundle:org.pollyui.files'].includes(item.id) ? 'folder' : 'apps';
    return h('view', { id: 'shell-desktop-icon-' + item.id, 'data-desktop-shortcut': item.id,
      role: 'option', tabIndex: item.id === state.focused ? 0 : -1,
      'aria-selected': String(selected), 'aria-label': name + (unavailable ? ' (unavailable)' : ''),
      'aria-description': unavailable ? entry?.unavailable || 'Application is no longer in the catalog' :
        'Application shortcut. Double-click or press Enter to open.',
      style: { position: 'absolute', left: item.x, top: item.y, width: DESKTOP_GRID.width, height: DESKTOP_GRID.height,
        alignItems: 'center', justifyContent: 'center', gap: 6, padding: 5, borderWidth: 1, borderRadius: theme.icons.radius,
        borderColor: selected ? theme.colors.accent : 'transparent',
        backgroundColor: selected ? theme.colors.selection : 'transparent' },
      focusStyle: { borderColor: theme.colors.focus },
      hoverStyle: selected ? {} : { borderColor: theme.colors.light },
    }, images.has(item.id) ? h('view', { 'aria-hidden': 'true', style: { width: 36, height: 36, flexShrink: 0,
      backgroundImage: images.get(item.id), pointerEvents: 'none' } }) :
      desktopIcon(glyph, selected ? selectionInk(theme, theme.colors.accent) : '#ffffff', 36),
    shortcutLabel(theme, name, selected),
    unavailable ? themedText(theme, 'Unavailable', selected ? selectionInk(theme, theme.colors.text) : '#ffffff', 10, { pointerEvents: 'none' }) : null);
  })),
  h('view', { id: 'shell-desktop-marquee', 'aria-hidden': 'true', style: {
    position: 'absolute', left: state.rectangle?.x ?? 0, top: state.rectangle?.y ?? 0,
    width: state.rectangle?.width ?? 0, height: state.rectangle?.height ?? 0,
    borderWidth: state.rectangle ? 1 : 0, borderColor: theme.colors.accent,
    backgroundColor: theme.colors.selection, opacity: 0.45, pointerEvents: 'none',
  } }),
  h('view', { id: 'shell-desktop-status', role: message ? 'alert' : 'status', style: {
    position: 'absolute', right: 20, top: 48, maxWidth: 360, padding: message ? 12 : 0,
    borderRadius: 6, backgroundColor: theme.colors.surface, pointerEvents: 'none',
  } }, message ? themedText(theme, message, theme.colors.text, 13, { flexShrink: 1 }) : null));
}

export function desktopMenuView(theme, state, entries, actions, error = '') {
  const catalog = new Map(entries.map(entry => [entry.id, entry]));
  const focused = state.shortcuts.find(item => item.id === state.focused);
  const l = theme.layout;
  return panelViewport(theme, { id: 'shell-desktop-menu', variant: 'menu' },
  themedText(theme, 'Desktop shortcuts', theme.colors.text, l.headingFontSize),
  desktopCommand('shell-desktop-open', 'Open focused shortcut', theme, () => actions.open(state.focused),
    { icon: 'open', enabled: !!focused }),
  desktopCommand('shell-desktop-remove', 'Remove selected shortcuts', theme, actions.remove,
    { enabled: state.selected.size > 0 }),
  desktopCommand('shell-desktop-sort', 'Sort by name and align to grid', theme, actions.sort, { icon: 'apps' }),
  desktopCommand('shell-desktop-add', 'Add from Applications', theme, actions.applications, { icon: 'add' }),
  desktopCommand('shell-desktop-settings', 'System Settings', theme, actions.settings, { icon: 'appearance' }),
  desktopCommand('shell-desktop-close', 'Close', theme, actions.close),
  themedText(theme, 'Removing a shortcut does not uninstall or delete an application.', theme.colors.muted, l.statusFontSize),
  state.shortcuts.map(item => h('view', { style: { flexDirection: 'row', alignItems: 'center',
    gap: l.controlGap, flexShrink: 0, minWidth: 0, flexWrap: 'wrap' } },
    themedText(theme, catalog.get(item.id)?.name || item.name, theme.colors.text, l.fontSize,
      { flexGrow: 1, flexShrink: 1, minWidth: 0 }),
    desktopCommand('shell-desktop-remove-' + item.id, 'Remove', theme, () => actions.removeOne(item.id)))),
  error ? themedText(theme, error, theme.colors.text, l.statusFontSize) : null);
}
