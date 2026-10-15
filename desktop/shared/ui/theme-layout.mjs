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

export function dockSurfaceWidth(theme, windowCount, availableWidth) {
  const l = theme.layout;
  const count = Math.max(0, Math.floor(windowCount));
  const width = ['tiger', 'lion', 'bigsur'].includes(theme.panel.surfaceStyle) ?
    (l.dockPadding ?? 6) * 2 + 3 * l.dockTileWidth +
      (count ? 13 + count * l.dockWindowWidth : 0) + (2 + count) * l.dockGap :
    l.dockBaseWidth + count * (l.dockWindowWidth + l.windowGap);
  return Math.max(1, Math.min(width, availableWidth - l.screenInset * 2));
}

export function applicationMenuPlacement(theme) {
  const l = theme.layout, mac = theme.panel.kind === 'dock';
  return {
    anchors: [mac ? 'top' : 'bottom', ...(theme.panel.surfaceStyle === 'fluent' ? [] : ['left'])],
    margins: { ...(theme.panel.surfaceStyle === 'fluent' ? {} : { left: l.screenInset }),
      [mac ? 'top' : 'bottom']: mac ? l.menuBarHeight + l.menuTopGap : theme.panel.height + l.menuGap },
  };
}
