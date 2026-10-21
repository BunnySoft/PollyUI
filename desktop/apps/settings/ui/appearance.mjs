import { h } from './gui/sdk/js/reconciler.mjs';
import { bodyFont } from './desktop/shared/ui/body-font.mjs';
import { button } from './desktop/shared/ui/button.mjs';
import { desktopCommand, themedText, settingsCard, scrollDesktop } from './desktop/shared/ui/presentation.mjs';
import { themeTextSize } from './desktop/shared/ui/theme-layout.mjs';
import { panelAppearance, panelDetail } from './desktop/shared/ui/panel-appearance.mjs';
const row = { flexDirection: 'row', alignItems: 'center' };
const isCommandFocus = node => ['theme-focus-ring', 'luna-focus-ring'].includes(node?.props?.className);
const labelFor = theme => (value, color, size = 12) => h('view', { style: {
  color, fontSize: themeTextSize(theme, size), ...bodyFont(theme), flexShrink: 0 } }, value);
import { DESKTOP_THEMES } from './desktop/shared/ui/themes.mjs';
import { appearanceThemes } from './desktop/shared/ui/theme-order.mjs';
import { wallpaper as previewWallpaper } from './desktop/shared/ui/wallpaper.mjs';
function opacitySlider(theme, settings) {
  const id = 'settings-window-opacity-slider', value = settings.percent ?? settings.requestedPercent;
  const enabled = settings.enabled && settings.available;
  function paint(node, percent) {
    const fraction = (percent - 50) / 50 * 100;
    node.setAttribute('aria-valuenow', String(percent));
    const fill = node.childNodes.find(child => child.id === id + '-fill');
    const thumb = node.childNodes.find(child => child.id === id + '-thumb');
    const label = node.childNodes.find(child => child.id === id + '-value');
    if (fill) fill.style.width = fraction + '%';
    if (thumb) thumb.style.left = fraction + '%';
    if (label?.firstChild) label.firstChild.textContent = percent + '%';
  }
  function cancel(node) {
    if (!node.__windowOpacityDrag) return;
    node.__windowOpacityDrag = null;
    if (node.hasMouseCapture()) node.releaseMouseCapture();
    paint(node, value);
  }
  function move(event) {
    const node = event.currentTarget, drag = node.__windowOpacityDrag;
    if (!drag) return;
    const rect = node.getBoundingClientRect();
    if (!(rect.width > 0)) return;
    drag.value = Math.max(50, Math.min(100, Math.round(50 + (event.clientX - rect.x) / rect.width * 50)));
    paint(node, drag.value);
  }
  return h('view', { id, role: 'slider', tabIndex: enabled ? 0 : -1, 'aria-label': 'Ordinary window opacity',
    'aria-valuemin': '50', 'aria-valuemax': '100', 'aria-valuenow': String(value),
    'aria-disabled': String(!enabled),
    style: { flexGrow: 1, minWidth: 160, height: 42, position: 'relative',
      borderWidth: 1, borderColor: theme.colors.border, opacity: enabled ? 1 : theme.layout.disabledOpacity },
    focusStyle: { borderColor: theme.colors.focus },
    onMount: node => paint(node, value),
    onUpdate: node => {
      if (node.__windowOpacityDrag && (!enabled || node.__windowOpacityDrag.start !== value)) cancel(node);
      if (!node.__windowOpacityDrag) paint(node, value);
    },
    onMousedown: event => {
      if (!enabled || event.button !== 0 || nodeDragging(event.currentTarget)) return;
      event.preventDefault();
      const node = event.currentTarget;
      node.focus();
      node.__windowOpacityDrag = { start: value, value };
      node.setMouseCapture();
      move(event);
    },
    onMousemove: move,
    onMouseup: event => {
      const node = event.currentTarget, drag = node.__windowOpacityDrag;
      if (!drag || event.button !== 0) return;
      move(event);
      node.__windowOpacityDrag = null;
      if (node.hasMouseCapture()) node.releaseMouseCapture();
      if (drag.value !== value) settings.select(drag.value);
    },
    onLostmousecapture: event => cancel(event.currentTarget),
    onBlur: event => cancel(event.currentTarget),
    onKeydown: event => {
      if (!enabled || event.isComposing || event.defaultPrevented) return;
      if (event.key === 'Escape' && nodeDragging(event.currentTarget)) {
        event.preventDefault(); event.stopPropagation(); cancel(event.currentTarget); return;
      }
      const next = { ArrowLeft: value - 1, ArrowDown: value - 1, ArrowRight: value + 1, ArrowUp: value + 1,
        PageDown: value - 5, PageUp: value + 5, Home: 50, End: 100 }[event.key];
      if (next === undefined || nodeDragging(event.currentTarget)) return;
      event.preventDefault(); event.stopPropagation();
      const percent = Math.max(50, Math.min(100, next));
      if (percent !== value) settings.select(percent);
    },
    onLeave: (node, done) => { cancel(node); done(); },
  },
  h('view', { id: id + '-value', style: { position: 'absolute', top: 1, left: 8,
    color: theme.colors.text, fontSize: theme.layout.statusFontSize, pointerEvents: 'none' } }, value + '%'),
  h('view', { style: { position: 'absolute', left: 0, top: 29, width: '100%', height: 4,
    backgroundColor: theme.colors.border, pointerEvents: 'none' } }),
  h('view', { id: id + '-fill', style: { position: 'absolute', left: 0, top: 29, width: '0%', height: 4,
    backgroundColor: theme.colors.accent, pointerEvents: 'none' } }),
  h('view', { id: id + '-thumb', style: { position: 'absolute', top: 23, left: '0%', width: 12, height: 16,
    marginLeft: -6, borderRadius: 4, backgroundColor: theme.colors.accent, pointerEvents: 'none' } }));
}
function nodeDragging(node) { return !!node.__windowOpacityDrag; }
export function settingsView(theme, select, close, retry, error = '', about = false, shortcuts = null, displays = null, network = null, audio = null, themeFiles = null, power = null, embedded = false, status = '', themes = DESKTOP_THEMES, transparency = null, windowOpacity = null, switcher = null, wallpaper = null, companion = null, cube = null) {
  const label = labelFor(theme);
  const wallpaperPolicy = wallpaper ? { mode: wallpaper.mode, reducedMotion: wallpaper.reducedMotion,
    ...(wallpaper.video ? { video: wallpaper.video } : {}) } : null;
  themes = appearanceThemes(themes);
  return h('view', { id: 'shell-settings', style: {
    width: '100%', ...(embedded ? {} : { height: '100%' }),
    padding: embedded ? theme.layout.compactPadding : theme.layout.contentPadding,
    gap: theme.layout.contentGap, overflow: 'scroll',
    backgroundColor: theme.colors.body, minHeight: 0, flexShrink: 0,
  }, onWheel: scrollDesktop },
  h('view', { style: { ...row, gap: theme.layout.contentGap, flexWrap: 'wrap', flexShrink: 0 } },
    embedded ? null : themedText(theme, about ? 'PollyDesktop' : 'Desktop appearance',
      theme.colors.text, theme.layout.largeHeadingFontSize, { fontWeight: 600 }),
    h('view', { style: { flexGrow: 1 } }),
    embedded ? null : button('shell-settings-close', 'Close', theme, close)),
  about
    ? [
        label('Independent Wayland desktop', theme.colors.text, 13),
        label('PollyWM + native PollyUI surfaces', theme.colors.muted, 11),
        label('Alt+Tab switches windows. Alt+F4 closes one.', theme.colors.muted, 11),
        label('Alt+F9 minimizes. Alt+F10 maximizes.', theme.colors.muted, 11),
        label('Alt+F11 toggles fullscreen.', theme.colors.muted, 11),
        label('Alt+Escape opens logout confirmation.', theme.colors.muted, 11),
        label('Window buttons reflect live compositor state.', theme.colors.muted, 10),
        label('Login and locking depend on deployed session policy.', theme.colors.muted, 10),
      ]
    : [
        themedText(theme, 'Choose a look for your desktop', theme.colors.text, theme.layout.headingFontSize, { fontWeight: 600 }),
        themedText(theme, 'Wallpaper, window frames and desktop colors. Changes apply now.', theme.colors.muted, theme.layout.fontSize,
          { flexShrink: 1, minWidth: 0 }),
        h('view', { id: 'settings-theme-gallery', style: { ...row, flexWrap: 'wrap', gap: theme.layout.contentGap, alignItems: 'stretch',
          flexShrink: 0 } }, themes.map(preset => {
          const sample = preset.desktop ? preset : theme, selected = theme.id === preset.id;
          const art = h('view', { style: { height: 104, width: '100%', overflow: 'hidden', position: 'relative',
            borderRadius: 5, pointerEvents: 'none', flexShrink: 0 } },
          previewWallpaper(sample, 'settings-preview-' + preset.id),
          h('view', { style: { position: 'absolute', left: '20%', top: 18, width: '66%', height: 64,
            backgroundColor: sample.colors.surface, borderRadius: sample.window.radius / 2, overflow: 'hidden',
            borderWidth: 1, borderColor: sample.window.border, pointerEvents: 'none' } },
            h('view', { style: { height: 16, backgroundColor: sample.window.titleFrom, pointerEvents: 'none' } }),
            h('view', { style: { ...row, flexGrow: 1, gap: 5, padding: 7, pointerEvents: 'none' } },
              h('view', { style: { width: 20, height: '100%', backgroundColor: sample.colors.body, pointerEvents: 'none' } }),
              h('view', { style: { flexGrow: 1, height: 20, backgroundColor: sample.colors.selection, pointerEvents: 'none' } }))),
          h('view', { style: { position: 'absolute', left: 0, bottom: 0, width: '100%', height: 10,
            backgroundColor: sample.panel.from, pointerEvents: 'none' } }));
          const tile = desktopCommand('shell-theme-' + preset.id, preset.name, theme, () => select(preset.id),
            { selected, style: { flexDirection: 'column', alignItems: 'stretch', height: 166, padding: 10, gap: 8,
              flexGrow: 1, flexBasis: 168, minWidth: 150, maxWidth: 260 } });
          // Retain the focus wrapper, but not the command's bevel/gloss, above the custom card content.
          const focusDetail = tile.children.find(child => child.children?.some(isCommandFocus));
          if (focusDetail) focusDetail.children = focusDetail.children.filter(isCommandFocus);
          tile.children = [art, themedText(theme, preset.name, theme.colors.text, theme.layout.fontSize,
            { pointerEvents: 'none', fontWeight: 600 }),
            themedText(theme, selected ? 'Selected' : 'Apply theme', selected ? theme.colors.accent : theme.colors.muted,
              theme.layout.statusFontSize,
              { pointerEvents: 'none' }), ...(focusDetail ? [focusDetail] : [])];
          return tile;
        })),
        themedText(theme, 'Theme previews are illustrations, not hardware screenshots. Solid surfaces; no simulated blur.',
          theme.colors.muted, theme.layout.statusFontSize, { flexShrink: 1 }),
        themeFiles ? settingsCard(theme, 'Theme library', themeFiles.enabled ? 'User theme files enabled' : 'Packaged themes active', [
          h('view', { style: { ...row, flexWrap: 'wrap', gap: theme.layout.controlGap } },
            desktopCommand('shell-theme-reload', 'Reload theme files', theme, themeFiles.reload, { icon: 'refresh' }),
            desktopCommand('shell-theme-restore', 'Use packaged themes', theme, themeFiles.restore)),
        ]) : null,
        wallpaper ? settingsCard(theme, 'Desktop wallpaper',
          'Aurora is original drawing generated with Canvas, not a video or a downloaded asset.', [
            h('view', { style: { ...row, flexWrap: 'wrap', gap: theme.layout.controlGap } },
              [['theme', 'Theme wallpaper'], ['aurora', 'Animated Aurora'], ['video', 'Local video']].map(([mode, title]) =>
                desktopCommand('settings-wallpaper-' + mode, title, theme,
                  () => wallpaper.select({ ...wallpaperPolicy, mode }), {
                    selected: wallpaper.mode === mode,
                    enabled: wallpaper.enabled && (mode === 'video' ? wallpaper.videoAvailable && !!wallpaper.video :
                      mode === 'theme' || wallpaper.available),
                  }))),
            h('view', { style: { ...row, flexWrap: 'wrap', gap: theme.layout.controlGap } },
              [[false, 'Animate', 'animate'], [true, 'Reduce motion', 'reduced']].map(([reducedMotion, title, id]) =>
                desktopCommand('settings-wallpaper-' + id, title, theme,
                  () => wallpaper.select({ ...wallpaperPolicy, reducedMotion }), {
                    selected: wallpaper.reducedMotion === reducedMotion,
                    enabled: wallpaper.enabled && wallpaper.available,
                  }))),
            themedText(theme, wallpaper.reason || 'At most 30 FPS; pauses behind opaque coverage, on disabled outputs and while locked. Reduce motion keeps a still frame.',
              theme.colors.muted, theme.layout.statusFontSize, { flexShrink: 1 }),
            wallpaper.error ? h('view', { role: 'alert' }, themedText(theme, wallpaper.error,
              theme.colors.text, theme.layout.fontSize, { flexShrink: 1 })) : null,
            wallpaper.choose ? desktopCommand('settings-wallpaper-choose-video', 'Choose local video...', theme,
              wallpaper.choose, { enabled: wallpaper.enabled && wallpaper.videoAvailable === true }) : null,
            wallpaper.video ? h('view', { style: { gap: 6 } },
              themedText(theme, wallpaper.video.path, theme.colors.muted, theme.layout.statusFontSize, { flexShrink: 1 }),
              h('view', { style: { ...row, flexWrap: 'wrap', gap: theme.layout.controlGap } },
                desktopCommand('settings-wallpaper-video-pause', wallpaper.video.paused ? 'Play' : 'Pause', theme,
                  () => wallpaper.select({ ...wallpaperPolicy, mode: 'video',
                    video: { ...wallpaper.video, paused: !wallpaper.video.paused } }), {
                    enabled: wallpaper.enabled && wallpaper.videoAvailable === true &&
                      wallpaper.mode === 'video' && !wallpaper.reducedMotion }),
                desktopCommand('settings-wallpaper-video-loop', wallpaper.video.loop ? 'Loop: on' : 'Loop: off', theme,
                  () => wallpaper.select({ ...wallpaperPolicy,
                    video: { ...wallpaper.video, loop: !wallpaper.video.loop } }), {
                    enabled: wallpaper.enabled && wallpaper.videoAvailable === true })),
              themedText(theme, wallpaper.playback?.ready ?
                (wallpaper.playback.ended ? 'Ended; last frame retained.' : wallpaper.playback.paused ? 'Paused.' : 'Playing.') +
                ' ' + wallpaper.playback.width + 'x' + wallpaper.playback.height + '. Audio is disabled.' :
                wallpaper.error ? 'Stopped. Choose a valid local file or restore the theme wallpaper.' :
                  wallpaper.mode === 'video' ? wallpaper.video.paused || wallpaper.reducedMotion ?
                    'Paused before the first frame; static theme is retained.' :
                    'Loading native decoder; static theme remains until the first frame.' :
                    'Select Local video to start.',
              theme.colors.muted, theme.layout.statusFontSize, { flexShrink: 1 })) : null,
            wallpaper.mode === 'video' && wallpaper.reducedMotion ? themedText(theme,
              'Reduced motion keeps video paused. Select Animate above to allow playback.',
            theme.colors.muted, theme.layout.statusFontSize, { flexShrink: 1 }) : null,
            wallpaper.videoReason ? themedText(theme, wallpaper.videoReason, theme.colors.muted,
              theme.layout.statusFontSize, { flexShrink: 1 }) : null,
            wallpaper.chooseError ? h('view', { role: 'alert' }, themedText(theme, wallpaper.chooseError,
              theme.colors.text, theme.layout.fontSize, { flexShrink: 1 })) : null,
          ], 'settings-wallpaper') : null,
          companion ? settingsCard(theme, 'Desktop companion',
            'Original Polly rabbit. Transparent pixels pass mouse input through; it never takes keyboard focus.', [
              h('view', { style: { ...row, flexWrap: 'wrap', gap: theme.layout.controlGap } },
                [[false, 'Hidden', 'off'], [true, 'Show Polly', 'on']].map(([enabled, title, id]) =>
                  desktopCommand('settings-companion-' + id, title, theme,
                    () => companion.select({ enabled, reducedMotion: companion.reducedMotion }), {
                      selected: companion.enabled === enabled,
                      enabled: companion.enabledControl && (!enabled || companion.available),
                    }))),
              h('view', { style: { ...row, flexWrap: 'wrap', gap: theme.layout.controlGap } },
                [[false, 'Animate actions', 'animate'], [true, 'Reduce motion', 'reduced']].map(([reducedMotion, title, id]) =>
                  desktopCommand('settings-companion-' + id, title, theme,
                    () => companion.select({ enabled: companion.enabled, reducedMotion }), {
                      selected: companion.reducedMotion === reducedMotion,
                      enabled: companion.enabledControl && companion.available,
                    }))),
              themedText(theme, companion.error || companion.reason ||
                'Drag inside the current output. Click to wave; right-click for tips and Hide. Actions pause while locked.',
              theme.colors.muted, theme.layout.statusFontSize, { flexShrink: 1 }),
            ], 'settings-companion') : null,
        transparency ? settingsCard(theme, 'Transparency', 'Desktop bar backgrounds only; application text and icons are not faded.', [
          h('view', { style: { ...row, flexWrap: 'wrap', gap: theme.layout.controlGap } },
            [['theme', 'Theme default'], ['opaque', 'Opaque'], ['transparent', 'Transparent']].map(([mode, name]) =>
              desktopCommand('shell-transparency-' + mode, name, theme, () => transparency.select(mode), {
                selected: transparency.mode === mode,
                enabled: transparency.enabled && (mode !== 'transparent' || transparency.available),
              }))),
          themedText(theme, transparency.reason || (transparency.target ?
            'Applies to: ' + transparency.target + '. Changes apply now and are saved.' :
            'Choose a compatible theme to enable desktop bar transparency.'),
          theme.colors.muted, theme.layout.statusFontSize, { flexShrink: 1 }),
          transparency.preview ? desktopCommand('settings-transparency-preview', 'Open transparent window preview',
            theme, transparency.preview, { enabled: transparency.previewAvailable }) : null,
          transparency.previewReason ? themedText(theme, transparency.previewReason, theme.colors.muted,
            theme.layout.statusFontSize, { flexShrink: 1 }) : null,
          transparency.previewError ? h('view', { role: 'alert' },
            themedText(theme, transparency.previewError, theme.colors.text, theme.layout.fontSize, { flexShrink: 1 })) : null,
        ], 'settings-transparency') : null,
        windowOpacity ? settingsCard(theme, 'Window opacity',
          'Fades ordinary windows, including their text and title bars. Trusted desktop/security surfaces stay opaque.', [
            opacitySlider(theme, windowOpacity),
            h('view', { style: { ...row, flexWrap: 'wrap', gap: theme.layout.controlGap } },
              desktopCommand('settings-window-opacity-reset', 'Restore 100%', theme,
                () => windowOpacity.select(100), { enabled: windowOpacity.enabled && windowOpacity.available })),
            themedText(theme, windowOpacity.available ? 'Current opacity: ' + windowOpacity.percent + '%; saved preference: ' +
              windowOpacity.requestedPercent + '%. Drag then release to apply, or use arrow keys.' : windowOpacity.reason,
            theme.colors.muted, theme.layout.statusFontSize, { flexShrink: 1 }),
            windowOpacity.error ? h('view', { role: 'alert' },
              themedText(theme, windowOpacity.error, theme.colors.text, theme.layout.fontSize, { flexShrink: 1 })) : null,
          ], 'settings-window-opacity') : null,
        switcher ? settingsCard(theme, 'Window switching', 'Choose the presentation for the next Alt+Tab switcher.', [
          h('view', { style: { ...row, flexWrap: 'wrap', gap: theme.layout.controlGap } },
            [['list', 'Title list'], ['thumbnails', '2D window previews'], ['flip3d', 'Flip 3D']].map(([style, title]) =>
              desktopCommand('settings-switcher-' + style, title, theme, () => switcher.select(style), {
                selected: switcher.style === style,
                enabled: switcher.enabled && (style === 'list' ||
                  (style === 'thumbnails' ? switcher.available : switcher.projectionAvailable === true)),
              }))),
          themedText(theme, switcher.reason || 'Real window images stay in the compositor. Release modifiers to choose; Esc cancels.',
            theme.colors.muted, theme.layout.statusFontSize, { flexShrink: 1 }),
          switcher.projectionAvailable === true ? null : themedText(theme, switcher.projectionReason ||
            'The connected Shell does not expose paired native GLES 3D previews.', theme.colors.muted,
          theme.layout.statusFontSize, { flexShrink: 1 }),
          switcher.setMotion ? h('view', { style: { ...row, flexWrap: 'wrap', gap: theme.layout.controlGap } },
            [[true, 'Animate 3D transitions', 'animate'], [false, 'Still 3D poses', 'still']].map(([motion, title, id]) =>
              desktopCommand('settings-switcher-' + id, title, theme, () => switcher.setMotion(motion), {
                selected: (switcher.motion ?? true) === motion,
                enabled: switcher.enabled,
              }))) : null,
        ], 'settings-window-switching') : null,
        cube ? settingsCard(theme, 'Workspace cube',
          'Four real workspace faces, composed natively. Original focus stays unchanged until acceptance.', [
            h('view', { style: { ...row, flexWrap: 'wrap', gap: theme.layout.controlGap } },
              [[false, 'Immediate switching', 'off'], [true, '3D workspace cube', 'on']].map(([enabled, label, id]) =>
                desktopCommand('settings-cube-' + id, label, theme,
                  () => cube.select({ enabled, motion: cube.motion }), {
                    selected: cube.enabled === enabled,
                    enabled: cube.enabledControl && (!enabled || cube.available),
                  }))),
            h('view', { style: { ...row, flexWrap: 'wrap', gap: theme.layout.controlGap } },
              [[true, 'Animate rotation', 'animate'], [false, 'Still poses', 'still']].map(([motion, label, id]) =>
                desktopCommand('settings-cube-' + id, label, theme,
                  () => cube.select({ enabled: cube.enabled, motion }), {
                    selected: cube.motion === motion,
                    enabled: cube.enabledControl && (!cube.enabled || cube.available),
                  }))),
            themedText(theme, cube.reason ||
              'Hold workspace shortcut modifiers and use Left/Right; release to choose. Enter accepts; Esc cancels.',
            theme.colors.muted, theme.layout.statusFontSize, { flexShrink: 1 }),
            cube.error ? h('view', { role: 'alert' }, themedText(theme, cube.error,
              theme.colors.text, theme.layout.fontSize, { flexShrink: 1 })) : null,
          ], 'settings-workspace-cube') : null,
      ],
  shortcuts ? button('shell-keyboard-settings', 'Keyboard shortcuts', theme, shortcuts) : null,
  displays ? button('shell-display-settings', 'Displays', theme, displays) : null,
  network ? button('shell-network-settings-open', 'Wi-Fi', theme, network) : null,
  audio ? button('shell-audio-settings-open', 'Audio', theme, audio) : null,
  power ? button('shell-power-settings-open', 'Power', theme, power) : null,
  status ? h('view', { role: 'status', 'aria-live': 'polite', style: { ...panelAppearance(theme),
    backgroundColor: theme.colors.selection, flexShrink: 0, minWidth: 0 } }, panelDetail(theme),
    themedText(theme, status, theme.colors.selectionText ?? theme.colors.text,
      theme.layout.statusFontSize, { flexShrink: 1, minWidth: 0 })) : null,
  error ? h('view', { role: 'alert', style: { ...panelAppearance(theme), borderColor: '#b42318',
    flexShrink: 0, minWidth: 0 } }, panelDetail(theme),
    themedText(theme, error, theme.colors.text, theme.layout.fontSize, { flexShrink: 1 }),
    desktopCommand('shell-retry', 'Refresh status', theme, retry, { icon: 'refresh' })) : null,
  themedText(theme, embedded ? 'Preferences in a memory-only Live session reset after reboot.' : 'Escape closes this menu.',
    theme.colors.muted, theme.layout.statusFontSize));
}
