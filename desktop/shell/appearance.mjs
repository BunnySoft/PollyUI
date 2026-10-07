import { h, render } from './js/reconciler.mjs';
import { DEFAULT_DESKTOP_THEME, DESKTOP_THEMES, getDesktopTheme } from './desktop/shell/themes.mjs';
import { isLuna, lunaBands, lunaButtonPaint, lunaButtonDetail, lunaVisualEvents,
  lunaSymbol, lunaCaptionGlyph } from './desktop/shell/luna-primitives.mjs';

const row = { flexDirection: 'row', alignItems: 'center' };
const center = { alignItems: 'center', justifyContent: 'center' };
const fill = { position: 'absolute', left: 0, top: 0, width: '100%', height: '100%' };
const text = (label, color, size = 12, extra = {}) =>
  h('view', { style: { color, fontSize: size, flexShrink: 0, ...extra } }, label);
const gradient = (from, to) => ({ backgroundColor: from, gradientFrom: from, gradientTo: to });

function button(id, label, style, action, children, selected = false) {
  const activate = e => { e.stopPropagation(); action(); };
  return h('view', {
    id, role: 'button', 'aria-label': label, 'aria-pressed': String(selected), tabIndex: 0,
    style: { ...center, flexShrink: 0, borderWidth: 1, borderColor: '#8b98ac', ...style },
    focusStyle: { borderColor: '#ffbc32' },
    hoverStyle: { borderColor: '#537aa7' },
    onClick: activate,
    onKeydown: e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(e); }
    },
  }, children);
}

function panelSurface(theme) {
  return { ...gradient(theme.button.from, theme.button.to),
    borderColor: theme.colors.border, borderWidth: 1, borderRadius: theme.button.radius };
}

function surfaceDetail(theme) {
  if (theme.button.gloss) return h('view', { style: {
    position: 'absolute', left: 2, right: 2, top: 2, height: '40%',
    borderRadius: theme.button.radius, backgroundColor: '#ffffff', opacity: 0.55,
  } });
  if (theme.button.radius === 0) return [
    h('view', { style: { position: 'absolute', left: 1, top: 1, right: 1, height: 1,
      backgroundColor: theme.colors.light } }),
    h('view', { style: { position: 'absolute', left: 1, top: 1, bottom: 1, width: 1,
      backgroundColor: theme.colors.light } }),
    h('view', { style: { position: 'absolute', left: 1, right: 1, bottom: 1, height: 1,
      backgroundColor: theme.colors.dark } }),
  ];
  return null;
}

function fileIcon(theme, label, size = theme.icons.size, id) {
  return h('view', { id, style: {
    width: size, height: size, borderRadius: theme.icons.radius,
    borderWidth: 1, borderColor: theme.colors.border,
    ...gradient('#ffffff', theme.colors.selection), ...center,
  } }, text(label, theme.colors.accent, Math.round(size / 2), { fontWeight: 'bold' }));
}

export function wallpaper(theme, id = 'appearance-wallpaper', asset = '') {
  const art = asset ? [h('view', { style: { ...fill, backgroundImage: asset } })] :
    theme.desktop.layers.map(layer => h('view', { style: {
      position: 'absolute', left: layer.left, top: layer.top, width: layer.width, height: layer.height,
      borderRadius: layer.radius, rotate: layer.rotation, opacity: layer.opacity,
      borderWidth: layer.borderWidth, borderColor: layer.borderColor, ...gradient(layer.from, layer.to),
    } }));
  return h('view', { id,
    style: { ...fill, ...gradient(theme.desktop.from, theme.desktop.to), overflow: 'hidden' } }, art);
}

