export const DECORATION_METRICS = [
  ['border_width', 'borderWidth', 0, 8, 1],
  ['title_height', 'titleHeight', 16, 96, 1],
  ['radius', 'radius', 0, 64, 1],
  ['control_size', 'controlSize', 8, 64, 1],
  ['control_gap', 'controlGap', 0, 32, 1],
  ['control_inset', 'controlInset', 0, 32, 1],
  ['control_radius', 'controlRadius', 0, 32, 1],
  ['text_inset', 'textInset', 0, 64, 1],
  ['text_gap', 'textGap', 0, 32, 1],
  ['font_size', 'fontSize', 8, 32, 1],
  ['font_weight', 'fontWeight', 100, 900, 1],
  ['stripe_spacing', 'stripeSpacing', 1, 32, 1],
  ['stripe_width', 'stripeWidth', 1, 16, 1],
  ['glyph_radius', 'glyphRadius', 1, 16, 1000],
  ['glyph_thickness', 'glyphThickness', 0.1, 4, 1000],
  ['close_thickness', 'closeThickness', 0.1, 4, 1000],
  ['hover_opacity', 'hoverOpacity', 0, 1, 1000],
  ['inactive_opacity', 'inactiveOpacity', 0, 1, 1000],
  ['stripe_opacity', 'stripeOpacity', 0, 1, 1000],
];
export const DECORATION_COLORS = ['border', 'titleFrom', 'titleTo', 'titleText', 'inactiveFrom', 'inactiveTo',
  'inactiveText', 'controlFrom', 'controlTo', 'closeFrom', 'closeTo', 'controlText',
  'minimizeFrom', 'minimizeTo', 'maximizeFrom', 'maximizeTo', 'hoverColor', 'stripeColor'];
const groups = ['desktop', 'colors', 'window', 'icons', 'button', 'panel', 'layout'];
const colors = {
  desktop: ['from', 'to'],
  colors: ['text', 'muted', 'surface', 'body', 'border', 'accent', 'accentText', 'selection', 'light', 'dark', 'focus'],
  window: DECORATION_COLORS,
  icons: [],
  button: ['from', 'to'],
  panel: ['from', 'to', 'text', 'launcherFrom', 'launcherTo', 'launcherText'],
  layout: [],
};
const numbers = {
  desktop: {}, colors: {},
  window: Object.fromEntries([...DECORATION_METRICS.map(([, name, minimum, maximum, scale]) =>
    [name, [minimum, maximum, scale]]), ['shadow', [0, 64]]]),
  icons: { size: [8, 96], radius: [0, 48] },
  button: { radius: [0, 48] },
  panel: { height: [20, 128], radius: [0, 64], inset: [0, 64] },
  layout: {
    fontSize: [8, 24], smallFontSize: [8, 20], mutedFontSize: [8, 20], statusFontSize: [8, 24],
    sectionFontSize: [8, 28], compactHeadingFontSize: [10, 32], headingFontSize: [12, 32], largeHeadingFontSize: [12, 36],
    buttonHeight: [20, 64], compactButtonHeight: [16, 48], buttonPaddingX: [0, 32],
    borderWidth: [0, 4], disabledOpacity: [0, 1, 1000], workspaceTitleLimit: [4, 64],
    panelGap: [0, 32], panelPaddingLeft: [0, 48], panelPaddingRight: [0, 48], panelItemInset: [0, 32],
    menuBarHeight: [20, 64], dockBaseWidth: [96, 1024], dockGap: [0, 32], dockTileWidth: [40, 192],
    windowButtonWidth: [48, 320], dockWindowWidth: [24, 160], windowGap: [0, 32],
    windowTitleLimit: [4, 64], dockTitleLimit: [1, 32], workspaceWidth: [64, 320],
    screenInset: [0, 64], menuWidth: [240, 800], menuHeight: [240, 960], menuGap: [0, 32],
    menuTopGap: [0, 32], contentPadding: [0, 32], contentGap: [0, 32], compactPadding: [0, 32],
    controlGap: [0, 32], serviceButtonPadding: [0, 24], notificationButtonPadding: [0, 24], choiceHeight: [24, 80],
    overlayInset: [0, 64], overlayVerticalInset: [0, 96], overlayTopMargin: [0, 96], overlayRightMargin: [0, 64],
    networkWidth: [320, 800], networkHeight: [320, 960], audioWidth: [320, 800], audioHeight: [320, 960],
    switcherWidth: [320, 1200], switcherHeight: [160, 800], switcherInset: [0, 64],
    switcherRowHeight: [24, 80], switcherChromeHeight: [40, 160], switcherMaxRows: [1, 12],
    notificationWidth: [240, 640], notificationCenterHeight: [240, 960], notificationTopMargin: [0, 96],
    notificationVerticalInset: [0, 96], notificationVisibleCount: [1, 5],
    noticeHeaderHeight: [20, 64], noticeTitleHeight: [24, 128], noticeBodyHeight: [32, 240],
    noticeActionHeight: [24, 80], noticeCardPadding: [0, 32], noticeCardGap: [0, 32],
    noticeStackGap: [0, 32], noticeFooterHeight: [24, 80],
    trayWidth: [64, 480], trayGap: [0, 24], trayIconWidth: [16, 64], trayTextWidth: [32, 160],
    trayItemHeight: [16, 48], trayIconSize: [8, 48], trayPadding: [0, 12],
    trayMenuWidth: [160, 640], trayMenuHeight: [200, 800], trayMenuRowHeight: [24, 64],
  },
};
const options = {
  desktop: {},
  colors: {},
  window: { controls: ['left', 'right'], controlShape: ['square', 'round'],
    texture: ['none', 'pinstripe'], unifiedToolbar: [true, false],
    gradientDir: ['vertical', 'horizontal'], fontFamily: ['sans-serif', 'serif', 'monospace'],
    glyphsOnHoverOnly: [true, false], textAlign: ['left', 'center', 'right'] },
  icons: { dockTiles: [true, false] },
  button: { gloss: [true, false] },
  panel: { kind: ['taskbar', 'dock'] },
  layout: {},
};
const optionalOptions = {
  window: { surfaceStyle: ['generic', 'luna'] },
  button: { surfaceStyle: ['generic', 'luna'] },
  panel: { surfaceStyle: ['generic', 'luna'] },
};

