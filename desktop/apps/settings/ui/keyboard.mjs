import { h } from './gui/sdk/js/reconciler.mjs';
import { button } from './desktop/shared/ui/button.mjs';
import { desktopCommand, desktopText, settingsCard, scrollDesktop } from './desktop/shared/ui/presentation.mjs';
import { themeTextSize } from './desktop/shared/ui/theme-layout.mjs';
const row = { flexDirection: 'row', alignItems: 'center' };
const labelFor = theme => (value, color, size = 12) => h('view', { style: { color, fontSize: themeTextSize(theme, size), flexShrink: 0 } }, value);
import { shortcutText } from './desktop/shared/shortcuts.mjs';
export function shortcutsView(theme, bindings, recording, record, disable, reset, close, error = '') {
  const label = labelFor(theme);
  return h('view', { id: 'shell-shortcuts', style: {
    width: '100%', height: '100%', minHeight: 0, padding: 8, gap: 16, backgroundColor: theme.colors.body,
  } },
  h('view', { style: { ...row, gap: 8, flexWrap: 'wrap' } }, desktopText('Desktop shortcuts', theme.colors.text, 16, { fontWeight: 600 }),
    h('view', { style: { flexGrow: 1 } }), button('shell-shortcuts-close', 'Close', theme, close)),
  button('shell-shortcuts-reset', 'Reset defaults', theme, reset),
  h('view', { style: { flexGrow: 1, flexBasis: 0, minHeight: 0, overflow: 'scroll', gap: 8 }, onWheel: scrollDesktop },
    bindings.map(binding => h('view', { style: { padding: 14, gap: 8, flexShrink: 0,
      borderWidth: 1, borderRadius: 8, borderColor: theme.colors.border, backgroundColor: theme.colors.surface } },
    desktopText(binding.label, theme.colors.text, 14, { fontWeight: 600 }),
    h('view', { style: { ...row, gap: 8, flexWrap: 'wrap' } },
      h('view', { style: { flexGrow: 1, flexBasis: 0, overflow: 'hidden', color: theme.colors.text, fontSize: theme.layout.mutedFontSize } },
        recording === binding.action ? 'Press a shortcut...' : shortcutText(binding)),
      button('shell-shortcut-' + binding.action, 'Change', theme, () => record(binding.action)),
      button('shell-shortcut-disable-' + binding.action, 'Off', theme, () => disable(binding.action)))))),
  label('Shift reverses switching. Alt+Escape opens logout confirmation.', theme.colors.muted, 10),
  recording ? label('Press Escape to cancel recording.', theme.colors.muted, 10) : null,
  error ? label(error, theme.colors.text, 11) : null);
}