function captionButton(theme, command, active, dispatch, interactive) {
  const chrome = theme.window;
  const round = chrome.controlShape === 'round';
  const close = command === 'close';
  let from = close ? theme.window.closeFrom : theme.window.controlFrom;
  let to = close ? theme.window.closeTo : theme.window.controlTo;
  if (command === 'minimize') { from = chrome.minimizeFrom; to = chrome.minimizeTo; }
  if (command === 'maximize') { from = chrome.maximizeFrom; to = chrome.maximizeTo; }
  if (!active) { from = theme.window.inactiveFrom; to = theme.window.inactiveTo; }
  const style = {
    width: chrome.controlSize, height: chrome.controlSize,
    ...gradient(from, to), borderRadius: round ? chrome.controlSize / 2 : chrome.controlRadius,
    borderColor: active ? theme.colors.dark : theme.colors.border,
  };
  const glyph = command === 'close' ? 'x' : command === 'minimize' ? '-' : '+';
  const content = [surfaceDetail(theme),
    text(glyph, chrome.controlText, Math.max(8, chrome.glyphRadius * 3))];
  if (isLuna(theme, 'window')) {
    const sample = { ...theme, button: { ...theme.button, from, to, radius: chrome.controlRadius },
      colors: { ...theme.colors, border: chrome.controlText } };
    const node = interactive ? button('appearance-' + command, command + ' preview window',
      { ...style, ...lunaButtonPaint(sample), position: 'relative', overflow: 'hidden' },
      () => dispatch(command), [lunaButtonDetail(sample), lunaCaptionGlyph(theme, command)]) :
      h('view', { style: { ...style, ...lunaButtonPaint(sample), position: 'relative', borderWidth: 1 } },
        lunaButtonDetail(sample), lunaCaptionGlyph(theme, command));
    if (interactive) {
      node.props.hoverStyle = {};
      node.props.focusStyle = {};
      Object.assign(node.props, lunaVisualEvents(sample));
    }
    return node;
  }
  return interactive
    ? button('appearance-' + command, command + ' preview window', style,
        () => dispatch(command), content)
    : h('view', { style: { ...style, borderWidth: 1, ...center } }, content);
}

function titlebar(theme, active, dispatch, interactive = true) {
  const chrome = theme.window;
  const controls = chrome.controls === 'left'
    ? ['close', 'minimize', 'maximize'] : ['minimize', 'maximize', 'close'];
  const caption = text(active ? 'Appearance sample' : 'Notes - inactive sample',
    active ? chrome.titleText : chrome.inactiveText, chrome.fontSize,
    { fontWeight: chrome.fontWeight, fontFamily: chrome.fontFamily });
  return h('view', { id: active ? 'appearance-titlebar' : 'appearance-inactive-titlebar', style: {
    ...row, height: chrome.titleHeight, flexShrink: 0,
    paddingLeft: isLuna(theme, 'window') ? Math.max(0, chrome.textInset - 16 - chrome.textGap) : chrome.controlInset,
    paddingRight: chrome.controlInset, gap: chrome.textGap,
    ...gradient(active ? chrome.titleFrom : chrome.inactiveFrom,
                active ? chrome.titleTo : chrome.inactiveTo),
    gradientDir: chrome.gradientDir,
  } },
    isLuna(theme, 'window') ? lunaBands(theme, active ? 'title' : 'inactive-title', chrome.titleHeight) : null,
    chrome.texture === 'pinstripe'
      ? Array.from({ length: Math.ceil(chrome.titleHeight / chrome.stripeSpacing) }, (_, i) => h('view', { style: {
          position: 'absolute', left: 0, right: 0, top: i * chrome.stripeSpacing, height: chrome.stripeWidth,
          backgroundColor: chrome.stripeColor, opacity: chrome.stripeOpacity,
        } })) : null,
    isLuna(theme, 'window') && chrome.controls === 'right' ? lunaSymbol('document') : null,
    chrome.controls === 'right' ? caption : null,
    chrome.controls === 'right' ? h('view', { style: { flexGrow: 1 } }) : null,
    h('view', { style: { ...row, gap: chrome.controlGap,
      ...(isLuna(theme, 'window') ? { translateY: 2 } : {}) } },
      controls.map(command => captionButton(theme, command, active, dispatch, interactive))),
    chrome.controls === 'left'
      ? h('view', { style: { flexGrow: 1, justifyContent: 'center',
        alignItems: chrome.textAlign === 'center' ? 'center' : chrome.textAlign === 'right' ? 'flex-end' : 'flex-start',
        paddingRight: chrome.textInset } }, caption) : null);
}

function frameStyle(theme, geometry) {
  return {
    position: 'absolute', ...geometry, flexDirection: 'column', overflow: 'hidden',
    borderRadius: theme.window.radius, borderWidth: isLuna(theme, 'window') ? 0 : theme.window.borderWidth,
    borderColor: theme.window.border, backgroundColor: theme.colors.body,
    shadowColor: '#192638', shadowBlur: theme.window.shadow, shadowY: 5,
  };
}

