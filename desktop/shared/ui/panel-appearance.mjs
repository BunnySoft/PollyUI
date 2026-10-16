import { bevel, surfaceStyle } from './desktop/shared/ui/surface-primitives.mjs';

function checkVariant(theme, variant) {
  if (!theme) throw new TypeError('A panel theme is required; neutral consumers keep their explicit styles');
  if (!['card', 'dialog', 'menu', 'inset'].includes(variant))
    throw new RangeError('Unknown panel variant: ' + variant);
}

// Geometry belongs to the consumer; these passive surfaces never own input or focus.
export function panelAppearance(theme, variant = 'card') {
  checkVariant(theme, variant);
  const classic = surfaceStyle(theme) === 'classic', layout = theme.layout;
  return { position: 'relative',
    backgroundColor: variant === 'dialog' || classic && variant === 'card' ? theme.colors.body : theme.colors.surface,
    borderColor: theme.colors.border, borderWidth: layout.borderWidth,
    borderRadius: variant === 'dialog' ? theme.window.radius : theme.button.radius,
    padding: variant === 'inset' ? 0 : variant === 'menu' ? layout.compactPadding : layout.contentPadding,
    gap: variant === 'inset' ? 0 : variant === 'menu' ? layout.controlGap : layout.contentGap };
}

export function panelDetail(theme, variant = 'card') {
  checkVariant(theme, variant);
  return surfaceStyle(theme) === 'classic' ?
    bevel(theme, { frame: variant === 'dialog', inset: variant === 'card' || variant === 'inset' }) : null;
}
