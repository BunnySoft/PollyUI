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

export function dockSurfaceWidth(theme, taskCount, availableWidth) {
  const l = theme.layout;
  const count = Math.max(0, Math.floor(taskCount));
  const width = ['tiger', 'lion', 'bigsur'].includes(theme.panel.surfaceStyle) ?
    (l.dockPadding ?? 6) * 2 + 3 * l.dockTileWidth +
      (count ? 13 + count * l.dockWindowWidth : 0) + (count ? count + 3 : 2) * l.dockGap :
    l.dockBaseWidth + count * (l.dockWindowWidth + l.windowGap);
  return Math.max(1, Math.min(width, availableWidth - l.screenInset * 2));
}

export function dockBackdropMaterial(theme, width, height) {
  const material = theme.panel.regionalBackdrop;
  if (theme.panel.kind !== 'dock' || !material) return null;
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0)
    throw new RangeError('A current positive Dock footprint is required');
  const radius = Math.min(theme.panel.radius, width / 2, height / 2);
  return [2, 1, Math.round(radius * 1000), material.sigma,
    Number.parseInt(material.tint.slice(1), 16), material.opacityPercent];
}

export function applicationMenuPlacement(theme, availableWidth) {
  const l = theme.layout, mac = theme.panel.kind === 'dock';
  const inset = l.menuLeftInset ?? l.screenInset;
  return {
    ...(Number.isFinite(availableWidth) ? { width: Math.max(1, Math.min(l.menuWidth,
      availableWidth - (theme.panel.surfaceStyle === 'fluent' ? l.screenInset : inset) * 2)) } : {}),
    anchors: [mac ? 'top' : 'bottom', ...(theme.panel.surfaceStyle === 'fluent' ? [] : ['left'])],
    margins: { ...(theme.panel.surfaceStyle === 'fluent' ? {} : { left: inset }),
      [mac ? 'top' : 'bottom']: mac ? l.menuBarHeight + l.menuTopGap :
        theme.panel.height + l.menuGap - (l.menuBottomOverlap ?? 0) },
  };
}

export function applicationMenuHeight(theme, availableHeight) {
  const l = theme.layout;
  return Math.max(1, Math.min(l.menuHeight,
    availableHeight - theme.panel.height + (theme.panel.kind === 'taskbar' ? l.menuBottomOverlap ?? 0 : 0) -
      (l.menuVerticalInset ?? l.overlayInset) * 2));
}