function content(theme, state, dispatch) {
  const c = theme.colors;
  return h('view', { style: { flexGrow: 1, flexBasis: 0, minHeight: 0, flexDirection: 'column',
    ...(isLuna(theme, 'window') ? { borderLeftWidth: theme.window.borderWidth,
      borderRightWidth: theme.window.borderWidth, borderBottomWidth: theme.window.borderWidth,
      borderColor: theme.window.border } : {}) } },
    h('view', { id: 'appearance-toolbar', style: {
      ...row, height: 32, flexShrink: 0, gap: 8, paddingLeft: 12,
      ...(theme.window.unifiedToolbar
        ? gradient(theme.window.titleTo, theme.window.titleTo)
        : gradient(theme.button.from, theme.colors.body)),
    } }, text('Folder: ' + state.folder, c.text),
      text(' / preview only', c.muted, 11)),
    h('view', { style: { flexGrow: 1, flexBasis: 0, minHeight: 0, flexDirection: 'row' } },
      h('view', { style: { width: 112, flexShrink: 0, padding: 8, gap: 5, backgroundColor: c.body } },
        ['Documents', 'Downloads', 'Pictures'].map(folder =>
          button('appearance-folder-' + folder, 'Show ' + folder,
            { height: 28, alignItems: 'flex-start', paddingLeft: 7,
              borderRadius: theme.button.radius, borderColor: c.body,
              backgroundColor: state.folder === folder ? c.selection : c.body },
            () => dispatch('folder', folder), text(folder, c.text, 11), state.folder === folder))),
      h('view', { id: 'appearance-files', style: { flexGrow: 1, flexBasis: 0, minWidth: 0, padding: 12, gap: 12,
        overflow: 'scroll', backgroundColor: c.surface } },
        h('view', { style: { ...row, gap: 12, flexWrap: 'wrap' } },
          ['Palette', 'Windows', 'Controls'].map((label, index) =>
            h('view', { style: { gap: 6, ...center, width: 64 } },
              fileIcon(theme, String(index + 1)), text(label, c.text, 10)))),
        text('Your desktop, your era.', c.text, 16, { fontWeight: 'bold' }),
        text('Original PollyUI artwork. No system files are opened.', c.muted, 11),
        h('view', { style: { ...row, gap: 8, flexWrap: 'wrap' } },
          button('appearance-action', 'Try sample action',
            { ...panelSurface(theme), paddingLeft: 14, paddingRight: 14, height: 28 },
            () => dispatch('sample'), [surfaceDetail(theme), text('Sample action', c.text, 11)]),
          h('view', { id: 'appearance-accent', style: { width: 52, height: 24,
            borderRadius: theme.button.radius, backgroundColor: c.accent, ...center } },
            text('Accent', c.accentText, 10))),
        h('view', { id: 'appearance-message', role: 'status', style: {
          padding: 8, borderRadius: theme.button.radius, backgroundColor: c.selection,
        } }, text(state.message, c.text, 11)))),
    h('view', { id: 'appearance-status', style: { height: 24, ...row, flexShrink: 0, paddingLeft: 10,
      borderWidth: 1, borderColor: c.border, backgroundColor: c.body } },
      text('Simulated window / native PollyUI rendering', c.muted, 10)));
}

function desktopWindows(theme, state, dispatch) {
  if (!state.open || state.minimized) return null;
  const dock = theme.panel.kind === 'dock';
  const panelTop = theme.panel.height + theme.panel.inset;
  const normal = { left: '13%', top: '17%', width: '74%',
    ...(dock ? { bottom: panelTop + 18 } : { height: '64%' }) };
  const maximized = { left: 6, right: 6, top: theme.panel.kind === 'dock' ? 30 : 6,
    bottom: panelTop + 8 };
  return [
    !state.maximized && h('view', { style: frameStyle(theme,
      { left: '18%', top: '8%', width: '69%', height: '55%' }) },
      titlebar(theme, false, dispatch, false)),
    h('view', { id: 'appearance-window', style: frameStyle(theme,
      state.maximized ? maximized : normal) },
      titlebar(theme, true, dispatch),
      content(theme, state, dispatch)),
  ];
}

function launcher(theme, state, dispatch) {
  const mac = theme.panel.kind === 'dock';
  if (!state.menuOpen) return null;
  return h('view', { id: 'appearance-menu', style: {
    position: 'absolute', left: 6, ...(mac ? { top: 28 } : { bottom: 40 }),
    width: 228, padding: 10, gap: 8, borderWidth: 1, borderColor: theme.colors.border,
    borderRadius: theme.window.radius, backgroundColor: theme.colors.body,
    shadowColor: '#172235', shadowBlur: 14,
  } }, text('Polly / appearance presets', theme.colors.text, 12, { fontWeight: 'bold' }),
    DESKTOP_THEMES.map(preset => button('appearance-menu-' + preset.id, preset.name,
      { height: 30, ...panelSurface(theme),
        backgroundColor: theme.colors.body },
      () => dispatch('theme', preset.id), text(preset.name, theme.colors.text, 11),
      state.themeId === preset.id)),
    text('Preview menu, not a system launcher.', theme.colors.muted, 10));
}

