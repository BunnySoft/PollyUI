import { button } from './desktop/shared/ui/button.mjs';
export { button };
export { settingsView } from './desktop/apps/settings/ui/appearance.mjs';
export { shortcutsView } from './desktop/apps/settings/ui/keyboard.mjs';
export { displaysView } from './desktop/apps/settings/ui/displays.mjs';
import { h } from './gui/sdk/js/reconciler.mjs';
import { DESKTOP_THEMES } from './desktop/shell/themes.mjs';


import { trayView } from './desktop/shell/tray.mjs';
import { themeTextSize, dockSurfaceWidth } from './desktop/shell/theme-layout.mjs';
import { isLuna, lunaBands, lunaButtonPaint, lunaButtonDetail, lunaVisualEvents, lunaSymbol } from './desktop/shell/luna-primitives.mjs';
import { desktopCommand, desktopText, desktopIcon, settingsCard, scrollDesktop } from './desktop/shell/presentation.mjs';
import { bevel, surfaceStyle, surfacePaint, surfaceEvents, surfaceDetail } from './desktop/shared/ui/surface-primitives.mjs';
import { startMenuView } from './desktop/shell/start-menu.mjs';
import { classicTaskPaint } from './desktop/shared/ui/classic-task-paint.mjs';
import { taskLabel, taskIdentity } from './desktop/shell/window-groups.mjs';
import { guardTaskGesture } from './desktop/shell/window-group-menu.mjs';
import { panelViewport } from './desktop/shared/ui/panel-viewport.mjs';

export { wallpaper } from './desktop/shell/appearance.mjs';

const row = { flexDirection: 'row', alignItems: 'center' };
const center = { alignItems: 'center', justifyContent: 'center' };
const gradient = (from, to) => ({ backgroundColor: from, gradientFrom: from, gradientTo: to });
const menuThemes = new WeakMap();
const fluentPanels = new WeakMap();
const panelFinalizers = new FinalizationRegistry(weak => weak.deref()?.());
function stopFluentPanel(node) {
  const state = fluentPanels.get(node);
  if (!state) return;
  if (state.frame !== null) cancelAnimationFrame(state.frame);
  state.unsubscribe?.();
  panelFinalizers.unregister(state.token);
  fluentPanels.delete(node);
}
function observeFluentPanel(node, state) {
  const document = node.ownerDocument, view = document?.defaultView;
  if (!document || view?.closed) { stopFluentPanel(node); return false; }
  if (view !== state.owner) {
    state.unsubscribe?.();
    panelFinalizers.unregister(state.token);
    state.owner = view;
    state.unsubscribe = null;
    if (view) {
      const weak = new WeakRef(node);
      let remove;
      remove = view.observeState(() => {
        const panel = weak.deref();
        if (!panel) { remove(); return; }
        syncFluentPanel(panel);
      });
      state.unsubscribe = remove;
      panelFinalizers.register(node, new WeakRef(remove), state.token);
    }
  }
  return true;
}
function revealFluentTask(event) {
  let target = event.currentTarget;
  for (let strip = target.parentNode; strip; strip = strip.parentNode) {
    if (!['shell-window-list', 'shell-centered-tasks'].includes(strip.id)) continue;
    const left = target.offsetLeft - strip.offsetLeft, end = left + target.offsetWidth;
    const start = Number(strip.scrollLeft);
    const extent = strip.childNodes.reduce((maximum, child) =>
      Math.max(maximum, child.offsetLeft + child.offsetWidth - strip.offsetLeft), strip.offsetWidth);
    const next = target.offsetWidth > strip.offsetWidth || left < start ? left :
      end > start + strip.offsetWidth ? end - strip.offsetWidth : start;
    strip.scrollLeft = Math.max(0, Math.min(extent - strip.offsetWidth, next));
    // Offsets are unscrolled; reveal the inner viewport, not its offscreen task, in the outer group.
    target = strip;
  }
}
function syncFluentPanel(node, theme) {
  let state = fluentPanels.get(node);
  if (!state) {
    // QuickJS retains unregister tokens; the token must not carry an owner or unsubscribe closure.
    state = { frame: null, owner: null, unsubscribe: null, token: {} };
    fluentPanels.set(node, state);
  }
  if (theme) state.theme = theme;
  if (state.frame !== null) return;
  state.frame = requestAnimationFrame(() => {
    if (!observeFluentPanel(node, state)) return;
    state.frame = requestAnimationFrame(() => {
      state.frame = null;
      if (!observeFluentPanel(node, state)) return;
      const group = node.querySelector('#shell-centered-tasks'), tray = node.querySelector('#shell-notification-area');
      if (!group || !tray) { stopFluentPanel(node); return; }
      if (!node.offsetWidth) return;
      const theme = state.theme, l = theme.layout;
      const strip = node.querySelector('#shell-window-list');
      const fixed = group.childNodes.filter(child => child !== strip);
      const taskWidth = strip.childNodes.reduce((sum, child) => sum + child.offsetWidth, 0) +
        Math.max(0, strip.childNodes.length - 1) * l.windowGap;
      const desired = fixed.reduce((sum, child) => sum + child.offsetWidth, 0) +
        fixed.length * l.panelGap + taskWidth + l.panelGap;
      const left = l.panelPaddingLeft, right = Math.max(left, tray.offsetLeft - node.offsetLeft - l.panelGap);
      const width = Math.max(1, Math.min(desired, right - left));
      group.style.width = String(width);
      group.style.left = String(Math.max(left, Math.min((node.offsetWidth - desired) / 2, right - width)));
      group.style.top = String((node.offsetHeight - group.offsetHeight) / 2);
      group.scrollLeft = Math.max(0, Math.min(Number(group.scrollLeft),
        Math.max(0, fixed.reduce((sum, child) => sum + child.offsetWidth, 0) +
          fixed.length * l.panelGap + (strip.childNodes.length ? l.windowButtonWidth : 0) - width)));
      state.frame = requestAnimationFrame(() => {
        state.frame = null;
        if (!observeFluentPanel(node, state)) return;
        if (node.ownerDocument.activeElement)
          revealFluentTask({ currentTarget: node.ownerDocument.activeElement });
      });
    });
  });
}
const labelFor = theme => (value, color, size = 12) =>
  h('view', { style: { color, fontSize: themeTextSize(theme, size), flexShrink: 0 } }, value);

