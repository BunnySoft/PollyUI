import { h } from './gui/sdk/js/reconciler.mjs';
import { themeTextSize } from './desktop/shared/ui/theme-layout.mjs';
import { isLuna, lunaButtonPaint, lunaButtonDetail, lunaVisualEvents } from './desktop/shared/ui/luna-primitives.mjs';
import { hasSurfacePaint, surfaceStyle, surfacePaint, surfaceDetail, surfaceEvents } from './desktop/shared/ui/surface-primitives.mjs';
import { activationEvents } from './desktop/shared/ui/activation.mjs';
const center = { alignItems: 'center', justifyContent: 'center' };
const gradient = (from, to) => ({ backgroundColor: from, gradientFrom: from, gradientTo: to });
const labelFor = theme => (value, color, size = 12) => h('view', { style: { color, fontSize: themeTextSize(theme, size), flexShrink: 0 } }, value);
export function button(id, text, theme, action, selected = false, extra = {}) {
  const luna = isLuna(theme);
  const painted = hasSurfacePaint(theme);
  const label = labelFor(theme)(text, selected && surfaceStyle(theme) === 'classic' ?
    theme.colors.accentText : theme.colors.text);
  label.props.style.pointerEvents = 'none';
  return h('view', {
    id, role: 'button', 'aria-label': text, 'aria-pressed': String(selected), tabIndex: 0,
    style: { ...center, height: theme.layout.buttonHeight,
      paddingLeft: theme.layout.buttonPaddingX, paddingRight: theme.layout.buttonPaddingX, flexShrink: 0,
      borderWidth: theme.layout.borderWidth, borderColor: selected ? theme.colors.accent : theme.colors.border,
      borderRadius: theme.button.radius, ...gradient(theme.button.from, theme.button.to),
      ...(luna ? { ...lunaButtonPaint(theme, { selected }), overflow: 'hidden', position: 'relative' } : {}),
      ...(painted ? { ...surfacePaint(theme, { selected }), position: 'relative', overflow: 'hidden' } : {}), ...extra },
    hoverStyle: luna || painted ? {} : { borderColor: theme.colors.accent },
    focusStyle: luna || painted ? {} : { borderColor: theme.colors.focus },
    ...(luna ? lunaVisualEvents(theme, { selected }) : painted ? surfaceEvents(theme, { selected }) : {}),
    ...activationEvents(action),
  }, luna ? lunaButtonDetail(theme) : painted ? surfaceDetail(theme, { selected }) : null, label);
}