function panels(theme, state, dispatch) {
  const panel = theme.panel, c = theme.colors;
  const tiles = theme.icons.dockTiles;
  if (isLuna(theme, 'panel') && panel.kind === 'taskbar') {
    const launch = button('appearance-launcher', 'Toggle appearance menu',
      { width: 97, height: panel.height, borderWidth: 0, position: 'relative',
        flexDirection: 'row', gap: 5, ...lunaButtonPaint(theme, { variant: 'launcher' }) },
      () => dispatch('menu'), [lunaButtonDetail(theme, 'launcher'), lunaSymbol('polly', panel.launcherText, 22),
        text('Polly', panel.launcherText, 18, { fontWeight: 700, fontStyle: 'italic' })], state.menuOpen);
    launch.props.hoverStyle = {}; launch.props.focusStyle = {};
    Object.assign(launch.props, lunaVisualEvents(theme, { variant: 'launcher' }));
    const task = button('appearance-open', 'Open preview window',
      { width: theme.layout.windowButtonWidth, height: panel.height - theme.layout.panelItemInset,
        position: 'relative', flexDirection: 'row', gap: 5,
        ...lunaButtonPaint(theme, { variant: 'task', selected: state.open && !state.minimized }) },
      () => dispatch('open'), [lunaButtonDetail(theme, 'task'), lunaSymbol('document'), text('Appearance', panel.text, 11)]);
    task.props.hoverStyle = {}; task.props.focusStyle = {};
    Object.assign(task.props, lunaVisualEvents(theme, { variant: 'task', selected: state.open && !state.minimized }));
    return h('view', { id: 'appearance-panel', style: {
      position: 'absolute', left: 0, right: 0, bottom: panel.inset, height: panel.height,
      ...row, gap: theme.layout.panelGap, ...gradient(panel.from, panel.to),
    } }, lunaBands(theme, 'panel', panel.height), launch, task, h('view', { style: { flexGrow: 1 } }),
      h('view', { style: { ...row, height: panel.height, paddingLeft: 12, paddingRight: 12, position: 'relative' } },
        lunaBands(theme, 'tray', panel.height), text('10:31 AM', panel.text, theme.layout.fontSize)));
  }
  const launch = button('appearance-launcher', 'Toggle appearance menu',
    { width: 72, height: panel.kind === 'dock' ? 24 : 28, borderRadius: theme.button.radius,
      ...gradient(panel.launcherFrom, panel.launcherTo), borderColor: c.border },
    () => dispatch('menu'), [surfaceDetail(theme),
      text('Polly', panel.launcherText, 13, { fontWeight: 'bold' })], state.menuOpen);
  const open = button('appearance-open', 'Open preview window',
    { height: tiles ? 52 : panel.kind === 'dock' ? 46 : 28,
      width: tiles ? 56 : panel.kind === 'dock' ? 76 : 160,
      ...(tiles ? { backgroundColor: 'transparent', borderColor: 'transparent' }
        : panelSurface(theme)) },
    () => dispatch('open'), [
      surfaceDetail(theme),
      tiles ? fileIcon(theme, 'P', theme.icons.size, 'appearance-dock-icon')
        : text('Appearance', c.text, 11),
      panel.kind === 'dock' ? h('view', { style: {
        width: 5, height: 3, borderRadius: 2, marginTop: 3,
        backgroundColor: state.open && !state.minimized ? c.accent : c.border,
      } }) : null,
    ]);
  if (panel.kind === 'taskbar') {
    return h('view', { id: 'appearance-panel', style: {
      position: 'absolute', left: 0, right: 0, bottom: panel.inset, height: panel.height,
      ...row, gap: 8, paddingLeft: 5, paddingRight: 10, ...gradient(panel.from, panel.to),
      borderWidth: 1, borderColor: c.light,
    } }, launch, open, h('view', { style: { flexGrow: 1 } }),
      text('Polly Desktop', panel.text, 11));
  }
  return [
    h('view', { id: 'appearance-menubar', style: {
      position: 'absolute', left: 0, right: 0, top: 0, height: 26,
      ...row, gap: 16, paddingLeft: 5, paddingRight: 12, ...gradient(panel.from, panel.to),
    } }, launch, text('Appearance', panel.text, 12, { fontWeight: 'bold' }),
      text('Preview', panel.text, 11), h('view', { style: { flexGrow: 1 } }),
      text('Polly Desktop', panel.text, 11)),
    h('view', { id: 'appearance-panel', style: {
      position: 'absolute', bottom: panel.inset, left: '30%', width: '40%', height: panel.height,
      ...row, justifyContent: 'center', gap: 10, borderWidth: 1, borderColor: c.light,
      ...gradient(panel.from, panel.to), borderRadius: panel.radius,
    } }, open,
      button('appearance-info', 'Explain preview scope', {
        width: tiles ? 56 : 48, height: tiles ? 52 : 42,
        ...(tiles ? { backgroundColor: 'transparent', borderColor: 'transparent' }
          : panelSurface(theme)),
      }, () => dispatch('info'), tiles ? fileIcon(theme, 'i') : text('Info', c.text, 11))),
  ];
}