const dockLayouts = new WeakMap();
function dockScrollMaximum(node) {
  return node.childNodes.reduce((maximum, child) => Math.max(maximum,
    child.offsetLeft + child.offsetWidth - node.offsetLeft - node.offsetWidth), 0);
}
function scrollDock(event) {
  const start = Number(event.currentTarget.scrollLeft);
  scrollDesktop(event, true);
  if (Number(event.currentTarget.scrollLeft) !== start) event.stopPropagation?.();
}
function revealDockSlot(event) {
  let target = event.currentTarget;
  for (let viewport = target.parentNode; viewport; viewport = viewport.parentNode) {
    if (!['shell-dock-windows', 'shell-dock-viewport'].includes(viewport.id)) continue;
    const left = target.offsetLeft - viewport.offsetLeft, end = left + target.offsetWidth;
    const start = Number(viewport.scrollLeft);
    const next = target.offsetWidth > viewport.offsetWidth || left < start ? left :
      end > start + viewport.offsetWidth ? end - viewport.offsetWidth : start;
    viewport.scrollLeft = Math.max(0, Math.min(dockScrollMaximum(viewport), next));
    target = viewport;
  }
}
function syncDockLayout(node) {
  let state = dockLayouts.get(node);
  if (!state) { state = { frame: null, geometry: '' }; dockLayouts.set(node, state); }
  if (state.frame !== null) return;
  const weak = new WeakRef(node);
  // Settle attachment/layout once; unchanged clock reconciliation must not undo manual scrolling.
  state.frame = requestAnimationFrame(() => {
    state.frame = requestAnimationFrame(() => {
      state.frame = null;
      const viewport = weak.deref();
      if (!viewport?.parentNode || !viewport.offsetWidth) return;
      const surface = viewport.firstChild, strip = surface.querySelector('#shell-dock-windows');
      const geometry = [viewport.offsetWidth, surface.offsetWidth, strip?.offsetWidth ?? 0,
        strip ? dockScrollMaximum(strip) : 0, ...surface.childNodes.flatMap(child =>
          [child.offsetLeft - surface.offsetLeft, child.offsetWidth])].join(':');
      if (state.geometry === geometry) return;
      state.geometry = geometry;
      viewport.style.overflow = surface.offsetWidth > viewport.offsetWidth ? 'scroll' : 'visible';
      if (strip) strip.scrollLeft = Math.max(0, Math.min(Number(strip.scrollLeft), dockScrollMaximum(strip)));
      viewport.scrollLeft = Math.max(0, Math.min(Number(viewport.scrollLeft), dockScrollMaximum(viewport)));
      const active = viewport.ownerDocument?.activeElement;
      for (let parent = active; parent; parent = parent.parentNode)
        if (parent === viewport) { revealDockSlot({ currentTarget: active }); break; }
    });
  });
}

function taskArtwork(window, images, size, fallback) {
  const image = window?.appId && images?.get(window.appId);
  return image ? h('view', { 'aria-hidden': 'true', style: {
    width: size, height: size, flexShrink: 0, backgroundImage: image, pointerEvents: 'none',
  } }) : fallback;
}

