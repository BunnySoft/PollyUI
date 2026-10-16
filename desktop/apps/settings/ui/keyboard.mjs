import { bodyFont } from './desktop/shared/ui/body-font.mjs';
import { h } from './gui/sdk/js/reconciler.mjs';
import { button } from './desktop/shared/ui/button.mjs';
import { themedText } from './desktop/shared/ui/presentation.mjs';
import { panelAppearance, panelDetail } from './desktop/shared/ui/panel-appearance.mjs';
import { panelViewport } from './desktop/shared/ui/panel-viewport.mjs';
const row = { flexDirection: 'row', alignItems: 'center' };
const labelFor = theme => (value, color, size = theme.layout.statusFontSize) =>
  h('view', { style: { color, ...bodyFont(theme), fontSize: size, flexShrink: 0 } }, value);
import { shortcutText } from './desktop/shared/shortcuts.mjs';
export function shortcutsView(theme, bindings, recording, record, disable, reset, close, error = '') {
  const label = labelFor(theme);
  const list = panelViewport(theme, { id: 'shell-shortcuts-list', framed: false, scrollbar: true },
    bindings.map(binding => h('view', { style: { ...panelAppearance(theme), flexShrink: 0, minWidth: 0 } },
    panelDetail(theme),
    themedText(theme, binding.label, theme.colors.text, theme.layout.fontSize, { fontWeight: 600 }),
    h('view', { style: { ...row, gap: theme.layout.controlGap, flexWrap: 'wrap' } },
      h('view', { style: { flexGrow: 1, flexBasis: 0, overflow: 'hidden',
        color: theme.colors.text, ...bodyFont(theme), fontSize: theme.layout.statusFontSize } },
        recording === binding.action ? 'Press a shortcut...' : shortcutText(binding)),
      button('shell-shortcut-' + binding.action, 'Change', theme, () => record(binding.action)),
      button('shell-shortcut-disable-' + binding.action, 'Off', theme, () => disable(binding.action))))));
  Object.assign(list.props.style, { flexGrow: 1, flexBasis: 0, height: 'auto', padding: 0 });
  list.children[0].children[0].props.style.gap = theme.layout.controlGap;
  return h('view', { id: 'shell-shortcuts', style: {
    width: '100%', height: '100%', minHeight: 0, padding: theme.layout.compactPadding,
    gap: theme.layout.contentGap, backgroundColor: theme.colors.body,
  } },
  h('view', { style: { ...row, gap: theme.layout.controlGap, flexWrap: 'wrap' } },
    themedText(theme, 'Desktop shortcuts', theme.colors.text, theme.layout.headingFontSize, { fontWeight: 600 }),
    h('view', { style: { flexGrow: 1 } }), button('shell-shortcuts-close', 'Close', theme, close)),
  button('shell-shortcuts-reset', 'Reset defaults', theme, reset),
  list,
  label('Shift reverses switching. Alt+Escape opens logout confirmation.', theme.colors.muted),
  recording ? label('Press Escape to cancel recording.', theme.colors.muted) : null,
  error ? label(error, theme.colors.text, theme.layout.fontSize) : null);
}
