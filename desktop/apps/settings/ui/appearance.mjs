import { h } from './gui/sdk/js/reconciler.mjs';
import { button } from './desktop/shared/ui/button.mjs';
import { desktopCommand, desktopText, settingsCard, scrollDesktop } from './desktop/shared/ui/presentation.mjs';
import { themeTextSize } from './desktop/shared/ui/theme-layout.mjs';
const row = { flexDirection: 'row', alignItems: 'center' };
const labelFor = theme => (value, color, size = 12) => h('view', { style: { color, fontSize: themeTextSize(theme, size), flexShrink: 0 } }, value);
import { DESKTOP_THEMES } from './desktop/shared/ui/themes.mjs';
import { wallpaper as previewWallpaper } from './desktop/shared/ui/wallpaper.mjs';
export function settingsView(theme, select, close, retry, error = '', about = false, shortcuts = null, displays = null, network = null, audio = null, themeFiles = null, power = null, embedded = false, status = '', themes = DESKTOP_THEMES) {
  const label = labelFor(theme);
  return h('view', { id: 'shell-settings', style: {
    width: '100%', ...(embedded ? {} : { height: '100%' }), padding: embedded ? 8 : 20, gap: 16, overflow: 'scroll',
    backgroundColor: theme.colors.body, minHeight: 0, flexShrink: 0,
  }, onWheel: scrollDesktop },
  h('view', { style: { ...row, gap: theme.layout.contentGap } },
    embedded ? null : desktopText(about ? 'PollyDesktop' : 'Desktop appearance', theme.colors.text, 24, { fontWeight: 600 }),
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
        desktopText('Choose a look for your desktop', theme.colors.text, 18, { fontWeight: 600 }),
        desktopText('Wallpaper, window frames and desktop colors. Changes apply now.', theme.colors.muted, 14,
          { flexShrink: 1, minWidth: 0 }),
        h('view', { id: 'settings-theme-gallery', style: { ...row, flexWrap: 'wrap', gap: 12, alignItems: 'stretch',
          flexShrink: 0 } }, themes.map(preset => {
          const sample = preset.desktop ? preset : theme, selected = theme.id === preset.id;
          const art = h('view', { style: { height: 104, width: '100%', overflow: 'hidden', position: 'relative',
            borderRadius: 5, pointerEvents: 'none', flexShrink: 0 } },
          previewWallpaper(sample, 'settings-preview-' + preset.id),
          h('view', { style: { position: 'absolute', left: '20%', top: 18, width: '66%', height: 64,
            backgroundColor: sample.colors.surface, borderRadius: sample.window.radius / 2, overflow: 'hidden',
            borderWidth: 1, borderColor: sample.window.border, pointerEvents: 'none' } },
            h('view', { style: { height: 16, backgroundColor: sample.window.titleFrom, pointerEvents: 'none' } }),
            h('view', { style: { ...row, flexGrow: 1, gap: 5, padding: 7, pointerEvents: 'none' } },
              h('view', { style: { width: 20, height: '100%', backgroundColor: sample.colors.body, pointerEvents: 'none' } }),
              h('view', { style: { flexGrow: 1, height: 20, backgroundColor: sample.colors.selection, pointerEvents: 'none' } }))),
          h('view', { style: { position: 'absolute', left: 0, bottom: 0, width: '100%', height: 10,
            backgroundColor: sample.panel.from, pointerEvents: 'none' } }));
          const tile = desktopCommand('shell-theme-' + preset.id, preset.name, theme, () => select(preset.id),
            { selected, style: { flexDirection: 'column', alignItems: 'stretch', height: 166, padding: 10, gap: 8,
              flexGrow: 1, flexBasis: 168, minWidth: 150, maxWidth: 260 } });
          tile.children = [art, desktopText(preset.name, theme.colors.text, 14, { pointerEvents: 'none', fontWeight: 600 }),
            desktopText(selected ? 'Selected' : 'Apply theme', selected ? theme.colors.accent : theme.colors.muted, 12,
              { pointerEvents: 'none' })];
          return tile;
        })),
        desktopText('Theme previews are illustrations, not hardware screenshots. Solid surfaces; no simulated blur.',
          theme.colors.muted, 12, { flexShrink: 1 }),
        themeFiles ? settingsCard(theme, 'Theme library', themeFiles.enabled ? 'User theme files enabled' : 'Packaged themes active', [
          h('view', { style: { ...row, flexWrap: 'wrap', gap: 8 } },
            desktopCommand('shell-theme-reload', 'Reload theme files', theme, themeFiles.reload, { icon: 'refresh' }),
            desktopCommand('shell-theme-restore', 'Use packaged themes', theme, themeFiles.restore)),
        ]) : null,
      ],
  shortcuts ? button('shell-keyboard-settings', 'Keyboard shortcuts', theme, shortcuts) : null,
  displays ? button('shell-display-settings', 'Displays', theme, displays) : null,
  network ? button('shell-network-settings-open', 'Wi-Fi', theme, network) : null,
  audio ? button('shell-audio-settings-open', 'Audio', theme, audio) : null,
  power ? button('shell-power-settings-open', 'Power', theme, power) : null,
  status ? h('view', { role: 'status', 'aria-live': 'polite', style: { padding: 12,
    borderRadius: 6, backgroundColor: theme.colors.selection } }, desktopText(status, theme.colors.text, 14)) : null,
  error ? h('view', { role: 'alert', style: { gap: 10, padding: 14, borderRadius: 6,
    borderWidth: 1, borderColor: '#b42318', backgroundColor: theme.colors.surface, flexShrink: 0 } },
    desktopText(error, theme.colors.text, 14, { flexShrink: 1 }),
    desktopCommand('shell-retry', 'Refresh status', theme, retry, { icon: 'refresh' })) : null,
  desktopText(embedded ? 'Preferences in a memory-only Live session reset after reboot.' : 'Escape closes this menu.',
    theme.colors.muted, 12));
}