function object(value, context) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw new TypeError(context + ' must be an object');
}
function keys(value, allowed, context, complete = true, optional = []) {
  object(value, context);
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) throw new TypeError(context + ': unsupported field ' + key);
  if (complete) for (const key of allowed.filter(key => !optional.includes(key)))
    if (!Object.hasOwn(value, key)) throw new TypeError(context + ': missing field ' + key);
}
function text(value, maximum, context) {
  if (typeof value !== 'string' || !value.length || value.length > maximum || /[\x00-\x1f\x7f]/.test(value))
    throw new TypeError(context + ' is not valid bounded text');
}
export function freezeTheme(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeTheme(child);
    Object.freeze(value);
  }
  return value;
}

function wallpaperLayers(layers) {
  if (!Array.isArray(layers) || layers.length > 128) throw new RangeError('Wallpaper supports at most 128 primitive layers');
  for (const layer of layers) {
    keys(layer, ['left', 'top', 'width', 'height', 'radius', 'rotation', 'opacity', 'borderWidth', 'borderColor', 'from', 'to'],
      'wallpaper layer');
    for (const key of ['left', 'top', 'width', 'height']) {
      const value = layer[key], extent = key === 'width' || key === 'height';
      const percentage = typeof value === 'string' && /^-?\d+(?:\.\d{1,3})?%$/.test(value);
      const number = percentage ? Number(value.slice(0, -1)) : value;
      if (!Number.isFinite(number) || (extent ? number <= 0 : number < -(percentage ? 200 : 8192)) ||
          number > (percentage ? 200 : 8192)) throw new RangeError('Invalid wallpaper geometry: ' + key);
    }
    for (const [key, minimum, maximum] of [['radius', 0, 4096], ['rotation', -180, 180],
      ['opacity', 0, 1], ['borderWidth', 0, 64]])
      if (!Number.isFinite(layer[key]) || layer[key] < minimum || layer[key] > maximum)
        throw new RangeError('Invalid wallpaper property: ' + key);
    for (const key of ['borderColor', 'from', 'to'])
      if (layer[key] !== 'transparent' && (typeof layer[key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(layer[key])))
        throw new TypeError('Invalid wallpaper color: ' + key);
  }
}

export function validateTheme(value) {
  keys(value, ['id', 'name', 'era', ...groups], 'theme');
  if (typeof value.id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(value.id))
    throw new TypeError('Invalid theme ID');
  text(value.name, 80, 'Theme name');
  text(value.era, 240, 'Theme description');
  for (const group of groups) {
    const prefix = value.id + '.' + group;
    const optional = Object.keys(optionalOptions[group] || {});
    keys(value[group], [...colors[group], ...Object.keys(numbers[group]), ...Object.keys(options[group]),
      ...optional, ...(group === 'desktop' ? ['asset', 'layers'] : [])], prefix, true, optional);
    for (const key of colors[group])
      if (typeof value[group][key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(value[group][key]))
        throw new TypeError(prefix + '.' + key + ' must be an RGB color');
    for (const [key, [minimum, maximum, scale = 1]] of Object.entries(numbers[group])) {
      const number = value[group][key];
      if (!Number.isFinite(number) || number < minimum || number > maximum ||
        Number(number.toFixed(scale === 1 ? 0 : 3)) !== number)
        throw new RangeError(prefix + '.' + key + ' is outside ' + minimum + '-' + maximum);
    }
    wallpaperLayers(value.desktop.layers);
    if (value.layout.compactButtonHeight > value.layout.menuBarHeight ||
      value.layout.fontSize > value.layout.compactButtonHeight ||
      value.layout.fontSize > value.layout.buttonHeight ||
      value.panel.height <= value.layout.panelItemInset ||
      (value.panel.kind === 'taskbar' && value.layout.buttonHeight > value.panel.height))
      throw new RangeError('Shell controls do not fit the configured panel geometry');
    const window = value.window;
    if ((window.surfaceStyle === 'luna' && window.controlSize + 4 > window.titleHeight) ||
      window.controlSize + window.borderWidth * 2 > window.titleHeight ||
      window.fontSize + window.borderWidth * 2 > window.titleHeight ||
      window.stripeWidth > window.stripeSpacing ||
      window.glyphRadius + Math.max(window.glyphThickness, window.closeThickness) > window.controlSize / 2)
      throw new RangeError('Decoration controls, text or strokes do not fit their geometry');
    for (const [key, allowed] of Object.entries(options[group]))
      if (!allowed.includes(value[group][key])) throw new TypeError(prefix + '.' + key + ' is unsupported');
    for (const [key, allowed] of Object.entries(optionalOptions[group] || {}))
      if (Object.hasOwn(value[group], key) && !allowed.includes(value[group][key]))
        throw new TypeError(prefix + '.' + key + ' is unsupported');
  }
  const asset = value.desktop.asset;
  if (typeof asset !== 'string' || asset.length > 192 || (asset &&
    (!/^(?:[a-z0-9_-][a-z0-9_.-]*\/)*[a-z0-9_-][a-z0-9_.-]*\.(?:png|jpe?g)$/i.test(asset) ||
      asset.split('/').length > 8)))
    throw new TypeError('Wallpaper asset must be a bounded relative PNG/JPEG path');
  return freezeTheme(value);
}
function parse(text) {
  if (typeof text !== 'string' || text.length > 128 * 1024) throw new RangeError('Theme document exceeds 128 KiB');
  const value = JSON.parse(text);
  object(value, 'Theme document');
  if (value.schemaVersion !== 1) throw new TypeError('Unsupported theme schema version');
  return value;
}
export function parseThemeCatalog(text) {
  const value = parse(text);
  keys(value, ['schemaVersion', 'default', 'themes'], 'catalog');
  if (!Array.isArray(value.themes) || !value.themes.length || value.themes.length > 64)
    throw new RangeError('Theme catalog must contain 1-64 themes');
  const ids = new Set();
  for (const theme of value.themes) {
    validateTheme(theme);
    if (ids.has(theme.id)) throw new TypeError('Duplicate theme ID: ' + theme.id);
    ids.add(theme.id);
  }
  if (!ids.has(value.default)) throw new TypeError('Catalog default does not exist');
  return freezeTheme(value);
}
export function parseThemeFile(text) {
  const value = parse(text);
  keys(value, ['schemaVersion', 'theme'], 'theme file');
  return validateTheme(value.theme);
}
export function applyThemeOverrides(catalog, text) {
  const value = parse(text);
  keys(value, ['schemaVersion', 'themes'], 'overrides');
  keys(value.themes, catalog.themes.map(theme => theme.id), 'overrides.themes', false);
  const themes = catalog.themes.map(theme => {
    if (!Object.hasOwn(value.themes, theme.id)) return theme;
    const override = value.themes[theme.id];
    keys(override, groups, 'Override ' + theme.id, false);
    const result = { ...theme };
    for (const group of groups) {
      if (!Object.hasOwn(override, group)) continue;
      keys(override[group], [...Object.keys(theme[group]), ...Object.keys(optionalOptions[group] || {})],
        theme.id + '.' + group, false);
      result[group] = { ...theme[group], ...override[group] };
    }
    return validateTheme(result);
  });
  return freezeTheme({ schemaVersion: 1, default: catalog.default, themes });
}