function windowButtons(theme, windows, toggle, actions, compact = false, images = null) {
  return h('view', { id: 'shell-window-list', style: {
    ...row, flexGrow: 1, flexBasis: 0, minWidth: 0, gap: theme.layout.windowGap, overflow: 'scroll',
  }, onWheel: event => {
    event.preventDefault();
    const node = event.currentTarget;
    const extent = node.childNodes.reduce((maximum, child) =>
      Math.max(maximum, child.offsetLeft + child.offsetWidth - node.offsetLeft), 0);
    node.scrollLeft = Math.max(0, Math.min(extent - node.offsetWidth,
      Number(node.scrollLeft) + (event.deltaX || event.deltaY)));
  } }, windows.map(window => {
    const title = window.title || window.appId || 'Untitled';
    const short = Array.from(title).slice(0, compact ? theme.layout.dockTitleLimit : theme.layout.windowTitleLimit).join('');
    const node = button('shell-window-' + window.id,
      (window.minimized ? '[min] ' : '') + short, theme, () => toggle(window.id), window.active,
      { width: compact ? theme.layout.dockWindowWidth : theme.layout.windowButtonWidth,
        height: compact ? theme.panel.height - theme.layout.panelItemInset : theme.layout.buttonHeight,
        overflow: 'hidden', ...(window.active ? gradient(theme.colors.selection, theme.colors.selection) : {}) });
    if (!compact && isLuna(theme, 'panel')) {
      Object.assign(node.props.style, lunaButtonPaint(theme, { selected: window.active, variant: 'task' }),
        { height: theme.panel.height - theme.layout.panelItemInset, alignItems: 'center',
          justifyContent: 'flex-start', flexDirection: 'row', gap: 5, paddingLeft: 7 });
      Object.assign(node.props, lunaVisualEvents(theme, { selected: window.active, variant: 'task' }));
      const caption = labelFor(theme)(short, theme.panel.text);
      caption.props.style.pointerEvents = 'none';
      node.children = [
        lunaButtonDetail(theme, 'task'), taskArtwork(window, images, 16, lunaSymbol('document')),
        caption,
      ];
    }
    if (!compact && surfaceStyle(theme, 'panel') === 'classic') {
      const options = { selected: window.active, variant: 'task' };
      Object.assign(node.props.style, surfacePaint(theme, options), {
        height: theme.panel.height - theme.layout.panelItemInset, flexDirection: 'row',
        alignItems: 'center', justifyContent: 'flex-start',
        paddingLeft: theme.layout.taskPaddingX ?? 3, paddingRight: theme.layout.taskPaddingX ?? 3 });
      const caption = labelFor(theme)(short, theme.panel.text);
      caption.props.style.pointerEvents = 'none';
      caption.props.style.fontWeight = window.active ? 700 : 400;
      const icon = taskArtwork(window, images, theme.layout.taskIconSize ?? 16,
        desktopIcon('file', theme.panel.text, theme.layout.taskIconSize ?? 16));
      icon.props.id = 'shell-window-icon-' + window.id;
      const stipple = theme.panel.taskTexture === 'stipple';
      node.children = [
        stipple ? classicTaskPaint(theme, theme.layout.windowButtonWidth,
          theme.panel.height - theme.layout.panelItemInset, window.active) : null,
        bevel(theme, { pressed: window.active }),
        stipple ? null : h('view', { className: 'theme-focus-ring', 'aria-hidden': 'true', style: {
          position: 'absolute', left: 3, top: 3, right: 3, bottom: 3, borderWidth: 1,
          borderColor: theme.colors.focus, opacity: 0, pointerEvents: 'none' } }),
        h('view', { className: 'classic-task-content', style: { ...row, position: 'relative',
          left: window.active ? 1 : 0, top: window.active ? 1 : 0, gap: 4, minWidth: 0,
          pointerEvents: 'none' } }, icon, caption)].filter(Boolean);
      Object.assign(node.props, surfaceEvents(theme, options));
    }
    if (!compact && surfaceStyle(theme, 'panel') === 'fluent') {
      const options = { selected: window.active, variant: 'task', quiet: true };
      Object.assign(node.props.style, { height: 40, width: theme.layout.windowButtonWidth,
        paddingLeft: 0, paddingRight: 0, borderWidth: 0, borderRadius: 4,
        ...surfacePaint(theme, options) });
      Object.assign(node.props, surfaceEvents(theme, options));
      const focus = node.props.onFocus;
      node.props.onFocus = event => { focus(event); revealFluentTask(event); };
      node.children = [surfaceDetail(theme, options),
        taskArtwork(window, images, 24, desktopIcon('file', theme.colors.accent, 24)),
        h('view', { 'aria-hidden': 'true', style: { position: 'absolute', bottom: 0,
          width: window.active ? 16 : 6, height: 3, borderRadius: 2,
          backgroundColor: window.active ? theme.colors.accent : theme.colors.muted, pointerEvents: 'none' } })];
    }
    node.props['aria-label'] = taskLabel(window);
    if (window.grouped && window.count > 1) {
      node.props.style.position = 'relative';
      node.children.push(h('view', {
      'aria-hidden': 'true', style: { position: 'absolute', right: 1, top: 1,
        minWidth: 12, height: 14, paddingLeft: 2, paddingRight: 2, borderRadius: 3,
        backgroundColor: theme.colors.accent, color: theme.colors.accentText,
        fontSize: theme.layout.smallFontSize, pointerEvents: 'none' } }, String(window.count)));
    }
    node.props.onClick = event => {
      if (event.button === 0) { event.stopPropagation(); return toggle(window.id); }
      return false;
    };
    node.props.onContextmenu = event => { event.preventDefault(); event.stopPropagation(); actions(window.id); };
    const activate = node.props.onKeydown;
    node.props.onKeydown = event => {
      if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
        event.preventDefault(); actions(window.id);
      } else activate(event);
    };
    return guardTaskGesture(node, taskIdentity(window));
  }));
}

