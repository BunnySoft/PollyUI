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
];

export function decorationLayout(theme) {
  const w = theme.window;
  return Object.freeze({
    left_controls: w.controls === 'left',
    border_width: w.borderWidth, title_height: w.titleHeight,
    control_width: w.controlWidth ?? w.controlSize, control_height: w.controlSize,
    control_top: w.controlTop ?? Math.floor((w.titleHeight - w.controlSize) / 2) + (w.surfaceStyle === 'luna' ? 2 : 0),
    control_inset: w.controlInset, close_gap: w.controlGap,
    control_gap: w.surfaceStyle === 'classic' ? 0 : w.controlGap,
    text_inset: w.textInset, text_gap: w.textGap,
    effect_radius: w.nativeEffects === 'rounded' ? w.radius : 0,
  });
}

export function encodeDecorationLayout(theme) {
  const layout = decorationLayout(theme);
  return [5, Number(layout.left_controls), ...DECORATION_LAYOUT_FIELDS.map(([field]) => layout[field])];
}
