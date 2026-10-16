import { h } from './gui/sdk/js/reconciler.mjs';
import { themeTextSize } from './desktop/shared/ui/theme-layout.mjs';
import { isLuna, lunaButtonPaint, lunaButtonDetail, lunaVisualEvents } from './desktop/shared/ui/luna-primitives.mjs';
import { hasSurfacePaint, surfaceStyle, surfacePaint, surfaceDetail, surfaceEvents, defaultActionFlag, defaultActionCue } from './desktop/shared/ui/surface-primitives.mjs';
import { activationEvents } from './desktop/shared/ui/activation.mjs';
import { bodyFont } from './desktop/shared/ui/body-font.mjs';
const center = { alignItems: 'center', justifyContent: 'center' };
const gradient = (from, to) => ({ backgroundColor: from, gradientFrom: from, gradientTo: to });
const labelFor = theme => (value, color, size = 12) => h('view', { style: { color,
  fontSize: themeTextSize(theme, size), ...bodyFont(theme), flexShrink: 0 } }, value);
export function button(id, text, theme, action, selected = false, extra = {}, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Reflect.ownKeys(options).some(key => key !== 'defaultAction'))
    throw new TypeError('Button options accept only defaultAction');
  const defaultAction = defaultActionFlag(options.defaultAction);
  const paintOptions = { selected, defaultAction, inkOnly: !hasSurfacePaint(theme) };
  const luna = isLuna(theme);
  const painted = hasSurfacePaint(theme);
  const label = labelFor(theme)(text, selected && surfaceStyle(theme) === 'classic' ?
    theme.colors.accentText : theme.colors.text);
  label.props.style.pointerEvents = 'none';
  return h('view', {
    id, role: 'button', 'aria-label': text, 'aria-pressed': String(selected), tabIndex: 0,
    ...(defaultAction ? { 'data-default-action': 'true' } : {}),
    style: { ...center, height: theme.layout.buttonHeight,
      paddingLeft: theme.layout.buttonPaddingX, paddingRight: theme.layout.buttonPaddingX, flexShrink: 0,
      borderWidth: theme.layout.borderWidth, borderColor: selected ? theme.colors.accent : theme.colors.border,
      borderRadius: theme.button.radius, ...gradient(theme.button.from, theme.button.to),
      ...(luna ? { ...lunaButtonPaint(theme, { selected }), overflow: 'hidden', position: 'relative' } : {}),
      ...(painted ? { ...surfacePaint(theme, { selected }), position: 'relative', overflow: 'hidden' } : {}),
      ...(defaultAction ? { position: 'relative' } : {}), ...extra },
    hoverStyle: luna || painted ? {} : { borderColor: theme.colors.accent },
    focusStyle: luna || painted ? {} : { borderColor: theme.colors.focus },
    ...(luna ? lunaVisualEvents(theme, paintOptions) : painted || defaultAction ? surfaceEvents(theme, paintOptions) : {}),
    ...activationEvents(action),
  }, luna ? lunaButtonDetail(theme, 'button', false, defaultAction) :
    painted ? surfaceDetail(theme, paintOptions) : defaultActionCue(theme, defaultAction), label);
}