export function panelView(theme, clock, openMenu, error = '', openSettings = openMenu,
  windows = [], toggle = () => {}, actions = () => {}, workspace = null, notifications = null, tray = null, images = null) {
  const panel = theme.panel;
  const label = labelFor(theme);
  if (isLuna(theme, 'panel') && panel.kind === 'taskbar') {
    const tool = (id, name, symbol, callback) => {
      const node = button(id, name, theme, callback, false, {
        height: theme.layout.compactButtonHeight, width: 24, paddingLeft: 0, paddingRight: 0,
        ...lunaButtonPaint(theme, { variant: 'tool' }),
      });
      Object.assign(node.props, lunaVisualEvents(theme, { variant: 'tool' }));
      node.children = [lunaButtonDetail(theme, 'tool'), lunaSymbol(symbol)];
      return node;
    };
    const launcher = button('shell-menu', 'Polly', theme, openMenu, false, {
      height: panel.height, width: theme.layout.launcherWidth ?? 97, borderWidth: 0, borderRadius: 0,
      paddingLeft: 7, paddingRight: 10, flexDirection: 'row', gap: 5,
      ...lunaButtonPaint(theme, { variant: 'launcher' }),
    });
    Object.assign(launcher.props, lunaVisualEvents(theme, { variant: 'launcher' }));
    launcher.children = [lunaButtonDetail(theme, 'launcher'), lunaSymbol('polly', panel.launcherText, 22),
      h('view', { style: { color: panel.launcherText, fontSize: 18, fontWeight: 700,
        fontStyle: 'italic', pointerEvents: 'none' } }, 'Polly')];
    return h('view', { id: 'shell-panel', style: {
      ...row, width: '100%', height: '100%', gap: theme.layout.panelGap,
      paddingLeft: theme.layout.panelPaddingLeft, paddingRight: theme.layout.panelPaddingRight,
      ...gradient(panel.from, panel.to), position: 'relative',
    } }, lunaBands(theme, 'panel', panel.height), launcher,
      tool('shell-panel-settings', 'Settings', 'appearance', openSettings),
      workspace ? tool('shell-workspaces', workspace.name, 'workspace', workspace.open) : null,
      windowButtons(theme, windows, toggle, actions, false, images),
      error ? label('Desktop needs attention', panel.text, 11) : null,
      h('view', { id: 'shell-notification-area', style: {
        ...row, flexShrink: 0, height: panel.height, position: 'relative',
        paddingLeft: 8, paddingRight: 10, gap: theme.layout.trayGap,
        borderLeftWidth: 1, borderColor: '#095bc9', backgroundColor: '#1285e1',
      } }, lunaBands(theme, 'tray', panel.height),
        tray?.items.length || tray?.error ? trayView(theme, tray.items, tray.activate, tray.scroll, tray.error) : null,
        notifications ? tool('shell-notifications', 'Notifications ' + notifications.count, 'notification', notifications.open) : null,
        h('view', { id: 'shell-clock', style: { color: panel.text, fontSize: theme.layout.fontSize,
          paddingLeft: 5, flexShrink: 0 } }, clock)));
  }
  if (surfaceStyle(theme, 'panel') === 'fluent') {
    const iconButton = (id, title, icon, callback) => {
      const node = desktopCommand(id, title, theme, callback, { quiet: true,
        style: { width: theme.layout.launcherWidth ?? 44, height: 40, paddingLeft: 0, paddingRight: 0,
          justifyContent: 'center', borderWidth: 0, borderRadius: 4 } });
      node.children = [desktopIcon(icon, theme.colors.accent, 24)];
      const focus = node.props.onFocus;
      node.props.onFocus = event => { focus?.(event); revealFluentTask(event); };
      return node;
    };
    const sync = node => syncFluentPanel(node, theme);
    const tasks = windowButtons(theme, windows, toggle, actions, false, images);
    tasks.props.style.minWidth = windows.length ? theme.layout.windowButtonWidth : 0;
    const wheel = tasks.props.onWheel;
    tasks.props.onWheel = event => { event.stopPropagation(); wheel(event); };
    return h('view', { id: 'shell-panel', style: { ...row, width: '100%', height: '100%',
      gap: theme.layout.panelGap, paddingLeft: 12, paddingRight: 12, backgroundColor: panel.from,
      borderTopWidth: 1, borderColor: theme.colors.border, position: 'relative' },
      onMount: sync, onUpdate: sync,
      onLeave: (node, done) => { stopFluentPanel(node); done(); } },
    h('view', { id: 'shell-centered-tasks', style: { ...row, gap: theme.layout.panelGap,
      position: 'absolute', top: (panel.height - 40) / 2, left: theme.layout.panelPaddingLeft,
      width: (2 + Number(Boolean(workspace))) * ((theme.layout.launcherWidth ?? 44) + theme.layout.panelGap) +
        windows.length * (theme.layout.windowButtonWidth + theme.layout.windowGap),
      maxWidth: '100%', minWidth: 0, overflow: 'scroll' },
      onWheel: event => scrollDesktop(event, true) },
      iconButton('shell-menu', 'Polly', 'apps', openMenu),
      iconButton('shell-panel-settings', 'Settings', 'appearance', openSettings),
      workspace ? iconButton('shell-workspaces', workspace.name, 'displays', workspace.open) : null,
      tasks),
    h('view', { id: 'shell-notification-area', style: { ...row, position: 'absolute', right: 12, top: 1,
      height: panel.height - 1, gap: 4, backgroundColor: panel.from } },
      error ? desktopText('Needs attention', panel.text, 11) : null,
      tray?.items.length || tray?.error ? trayView(theme, tray.items, tray.activate, tray.scroll, tray.error) : null,
      notifications ? iconButton('shell-notifications', 'Notifications ' + notifications.count, 'info', notifications.open) : null,
      h('view', { id: 'shell-clock', style: { color: panel.text, fontSize: 12, paddingLeft: 8 } }, clock)));
  }
  if (surfaceStyle(theme, 'panel') === 'classic' && panel.kind === 'taskbar') {
    const itemHeight = panel.height - theme.layout.panelItemInset;
    return h('view', { id: 'shell-panel', style: { ...row, position: 'relative',
      width: '100%', height: '100%', paddingTop: 2,
      paddingLeft: theme.layout.panelPaddingLeft, paddingRight: theme.layout.panelPaddingRight,
      gap: theme.layout.panelGap, backgroundColor: panel.from } },
    h('view', { 'aria-hidden': 'true', style: { position: 'absolute', left: 0, right: 0, top: 0,
      height: 1, backgroundColor: panel.from, pointerEvents: 'none' } }),
    h('view', { 'aria-hidden': 'true', style: { position: 'absolute', left: 0, right: 0, top: 1,
      height: 1, backgroundColor: theme.colors.light, pointerEvents: 'none' } }),
    button('shell-menu', 'Polly', theme, openMenu, false, { width: theme.layout.launcherWidth ?? 60,
      height: itemHeight, fontWeight: 700 }),
    button('shell-panel-settings', 'Settings', theme, openSettings, false, { height: itemHeight }),
    workspace ? button('shell-workspaces', workspace.name, theme, workspace.open, false,
      { height: itemHeight, maxWidth: theme.layout.workspaceWidth, overflow: 'hidden' }) : null,
    windowButtons(theme, windows, toggle, actions, false, images),
    error ? label('Needs attention', panel.text, 11) : null,
    h('view', { id: 'shell-notification-area', style: { ...row, position: 'relative',
      height: itemHeight, paddingLeft: 6, paddingRight: 6, gap: theme.layout.trayGap, flexShrink: 0 } },
      bevel(theme, { inset: true }),
      tray?.items.length || tray?.error ? trayView(theme, tray.items, tray.activate, tray.scroll, tray.error) : null,
      notifications ? button('shell-notifications', String(notifications.count), theme, notifications.open,
        false, { height: 20, borderWidth: 0 }) : null,
      h('view', { id: 'shell-clock', style: { color: panel.text, fontSize: 11 } }, clock)));
  }
  if (['tiger', 'lion', 'bigsur'].includes(surfaceStyle(theme, 'panel')) && panel.kind === 'dock') {
    let menuTheme = menuThemes.get(theme);
    if (!menuTheme) {
      menuTheme = { ...theme, button: { ...theme.button, radius: 0 } };
      menuThemes.set(theme, menuTheme);
    }
    const menuItem = (id, title, callback, bold = false) => {
      const node = desktopCommand(id, title, menuTheme, callback, { quiet: true, style: {
        height: theme.layout.menuBarHeight, paddingLeft: 9, paddingRight: 9,
        borderWidth: 0, borderRadius: 0, backgroundColor: 'transparent',
        gradientFrom: 'transparent', gradientTo: 'transparent' } });
      node.children.at(-1).props.style.fontWeight = bold ? 700 : 400;
      return node;
    };
    return h('view', { id: 'shell-panel', role: 'menubar', style: { ...row, width: '100%', height: '100%',
      paddingLeft: theme.layout.panelPaddingLeft, paddingRight: theme.layout.panelPaddingRight,
      backgroundColor: theme.window.titleFrom, gradientFrom: theme.window.titleFrom,
      gradientTo: theme.window.titleTo, borderBottomWidth: 1, borderColor: '#9a9a9a' } },
    menuItem('shell-menu', 'Polly', openMenu, true),
    menuItem('shell-panel-settings', 'Settings', openSettings),
    workspace ? menuItem('shell-workspaces', workspace.name, workspace.open) : null,
    h('view', { style: { flexGrow: 1 } }),
    error ? label('Needs attention', panel.text, 11) : null,
    tray?.items.length || tray?.error ? trayView(theme, tray.items, tray.activate, tray.scroll, tray.error) : null,
    notifications ? menuItem('shell-notifications', 'Notifications ' + notifications.count, notifications.open) : null,
    h('view', { id: 'shell-clock', style: { color: theme.colors.text, fontSize: theme.layout.fontSize,
      paddingLeft: 8 } }, clock));
  }
  return h('view', { id: 'shell-panel', style: {
    ...row, width: '100%', height: '100%', gap: theme.layout.panelGap,
    paddingLeft: theme.layout.panelPaddingLeft, paddingRight: theme.layout.panelPaddingRight,
    ...gradient(panel.from, panel.to), borderWidth: theme.layout.borderWidth, borderColor: theme.colors.light,
  } },
  button('shell-menu', 'Polly', theme, openMenu, false, {
    height: panel.kind === 'dock' ? theme.layout.compactButtonHeight : theme.layout.buttonHeight,
    ...gradient(panel.launcherFrom, panel.launcherTo),
  }),
  button('shell-panel-settings', 'Settings', theme, openSettings, false, { height: theme.layout.compactButtonHeight }),
  workspace ? button('shell-workspaces', Array.from(workspace.name).slice(0, theme.layout.workspaceTitleLimit).join(''),
    theme, workspace.open, false, { height: theme.layout.compactButtonHeight, maxWidth: theme.layout.workspaceWidth, overflow: 'hidden' }) :
    label('PollyDesktop', panel.text, 12),
  panel.kind === 'taskbar' ? windowButtons(theme, windows, toggle, actions, false, images) :
    h('view', { style: { flexGrow: 1 } }),
  error ? label('Desktop needs attention', panel.text, 11) : null,
  tray?.items.length || tray?.error ? trayView(theme, tray.items, tray.activate, tray.scroll, tray.error) : null,
  notifications ? button('shell-notifications', 'Notifications ' + notifications.count, theme,
    notifications.open, false, { height: theme.layout.compactButtonHeight }) : null,
  label(clock, panel.text, 12));
}

