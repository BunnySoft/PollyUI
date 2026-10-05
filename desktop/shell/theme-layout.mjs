const textRoles = Object.freeze({
  10: 'smallFontSize', 11: 'mutedFontSize', 12: 'fontSize', 13: 'statusFontSize',
  14: 'sectionFontSize', 15: 'compactHeadingFontSize', 16: 'headingFontSize', 18: 'largeHeadingFontSize',
});

// Existing view sizes select semantic roles; their rendered sizes come from JSON.
export function themeTextSize(theme, role = 12) {
  const key = textRoles[role];
  if (!key) throw new RangeError('Unknown typography role: ' + role);
  return theme.layout[key];
}
