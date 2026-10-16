export const DECORATION_LAYOUT_FIELDS = [
  ['border_width', 'borderWidth', 0, 8, 1],
  ['title_height', 'titleHeight', 16, 96, 1],
  ['control_width', 'controlWidth', 8, 96, 1],
  ['control_height', 'controlHeight', 8, 64, 1],
  ['control_top', 'controlTop', 0, 64, 1],
  ['control_inset', 'controlInset', 0, 32, 1],
  ['close_gap', 'closeGap', 0, 32, 1],
  ['control_gap', 'controlGap', 0, 32, 1],
  ['text_inset', 'textInset', 0, 64, 1],
  ['text_gap', 'textGap', 0, 32, 1],
  ['effect_radius', 'nativeRadius', 0, 64, 1],
  ['shadow_sigma', 'nativeShadowSigma', 0, 64, 1],
  ['shadow_rgb', 'nativeShadowRGB', 0, 16777215, 1],
  ['shadow_active', 'nativeShadowOpacity', 0, 100, 1],
  ['shadow_inactive', 'nativeShadowInactiveOpacity', 0, 100, 1],
  ['shadow_x_bias', 'nativeShadowXBias', 0, 128, 1],
  ['shadow_y_bias', 'nativeShadowYBias', 0, 128, 1],
];

export function decorationLayout(theme) {
  const w = theme.window;
  const rounded = ['rounded', 'rounded-shadow'].includes(w.nativeEffects);
  const shadow = w.nativeEffects === 'rounded-shadow';
  return Object.freeze({
    left_controls: w.controls === 'left',
    border_width: w.borderWidth, title_height: w.titleHeight,
    control_width: w.controlWidth ?? w.controlSize, control_height: w.controlSize,
    control_top: w.controlTop ?? Math.floor((w.titleHeight - w.controlSize) / 2) + (w.surfaceStyle === 'luna' ? 2 : 0),
    control_inset: w.controlInset, close_gap: w.controlGap,
    control_gap: w.surfaceStyle === 'classic' ? 0 : w.controlGap,
    text_inset: w.textInset, text_gap: w.textGap,
    effect_radius: rounded ? w.radius : 0,
    shadow_sigma: shadow ? Math.ceil(w.shadow / 2) : 0,
    shadow_rgb: shadow ? Number.parseInt((w.nativeShadowColor ?? '#000000').slice(1), 16) : 0,
    shadow_active: shadow ? w.nativeShadowOpacity ?? 24 : 0,
    shadow_inactive: shadow ? w.nativeShadowInactiveOpacity ?? 12 : 0,
    shadow_x_bias: (w.nativeShadowX ?? 0) + 64,
    shadow_y_bias: (w.nativeShadowY ?? Math.round(w.shadow / 4)) + 64,
  });
}

export function encodeDecorationLayout(theme) {
  const layout = decorationLayout(theme);
  return [6, Number(layout.left_controls), ...DECORATION_LAYOUT_FIELDS.map(([field]) => layout[field])];
}