export function dockView(theme, openSettings, openAbout, openApplications = openSettings,
  windows = [], toggle = () => {}, actions = () => {}, images = null) {
  const panel = theme.panel;
  const style = surfaceStyle(theme, 'panel');
  if (['tiger', 'lion', 'bigsur'].includes(style)) {
    const iconSize = theme.layout.dockIconSize ?? 48, indicator = theme.layout.dockIndicatorSize ?? 4;
    const slot = (id, title, icon, action, running = false, window = null) => {
      const node = h('view', { id, role: 'button', tabIndex: 0, 'aria-label': title,
        ...(window?.grouped ? { 'aria-pressed': String(!!window.active) } : {}),
        style: { ...center, position: 'relative', width: window ? theme.layout.dockWindowWidth : theme.layout.dockTileWidth,
          height: panel.height - 4, flexShrink: 0, paddingBottom: 8, borderWidth: 0 },
        hoverStyle: { backgroundColor: '#ffffff18', borderRadius: 5 },
        focusStyle: { borderWidth: 1, borderColor: theme.colors.focus },
        onFocus: revealDockSlot,
        onClick: event => {
          if (event.button === 0) { event.stopPropagation(); return action(); }
          return false;
        },
        onKeydown: event => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); action(); }
          else if (window && (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) {
            event.preventDefault(); actions(window.id);
          }
        },
        onContextmenu: window ? event => { event.preventDefault(); event.stopPropagation(); actions(window.id); } : undefined,
      }, h('view', { style: { ...center, width: iconSize, height: iconSize,
        borderRadius: theme.icons.radius, backgroundColor: theme.icons.dockTiles ? '#ffffff' : 'transparent',
        pointerEvents: 'none' } }, taskArtwork(window, images, iconSize - 8,
          desktopIcon(icon, theme.colors.accent, iconSize - 8))),
      window?.grouped && window.count > 1 ? h('view', { 'aria-hidden': 'true', style: {
        position: 'absolute', right: 1, top: 1, minWidth: 14, height: 16, borderRadius: 4,
        paddingLeft: 3, paddingRight: 3, backgroundColor: theme.colors.accent,
        color: theme.colors.accentText, fontSize: theme.layout.smallFontSize,
        pointerEvents: 'none' } }, String(window.count)) : null,
      running ? style === 'tiger' ? h('view', { 'aria-hidden': 'true', style: {
        position: 'absolute', bottom: 1, width: indicator, height: 4, pointerEvents: 'none' } },
        Array.from({ length: 4 }, (_, y) => {
          // Integer insets keep even and very narrow indicators symmetric without blurred edges.
          const inset = Math.min(Math.floor((indicator - 1) / 2), Math.round((3 - y) * (indicator - 1) / 6));
          return h('view', { style: { position: 'absolute',
            top: y, left: inset, width: indicator - 2 * inset, height: 1,
            backgroundColor: '#111111', pointerEvents: 'none' } });
        })) :
        h('view', { 'aria-hidden': 'true', style: { position: 'absolute', bottom: 1,
          width: indicator, height: style === 'lion' ? 3 : indicator, borderRadius: indicator,
          backgroundColor: style === 'lion' ? '#bde8ff' : '#303030', pointerEvents: 'none',
          ...(style === 'lion' ? { borderWidth: 1, borderColor: '#e4f7ff' } : {}) } }) : null);
      return window ? guardTaskGesture(node, taskIdentity(window)) : node;
    };
    const shelf = style === 'lion' ? h('view', { 'aria-hidden': 'true', style: {
      position: 'absolute', left: 0, right: 0, bottom: 0, height: 28, pointerEvents: 'none' } },
      Array.from({ length: 24 }, (_, y) => h('view', { style: {
        position: 'absolute', top: y, left: 12 - y / 2, right: 12 - y / 2,
        height: 1, backgroundColor: y === 0 ? '#eeeeee' : y < 12 ? panel.from : '#999999', pointerEvents: 'none' } })),
      h('view', { style: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 4,
        backgroundColor: panel.to, borderTopWidth: 1, borderColor: '#d6d6d6', pointerEvents: 'none' } })) : null;
    return h('view', { id: 'shell-dock-viewport', style: {
      width: '100%', height: '100%', overflow: 'visible' },
      onWheel: scrollDock, onMount: syncDockLayout, onUpdate: syncDockLayout },
    h('view', { id: 'shell-dock', style: { ...row, position: 'relative',
      width: '100%', minWidth: dockSurfaceWidth(theme, windows.length ? 1 : 0, Infinity),
      height: '100%', flexShrink: 0, alignItems: 'flex-end', justifyContent: 'center',
      paddingLeft: theme.layout.dockPadding ?? 6, paddingRight: theme.layout.dockPadding ?? 6,
      gap: theme.layout.dockGap, overflow: 'hidden', borderRadius: panel.radius,
      ...(style === 'lion' ? { backgroundColor: 'transparent' } : {
        ...gradient(panel.from, panel.to), borderWidth: 1, borderColor: style === 'tiger' ? '#eeeeee' : '#bdbdbd' }) } },
      shelf,
      slot('shell-dock-applications', 'Applications', 'apps', openApplications),
      slot('shell-dock-settings', 'Settings', 'appearance', openSettings),
      slot('shell-dock-about', 'About PollyDesktop', 'info', openAbout),
      windows.length ? h('view', { id: 'shell-dock-separator', style: { width: 1, height: 43,
        backgroundColor: style === 'lion' ? '#707070' : '#a0a0a0', marginLeft: 6, marginRight: 6,
        marginBottom: 8, flexShrink: 0, pointerEvents: 'none' } }) : null,
      windows.length ? h('view', { id: 'shell-dock-windows', style: {
        ...row, flexGrow: 1, flexBasis: 0, minWidth: 0, height: panel.height - 4,
        gap: theme.layout.dockGap, overflow: 'scroll',
      }, onWheel: scrollDock },
      windows.map(window => slot('shell-window-' + window.id, taskLabel(window),
        'file', () => toggle(window.id), true, window))) : null));
  }
  const tile = { height: panel.height - theme.layout.panelItemInset, width: theme.layout.dockTileWidth,
    borderRadius: theme.icons.dockTiles ? theme.icons.radius : theme.button.radius };
  return h('view', { id: 'shell-dock', style: {
    ...row, justifyContent: 'center', width: '100%', height: '100%', gap: theme.layout.dockGap,
    borderWidth: theme.layout.borderWidth, borderColor: theme.colors.light, borderRadius: panel.radius,
    ...gradient(panel.from, panel.to),
  } },
  button('shell-dock-applications', 'Apps', theme, openApplications, false, tile),
  button('shell-dock-settings', 'Settings', theme, openSettings, false, tile),
  button('shell-dock-about', 'About', theme, openAbout, false, tile),
  windows.length ? windowButtons(theme, windows, toggle, actions, true, images) : null);
}