function appearanceView(theme, state, dispatch) {
  return h('view', { id: 'appearance-root', style: {
    ...fill, flexDirection: 'column', backgroundColor: '#f3f5f8', overflow: 'scroll',
  } },
    h('view', { style: { padding: 12, gap: 8, flexShrink: 0 } },
      h('view', { style: { ...row, gap: 14, flexWrap: 'wrap' } },
        text('Polly Desktop / Appearance Lab', '#182636', 17, { fontWeight: 'bold' }),
        text('SIMULATED SHELL', '#596c82', 10)),
      h('view', { style: { ...row, gap: 6, flexWrap: 'wrap' } },
        DESKTOP_THEMES.map(preset =>
          button('appearance-theme-' + preset.id, 'Use ' + preset.name, {
            height: 28, paddingLeft: 10, paddingRight: 10, borderRadius: 5,
            borderColor: state.themeId === preset.id ? '#245edb' : '#bcc5d0',
            backgroundColor: state.themeId === preset.id ? '#dce8fd' : '#ffffff',
          }, () => dispatch('theme', preset.id), text(preset.name, '#27364a', 11),
          state.themeId === preset.id))),
      text(theme.era, '#526277', 11)),
    h('view', { id: 'appearance-desktop', style: {
      flexGrow: 1, flexBasis: 0, minHeight: 360, position: 'relative', overflow: 'hidden',
    } }, wallpaper(theme),
      h('view', { style: { position: 'absolute', left: 16, top: 48, gap: 8, ...center } },
        fileIcon(theme, 'P', 36), text('Polly', '#ffffff', 11)),
      desktopWindows(theme, state, dispatch),
      panels(theme, state, dispatch),
      launcher(theme, state, dispatch)));
}

export function createAppearancePreview({ themeId = DEFAULT_DESKTOP_THEME } = {}) {
  getDesktopTheme(themeId);
  let container = null;
  const state = {
    themeId, open: true, minimized: false, maximized: false, menuOpen: false,
    folder: 'Documents', clicks: 0, message: 'Choose a theme above. All controls affect this preview only.',
  };
  function update() {
    if (container) render(appearanceView(getDesktopTheme(state.themeId), state, dispatch), container);
  }
  function dispatch(action, value) {
    switch (action) {
      case 'theme': getDesktopTheme(value); state.themeId = value; state.menuOpen = false; break;
      case 'menu': state.menuOpen = !state.menuOpen; break;
      case 'minimize': state.minimized = true; state.menuOpen = false; break;
      case 'maximize': state.maximized = !state.maximized; break;
      case 'close': state.open = false; state.maximized = false; state.menuOpen = false; break;
      case 'open': state.open = true; state.minimized = false; state.menuOpen = false; break;
      case 'folder':
        if (!['Documents', 'Downloads', 'Pictures'].includes(value)) throw new RangeError('Unknown preview folder');
        state.folder = value; break;
      case 'sample': state.message = 'Sample action clicked ' + (++state.clicks) + ' time(s).'; break;
      case 'info':
        state.open = true; state.minimized = false;
        state.message = 'Not connected to PollyWM yet. No files, sessions or OS settings are changed.'; break;
      default: throw new RangeError('Unknown appearance action: ' + action);
    }
    update();
  }
  return {
    mount(target) {
      if (container) throw new Error('Appearance preview is already mounted');
      if (!target || typeof target.appendChild !== 'function') throw new TypeError('A DOM container is required');
      container = target; update(); return this;
    },
    unmount() { if (container) render(null, container); container = null; },
    selectTheme(id) { dispatch('theme', id); },
    getState() { return { ...state }; },
  };
}
