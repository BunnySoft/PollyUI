import { parseThemeCatalog } from './desktop/shared/ui/theme-schema.mjs';

export function transparencyMode(value) {
  if (!['theme', 'opaque', 'transparent'].includes(value))
    throw new TypeError('Unknown desktop transparency mode');
  return value;
}

export function windowOpacityPercent(value) {
  if (!Number.isInteger(value) || value < 50 || value > 100)
    throw new RangeError('Window opacity must be an integer from 50 to 100');
  return value;
}

export function transparencyTarget(theme) {
  if (theme.panel.kind === 'dock' && ['tiger', 'lion', 'bigsur'].includes(theme.panel.surfaceStyle))
    return 'Dock and menu bar';
  if (theme.panel.kind === 'taskbar' && theme.panel.surfaceStyle === 'fluent')
    return 'Taskbar';
  return '';
}

export function transparencyCatalog(catalog, mode) {
  transparencyMode(mode);
  if (mode === 'theme') return catalog;
  return parseThemeCatalog(JSON.stringify({ ...catalog, themes: catalog.themes.map(theme => {
    const panel = { ...theme.panel };
    if (mode === 'opaque') {
      panel.materialOpacityPercent = 100;
      panel.menuBarOpacityPercent = 100;
      delete panel.regionalBackdrop;
      delete panel.taskbarBackdrop;
      delete panel.startBackdrop;
    } else if (transparencyTarget(theme) === 'Dock and menu bar') {
      panel.materialOpacityPercent = Math.min(panel.materialOpacityPercent ?? 70, 70);
      panel.menuBarOpacityPercent = Math.min(panel.menuBarOpacityPercent ?? 80, 80);
    } else if (transparencyTarget(theme) === 'Taskbar') {
      panel.taskbarBackdrop = panel.taskbarBackdrop ??
        { sigma: 8, tint: panel.from, opacityPercent: 72 };
    }
    return { ...theme, panel };
  }) }));
}