export function applicationsView(theme, entries, query, changeQuery, launch, refresh, close, error = '',
  logout = null, desktop = null, programs = null, images = null, searchInput = null) {
  if (theme.panel.menuStyle || ['luna', 'classic', 'fluent'].includes(surfaceStyle(theme, 'panel')))
    return startMenuView(theme, entries, query, changeQuery, launch, refresh, close, error, logout, desktop, programs, images, searchInput);
  const label = labelFor(theme);
  const filtered = entries.filter(entry =>
    (entry.name + ' ' + (entry.genericName || '') + ' ' + entry.comment + ' ' +
      entry.keywords.join(' ')).toLowerCase().includes(query.toLowerCase()));
  const appCommand = entry => {
    const node = desktopCommand('shell-app-' + entry.id, entry.name, theme, () => launch(entry.id),
      { icon: entry.id === 'org.pollyui.settings' ? 'appearance' : entry.id.includes('files') ? 'folder' : 'apps',
        quiet: true, style: { height: 54, paddingLeft: 16, flexGrow: 1, flexBasis: 0, minWidth: 0 } });
    const art = node.children.find(child => child.props?.className === 'theme-command-icon');
    const image = images?.get(entry.id);
    if (image && art) node.children[node.children.indexOf(art)] = h('view', {
      'aria-hidden': 'true', style: { ...art.props.style, backgroundImage: image },
    });
    return node;
  };
  return h('view', { id: 'shell-applications', style: {
    width: '100%', height: '100%', padding: theme.layout.compactPadding, gap: theme.layout.contentGap, backgroundColor: theme.colors.body,
    borderWidth: theme.layout.borderWidth, borderColor: theme.colors.border,
    borderRadius: isLuna(theme) ? 0 : theme.window.radius,
  } },
  h('view', { style: { ...row, gap: theme.layout.contentGap,
    ...(isLuna(theme) ? { padding: 6, ...gradient(theme.window.titleFrom, theme.window.titleTo) } : {}) } },
    label('Applications', isLuna(theme) ? theme.window.titleText : theme.colors.text, 16),
    h('view', { style: { flexGrow: 1 } }), button('shell-app-refresh', 'Refresh', theme, refresh),
    button('shell-app-close', 'Close', theme, close)),
  searchInput ? searchInput({
    style: { height: theme.layout.choiceHeight + 2 * theme.layout.borderWidth, flexShrink: 0, minWidth: 0 },
    placeholder: 'Type to search...',
    submit: () => { const first = filtered.find(entry => !entry.unavailable); if (first) launch(first.id); },
  }) : h('view', { id: 'shell-app-search', role: 'textbox', 'aria-label': 'Search applications', tabIndex: 0,
    style: { padding: theme.layout.serviceButtonPadding, height: theme.layout.choiceHeight + 2 * theme.layout.borderWidth, flexShrink: 0, backgroundColor: theme.colors.surface,
      borderWidth: theme.layout.borderWidth, borderColor: theme.colors.border,
      borderRadius: isLuna(theme) ? 0 : theme.button.radius },
    focusStyle: { borderColor: theme.colors.accent },
    onTextinput: event => changeQuery(Array.from(query + event.data).slice(0, 128).join('')),
    onKeydown: event => {
      if (event.key === 'Backspace') { event.preventDefault(); changeQuery(Array.from(query).slice(0, -1).join('')); }
      if (event.key === 'Enter' && !event.isComposing && filtered[0]) { event.preventDefault(); launch(filtered[0].id); }
    },
  }, label(query || 'Type to search...', query ? theme.colors.text : theme.colors.muted)),
  h('view', { style: { flexGrow: 1, flexBasis: 0, minHeight: 0, overflow: 'scroll', gap: theme.layout.windowGap } },
    filtered.slice(0, 100).map(entry => entry.unavailable
      ? h('view', { id: 'shell-app-' + entry.id, 'aria-disabled': 'true', style: {
          padding: theme.layout.serviceButtonPadding, gap: theme.layout.contentGap / 2, opacity: theme.layout.disabledOpacity, flexShrink: 0,
        } }, label(entry.name, isLuna(theme) ? theme.colors.muted : theme.colors.text),
          label(entry.unavailable, theme.colors.muted, 10))
      : h('view', { style: { ...row, gap: 6, flexShrink: 0 } },
        appCommand(entry),
        desktop ? desktopCommand('shell-app-pin-' + entry.id, desktop.has(entry.id) ? 'Remove shortcut' : 'Add to desktop',
          theme, () => desktop.has(entry.id) ? desktop.remove(entry.id) : desktop.add(entry.id),
          { quiet: true, icon: desktop.has(entry.id) ? '' : 'add' }) : null)),
    !filtered.length ? label('No matching applications', theme.colors.muted) : null),
  filtered.length > 100 ? label('Showing 100 matches; refine the search.', theme.colors.muted, 10) : null,
  h('view', { style: { ...row, flexShrink: 0, borderTopWidth: 1, borderColor: theme.colors.border, paddingTop: 12, gap: 10 } },
    desktopText('Your applications', theme.colors.muted, 13), h('view', { style: { flexGrow: 1 } }),
    logout ? desktopCommand('shell-app-logout', 'Log out...', theme, logout, { quiet: true }) : null),
  error ? h('view', { role: 'alert', style: { padding: theme.layout.controlGap, backgroundColor: theme.colors.selection } },
    label(error, theme.colors.text, 11)) : null);
}

