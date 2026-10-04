import { h } from './js/reconciler.mjs';
import { DESKTOP_THEMES } from './desktop/shell/themes.mjs';
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

export function panelView(theme, clock, openSettings, error = '') {
  const panel = theme.panel;
  return h('view', { id: 'shell-panel', style: {
    ...row, width: '100%', height: '100%', gap: 10, paddingLeft: 5, paddingRight: 12,
    ...gradient(panel.from, panel.to), borderWidth: 1, borderColor: theme.colors.light,
  } },
  button('shell-menu', 'Polly', theme, openSettings, false, {
    height: panel.kind === 'dock' ? 24 : 28,
    ...gradient(panel.launcherFrom, panel.launcherTo),
  }),
  label('PollyDesktop', panel.text, 12),
  h('view', { style: { flexGrow: 1 } }),
  error ? label('Settings need attention', panel.text, 11) : null,
  label(clock, panel.text, 12));
}

export function dockView(theme, openSettings, openAbout) {
  const panel = theme.panel;
  const tile = { height: panel.height - 12, width: theme.icons.dockTiles ? 84 : 90,
    borderRadius: theme.icons.dockTiles ? theme.icons.radius : theme.button.radius };
  return h('view', { id: 'shell-dock', style: {
    ...row, justifyContent: 'center', width: '100%', height: '100%', gap: 8,
    borderWidth: 1, borderColor: theme.colors.light, borderRadius: panel.radius,
    ...gradient(panel.from, panel.to),
  } },
  button('shell-dock-settings', 'Appearance', theme, openSettings, false, tile),
  button('shell-dock-about', 'About', theme, openAbout, false, tile));
}

export function settingsView(theme, select, close, retry, error = '', about = false) {
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
        label('Alt+F10 maximizes. Alt+F11 toggles fullscreen.', theme.colors.muted, 11),
        label('Alt+Escape ends the development session.', theme.colors.muted, 11),
        label('Application launcher and window list: not connected yet.', theme.colors.muted, 10),
        label('No login, secure lock or background blur yet.', theme.colors.muted, 10),
      ]
    : [
        label('Changes apply to the real desktop and persist.', theme.colors.muted, 11),
        ...DESKTOP_THEMES.map(preset => button('shell-theme-' + preset.id, preset.name, theme,
          () => select(preset.id), theme.id === preset.id, { height: 32 })),
        label('Application decorations are not changed.', theme.colors.muted, 11),
      ],
  error ? h('view', { role: 'alert', style: { gap: 6, padding: 8, backgroundColor: theme.colors.selection } },
    label(error, theme.colors.text, 11),
    button('shell-retry', 'Retry display setup', theme, retry)) : null,
  label('Escape closes this menu.', theme.colors.muted, 10));
}
