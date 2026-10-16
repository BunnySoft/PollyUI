import { themeTextSize } from './desktop/shared/ui/theme-layout.mjs';

// Neutral consumers supply their existing explicit defaults without opting into a theme.
export function inputAppearance(theme, role = 12, fallback = null) {
  if (!theme) {
    if (!fallback) throw new TypeError('An input theme or explicit neutral appearance is required');
    return { ...fallback };
  }
  return { color: theme.colors.text, background: theme.colors.surface,
    selectionColor: theme.colors.selection, borderColor: theme.colors.border,
    focusColor: theme.colors.focus, borderRadius: theme.button.radius,
    fontSize: themeTextSize(theme, role) };
}