export function windowActionsView(theme, window, action, close, error = '', workspaces = [], move = () => {}) {
  const l = theme.layout;
  const label = (value, color, size = l.fontSize) => desktopText(value, color, size, { minWidth: 0 });
  return panelViewport(theme, { id: 'shell-window-actions', variant: 'menu' },
  label(window.title || window.appId || 'Untitled', theme.colors.text, l.headingFontSize),
  button('shell-window-activate', 'Activate', theme, () => action('activateWindow')),
  button('shell-window-minimize', window.minimized ? 'Restore' : 'Minimize', theme,
    () => action(window.minimized ? 'restoreWindow' : 'minimizeWindow')),
  button('shell-window-maximize', window.maximized ? 'Unmaximize' : 'Maximize', theme,
    () => action(window.maximized ? 'unmaximizeWindow' : 'maximizeWindow')),
  button('shell-window-fullscreen', window.fullscreen ? 'Leave fullscreen' : 'Fullscreen', theme,
    () => action(window.fullscreen ? 'unfullscreenWindow' : 'fullscreenWindow')),
  button('shell-window-close', 'Close application window', theme, () => action('closeWindow')),
  workspaces.length > 1 ? label('Move window family to:', theme.colors.muted, l.statusFontSize) : null,
  workspaces.filter(workspace => workspace.id !== window.workspaceId).map(workspace =>
    button('shell-window-workspace-' + workspace.id, workspace.name, theme, () => move(workspace.id))),
  button('shell-window-menu-close', 'Close menu', theme, close),
  error ? label(error, theme.colors.text, l.statusFontSize) : null);
}

