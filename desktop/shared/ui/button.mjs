import { h } from './gui/sdk/js/reconciler.mjs';
import { themeTextSize } from './desktop/shared/ui/theme-layout.mjs';
import { isLuna, lunaButtonPaint, lunaButtonDetail, lunaVisualEvents } from './desktop/shared/ui/luna-primitives.mjs';
const center = { alignItems: 'center', justifyContent: 'center' };
const gradient = (from, to) => ({ backgroundColor: from, gradientFrom: from, gradientTo: to });
const labelFor = theme => (value, color, size = 12) => h('view', { style: { color, fontSize: themeTextSize(theme, size), flexShrink: 0 } }, value);
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