export function workspacesView(theme, workspaces, activate, remove, create, close, error = '', settings = null) {
  const l = theme.layout;
  const label = (value, color, size = l.fontSize) => desktopText(value, color, size, { minWidth: 0 });
  return panelViewport(theme, { id: 'shell-workspace-menu', variant: 'menu' },
  h('view', { style: { ...row, gap: l.controlGap, flexWrap: 'wrap', flexShrink: 0 } },
    label('Workspaces', theme.colors.text, l.headingFontSize),
    h('view', { style: { flexGrow: 1 } }), button('shell-workspace-add', 'Add', theme, create),
    button('shell-workspace-close', 'Close', theme, close)),
  label('All displays switch together. Empty workspaces stay.', theme.colors.muted, l.statusFontSize),
  h('view', { style: { gap: l.controlGap, flexShrink: 0, minWidth: 0,
    display: settings?.editor ? 'flex' : 'none' } },
    settings?.editor ? [
    h('view', { style: { height: Number(settings.editor.input.root.style.height), flexShrink: 0, minWidth: 0 },
      onMount: node => node.appendChild(settings.editor.input.root) }),
    h('view', { style: { ...row, gap: l.controlGap, flexWrap: 'wrap', flexShrink: 0 } },
      button('shell-workspace-name-save', 'Save name', theme, settings.save),
      button('shell-workspace-name-cancel', 'Cancel', theme, settings.cancel))] : []),
  h('view', { style: { flexShrink: 0, minWidth: 0, gap: l.controlGap } },
    workspaces.map((workspace, index) => h('view', { key: workspace.id,
      style: { gap: l.controlGap, flexShrink: 0, minWidth: 0 } },
      h('view', { style: { ...row, gap: l.controlGap, flexWrap: 'wrap', flexShrink: 0 } },
      button('shell-workspace-' + workspace.id, workspace.name, theme, () => activate(workspace.id),
        workspace.active, { flexGrow: 1, flexBasis: 0, minWidth: 0, overflow: 'hidden' }),
      workspace.canRemove ? button('shell-workspace-remove-' + workspace.id, 'Remove', theme,
        () => remove(workspace.id)) : label('Last workspace', theme.colors.muted, l.statusFontSize)),
      settings ? h('view', { style: { ...row, gap: l.controlGap, flexWrap: 'wrap', flexShrink: 0 } },
        button('shell-workspace-rename-' + workspace.id, 'Rename', theme, () => settings.rename(workspace.id),
          false, { height: theme.layout.compactButtonHeight }),
        index ? button('shell-workspace-earlier-' + workspace.id, 'Earlier', theme,
          () => settings.reorder(workspace.id, index - 1), false, { height: theme.layout.compactButtonHeight }) : null,
        index + 1 < workspaces.length ? button('shell-workspace-later-' + workspace.id, 'Later', theme,
          () => settings.reorder(workspace.id, index + 1), false, { height: theme.layout.compactButtonHeight }) : null) : null))),
  label('Removing a workspace moves its windows, not closes them.', theme.colors.muted, l.statusFontSize),
  label('Ctrl+Super+Left/Right switches workspaces.', theme.colors.muted, l.statusFontSize),
  settings && error ? button('shell-workspace-save-current', 'Save current layout', theme, settings.saveCurrent) : null,
  error ? label(error, theme.colors.text, l.statusFontSize) : null);
}

export function switcherView(theme, snapshot, accept, rows = theme.layout.switcherMaxRows) {
  const l = theme.layout;
  const label = (value, color, size = l.fontSize) => desktopText(value, color, size, { minWidth: 0 });
  const start = Math.max(0, Math.min(snapshot.items.length - rows, snapshot.selected - Math.floor(rows / 2)));
  return panelViewport(theme, { id: 'shell-window-switcher' },
  label('Switch windows  ' + (snapshot.selected + 1) + ' / ' + snapshot.items.length,
    theme.colors.text, l.headingFontSize),
  snapshot.items.slice(start, start + rows).map((item, offset) =>
    button('shell-switcher-item-' + (start + offset), item.title || item.appId || 'Untitled', theme,
      () => accept(snapshot.serial, start + offset), snapshot.selected === start + offset,
      { height: theme.layout.choiceHeight, alignItems: 'flex-start', overflow: 'hidden' })),
  label('Release shortcut modifiers to activate. Esc cancels.', theme.colors.muted, l.statusFontSize));
}

export function displayConfirmationView(theme, remaining, keep, revert) {
  const label = labelFor(theme);
  return panelViewport(theme, { id: 'shell-output-confirmation' },
  label('Keep these display settings?', theme.colors.text, 15),
  label('Reverting in ' + Math.ceil(remaining / 1000) + ' seconds.', theme.colors.muted, 12),
  h('view', { style: { ...row, gap: theme.layout.compactPadding, flexWrap: 'wrap', flexShrink: 0 } },
    button('shell-output-keep', 'Keep', theme, keep, false, {}, { defaultAction: true }),
    button('shell-output-revert', 'Revert', theme, revert)),
  label('Enter keeps changes. Escape reverts.', theme.colors.muted, 10));
}
