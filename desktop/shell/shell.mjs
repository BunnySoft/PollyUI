import { render } from './js/reconciler.mjs';
import { DEFAULT_DESKTOP_THEME, getDesktopTheme } from './desktop/shell/themes.mjs';
import { wallpaper, panelView, dockView, settingsView, applicationsView, windowActionsView, workspacesView, shortcutsView, switcherView, displaysView, displayConfirmationView } from './desktop/shell/views.mjs';
import { createApplicationLauncher } from './desktop/shell/applications.mjs';
import { SHORTCUTS_KEY, saveShortcuts, shortcutFromEvent } from './desktop/shell/shortcuts.mjs';
import { readDisplayDraft } from './desktop/shell/displays.mjs';
import { createNotificationSurfaces } from './desktop/shell/notifications.mjs';
import { createTray } from './desktop/shell/tray.mjs';
import { createNetworkSettings } from './desktop/shell/network.mjs';

export const SHELL_THEME_KEY = 'desktop.theme';

export function createDesktopShell({ host = window, storage = localStorage, report = console.error,
  native = typeof desktop === 'undefined' ? null : desktop } = {}) {
  const bundles = new Map();
  let themeId = DEFAULT_DESKTOP_THEME;
  let error = '';
  let errorKind = '';
  let timer = null;
  let menu = null;
  let switcher = null;
  let displayConfirmation = null;
  let pendingDisplayToken = 0;
  let previousOutputsChanged = null, lastOutputMessage = '';
  const outputsChanged = () => {
    if (!running) return;
    updateOutputs();
    if (typeof previousOutputsChanged === 'function') previousOutputsChanged();
  };
  let shortcutBindings = [];
  let recordingShortcut = null;
  let previousShortcutsChanged = null, previousSwitcherChanged = null;
  const shortcutsChanged = () => {
    if (!running) return;
    try { shortcutBindings = native.shortcuts(); repaintMenu(); }
    catch (failure) { shortcutFailure(failure); }
    if (typeof previousShortcutsChanged === 'function') previousShortcutsChanged();
  };
  const switcherChanged = () => {
    if (!running) return;
    paintSwitcher();
    if (typeof previousSwitcherChanged === 'function') previousSwitcherChanged();
  };
  let running = false;
  let lastFailure = '';
  let applications = [];
  let windows = [];
  let workspaces = [];
  let previousWorkspacesChanged = null;
  const workspacesChanged = () => {
    if (!running) return;
    refreshWindows();
    if (typeof previousWorkspacesChanged === 'function') previousWorkspacesChanged();
  };
  let compositorAppearance = null;
  let previousWindowsChanged = null;
  const windowsChanged = () => {
    if (!running) return;
    refreshWindows();
    if (typeof previousWindowsChanged === 'function') previousWindowsChanged();
  };
  const launcher = native ? createApplicationLauncher(native, report) : null;
  const notifications = createNotificationSurfaces({ host, native, theme: () => getDesktopTheme(themeId), report,
    changed: () => { for (const bundle of bundles.values()) paint(bundle, getDesktopTheme(themeId)); } });
  const tray = createTray({ native, report, host, theme: () => getDesktopTheme(themeId),
    changed: () => { for (const bundle of bundles.values()) paint(bundle, getDesktopTheme(themeId)); } });
  const network = createNetworkSettings({ native, report, host, theme: () => getDesktopTheme(themeId) });
  let previousExit = null;
  const exited = event => {
    if (!running) return;
    if (event.status) {
      error = 'Application exited: ' + event.id + ' (' + event.status + ')';
      errorKind = 'application';
      report('[shell] ' + error);
      repaintMenu();
      for (const bundle of bundles.values()) paint(bundle, getDesktopTheme(themeId));
    }
    if (typeof previousExit === 'function') previousExit(event);
  };
  const stored = storage.getItem(SHELL_THEME_KEY);
  if (stored !== null) {
    try { getDesktopTheme(stored); themeId = stored; }
    catch (failure) {
      error = 'Saved appearance is unavailable; using ' + DEFAULT_DESKTOP_THEME + '.';
      errorKind = 'settings';
      report('[shell] ' + error + ' ' + String(failure));
    }
  }

  function clock() {
    const date = new Date();
    return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
  }

  function closeSurface(surface) {
    if (!surface) return;
    surface.expectedClose = true;
    surface.window.close();
  }

  function closeMenu() {
    if (!menu) return;
    stopRecording();
    const old = menu;
    menu = null;
    closeSurface(old);
  }

  function newSurface(output, kind, options) {
    const native = host.create({ title: `PollyShell.${kind}.${output.id}`, output: output.id, ...options });
    const surface = { output: output.id, kind, window: native, signature: JSON.stringify(options), expectedClose: false };
    native.onclose = () => {
      if (surface === menu) { stopRecording(); menu = null; }
      if (surface === switcher) {
        switcher = null;
        if (!surface.expectedClose && running) {
          try { native.cancelWindowSwitch(); } catch (failure) { shortcutFailure(failure); }
        }
        if (surface === displayConfirmation) {
          displayConfirmation = null;
          if (!surface.expectedClose && running) {
            try {
              if (native.outputConfiguration().pendingToken === surface.token) native.revertOutputConfiguration(surface.token);
            } catch (failure) { outputFailure(failure); }
          }
        }
      }
      if (!surface.expectedClose && running && kind !== 'settings') {
        lastFailure = '';
      }
    };
    return surface;
  }

  function visibleWindows() {
    if (typeof native?.workspaces !== 'function') return windows;
    const current = workspaces.find(workspace => workspace.active);
    return windows.filter(window => window.workspaceId === current?.id);
  }

  function definitions(theme, output) {
    const dock = theme.panel.kind === 'dock';
    const result = {
      wallpaper: { layer: 'background', width: 0, height: 0,
        anchors: ['top', 'bottom', 'left', 'right'], exclusiveZone: -1 },
      panel: { layer: 'top', width: 0, height: dock ? 26 : theme.panel.height,
        anchors: [dock ? 'top' : 'bottom', 'left', 'right'], exclusiveZone: dock ? 26 : theme.panel.height },
    };
    if (dock) result.dock = {
      layer: 'top', width: Math.max(1, Math.min(320 + visibleWindows().length * 69, output.width - 16)), height: theme.panel.height,
      anchors: ['bottom'], margins: { bottom: theme.panel.inset }, exclusiveZone: theme.panel.height,
      transparent: true,
    };
    return result;
  }

  function paint(bundle, theme) {
    const { wallpaper: background, panel, dock } = bundle.surfaces;
    const listed = visibleWindows();
    const current = workspaces.find(workspace => workspace.active);
    const workspaceControl = typeof native?.workspaces === 'function' ? {
      name: current?.name || 'Workspaces', open: () => showWorkspaces(bundle.output.id),
    } : null;
    if (!background.window.closed) render(wallpaper(theme, 'shell-wallpaper'), background.window.document.body);
    if (!panel.window.closed) render(panelView(theme, clock(), () => showApplications(bundle.output.id),
      error, () => showSettings(bundle.output.id), listed, toggleWindow,
      id => showWindowActions(bundle.output.id, id), workspaceControl,
      notifications.count() ? { count: notifications.count(), open: notifications.show } : null,
      { items: tray.items(), activate: (item, kind, x, y) => tray.activate(item, kind,
        x + bundle.output.x, y + bundle.output.y + (theme.panel.kind === 'taskbar' ?
          bundle.output.height - theme.panel.height : 0)), scroll: tray.scroll }),
      panel.window.document.body);
    if (dock && !dock.window.closed) render(dockView(theme, () => showSettings(bundle.output.id),
      () => showSettings(bundle.output.id, true), () => showApplications(bundle.output.id), listed, toggleWindow,
      id => showWindowActions(bundle.output.id, id)), dock.window.document.body);
    for (const surface of [panel, dock]) {
      if (!surface || surface.window.closed) continue;
      const body = surface.window.document.body;
      const signature = body.offsetWidth + ':' + current?.id + ':' + listed.map(window => window.id).join(',');
      if (surface.windowListSignature !== signature) {
        const list = body.firstChild?.childNodes.find(node => node.id === 'shell-window-list');
        if (list) list.scrollLeft = 0;
        surface.windowListSignature = signature;
      }
    }
  }

  function reconcile(nextTheme, persist) {
    const theme = getDesktopTheme(nextTheme);
    const outputs = host.displays();
    const staged = [];
    const plans = [];
    let previousStored, saved = false;
    try {
      for (const output of outputs) {
        const previous = bundles.get(output.id);
        const surfaces = {};
        for (const [kind, options] of Object.entries(definitions(theme, output))) {
          const old = previous?.surfaces[kind];
          if (old && !old.window.closed && old.signature === JSON.stringify(options)) surfaces[kind] = old;
          else {
            surfaces[kind] = newSurface(output, kind, options);
            staged.push(surfaces[kind]);
          }
        }
        plans.push({ output, surfaces });
      }
      if (persist) {
        previousStored = storage.getItem(SHELL_THEME_KEY);
        storage.setItem(SHELL_THEME_KEY, nextTheme);
        saved = true;
      }
      if (typeof native?.setAppearance === 'function' && compositorAppearance !== nextTheme) {
        native.setAppearance(nextTheme);
        compositorAppearance = nextTheme;
      }
    } catch (failure) {
      for (const surface of staged) closeSurface(surface);
      if (saved) {
        try {
          if (previousStored === null) storage.removeItem(SHELL_THEME_KEY);
          else storage.setItem(SHELL_THEME_KEY, previousStored);
        } catch (rollback) {
          throw new Error(String(failure) + '; could not restore saved appearance: ' + String(rollback));
        }
      }
      throw failure;
    }
    const retained = new Set(plans.flatMap(plan => Object.values(plan.surfaces)));
    for (const bundle of bundles.values())
      for (const surface of Object.values(bundle.surfaces)) if (!retained.has(surface)) closeSurface(surface);
    bundles.clear();
    themeId = nextTheme;
    for (const plan of plans) { bundles.set(plan.output.id, plan); paint(plan, theme); }
    lastFailure = '';
  }

  function selectTheme(id) {
    if (!running) throw new Error('Shell is not running');
    getDesktopTheme(id);
    try {
      reconcile(id, true);
      error = '';
      errorKind = '';
      closeMenu();
      for (const bundle of bundles.values()) paint(bundle, getDesktopTheme(themeId));
      return true;
    } catch (failure) {
      error = 'Could not apply/save appearance: ' + String(failure);
      errorKind = 'settings';
      report('[shell] ' + error);
      repaintMenu();
      return false;
    }
  }

  function repaintMenu() {
    if (!menu || menu.window.closed) return;
    if (menu.mode === 'displays') {
      const current = menu;
      render(displaysView(getDesktopTheme(themeId), current.window.document, current.displayDraft,
        current.displayInputs, repaintMenu, () => applyDisplays(current), closeMenu, error), current.window.document.body);
      return;
    }
    if (menu.mode === 'shortcuts') {
      render(shortcutsView(getDesktopTheme(themeId), shortcutBindings, recordingShortcut, beginRecording,
        action => applyShortcuts(shortcutBindings.map(binding => binding.action === action ?
          { ...binding, modifiers: 0, key: '' } : binding)),
        () => applyShortcuts(native.shortcutDefaults()), closeMenu, error), menu.window.document.body);
      return;
    }
    if (menu.mode === 'workspaces') {
      render(workspacesView(getDesktopTheme(themeId), workspaces,
        id => workspaceAction('activateWorkspace', id), id => workspaceAction('removeWorkspace', id),
        () => workspaceAction('createWorkspace'), closeMenu, error), menu.window.document.body);
      return;
    }
    if (menu.mode === 'windows') {
      const selected = visibleWindows().find(window => window.id === menu.windowId);
      if (!selected) { closeMenu(); return; }
      render(windowActionsView(getDesktopTheme(themeId), selected,
        action => windowAction(selected.id, action), closeMenu, error, workspaces,
        id => moveWindow(selected.id, id)), menu.window.document.body);
      return;
    }
    if (menu.mode === 'applications') {
      render(applicationsView(getDesktopTheme(themeId), applications, menu.query,
        value => { if (menu) { menu.query = value; repaintMenu(); } },
        launchApplication, reloadApplications, closeMenu, error), menu.window.document.body);
      return;
    }
    render(settingsView(getDesktopTheme(themeId), selectTheme, closeMenu, () => refresh(true),
      error, menu.about, typeof native?.shortcuts === 'function' ? () => showShortcuts(menu.output) : null,
      typeof native?.outputConfiguration === 'function' ? () => showDisplays(menu.output) : null,
      typeof native?.startNetwork === 'function' ? () => showNetwork(menu.output) : null),
      menu.window.document.body);
  }

  function openMenu(outputId, mode, windowId = null, initial = null) {
    if (!running) throw new Error('Shell is not running');
    const bundle = bundles.get(outputId);
    if (!bundle) throw new RangeError('Unknown shell output');
    if (menu && menu.output === outputId && menu.mode === mode && menu.windowId === windowId) {
      closeMenu(); return null;
    }
    closeMenu();
    const theme = getDesktopTheme(themeId);
    const root = bundle.surfaces.wallpaper.window.document.body;
    const width = root.offsetWidth || bundle.output.width;
    const height = root.offsetHeight || bundle.output.height;
    const mac = theme.panel.kind === 'dock';
    try {
      menu = newSurface(bundle.output, 'settings', {
        layer: 'overlay', width: Math.max(1, Math.min(340, width - 16)),
        height: Math.max(1, Math.min(390, height - theme.panel.height - 24)),
        anchors: [mac ? 'top' : 'bottom', 'left'],
        margins: { left: 8, [mac ? 'top' : 'bottom']: mac ? 30 : theme.panel.height + 6 },
        keyboard: 'exclusive', transparent: true,
      });
    } catch (failure) {
      error = 'Could not open settings: ' + String(failure);
      errorKind = 'settings';
      report('[shell] ' + error);
      for (const current of bundles.values()) paint(current, theme);
      return null;
    }
    menu.mode = mode;
    if (initial) Object.assign(menu, initial);
    menu.windowId = windowId;
    menu.about = mode === 'about';
    menu.query = '';
    const body = menu.window.document.body;
    body.tabIndex = 0;
    body.addEventListener('keydown', event => {
      if (recordingShortcut) {
        event.preventDefault(); event.stopPropagation();
        if (event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
          stopRecording(); repaintMenu(); return;
        }
        const binding = shortcutFromEvent(event);
        if (binding) {
          const action = recordingShortcut;
          stopRecording();
          applyShortcuts(shortcutBindings.map(item => item.action === action ? { ...item, ...binding } : item));
        }
        return;
      }
      if (event.key === 'Escape') { event.preventDefault(); closeMenu(); }
    });
    body.focus();
    repaintMenu();
    if (mode === 'applications') menu.window.document.getElementById('shell-app-search').focus();
    return menu.window;
  }

  function showSettings(outputId, about = false) {
    return openMenu(outputId, about ? 'about' : 'appearance');
  }

  function shortcutFailure(failure) {
    error = 'Shortcut settings: ' + String(failure);
    errorKind = 'shortcuts';
    report('[shell] ' + error);
    repaintMenu();
    for (const bundle of bundles.values()) paint(bundle, getDesktopTheme(themeId));
  }

  function showShortcuts(outputId) {
    shortcutBindings = native.shortcuts();
    return openMenu(outputId, 'shortcuts');
  }

  function stopRecording() {
    if (!recordingShortcut) return;
    recordingShortcut = null;
    try { native.captureShortcuts(false); }
    catch (failure) { report('[shell] Cannot end shortcut recording: ' + String(failure)); }
  }

  function beginRecording(action) {
    try {
      native.captureShortcuts(true);
      recordingShortcut = action;
      repaintMenu();
      menu.window.document.body.focus();
    } catch (failure) { shortcutFailure(failure); }
  }

  function applyShortcuts(bindings) {
    stopRecording();
    try {
      shortcutBindings = saveShortcuts(native, storage, bindings);
      if (errorKind === 'shortcuts') { error = ''; errorKind = ''; }
      repaintMenu();
      return true;
    } catch (failure) {
      try { shortcutBindings = native.shortcuts(); }
      catch (refreshFailure) { report('[shell] Cannot refresh shortcuts: ' + String(refreshFailure)); }
      shortcutFailure(failure);
      return false;
    }
  }

  function paintSwitcher() {
    try {
      const snapshot = native.windowSwitcher();
      if (!snapshot.active) { closeSurface(switcher); switcher = null; return; }
      const output = host.displays()[0];
      if (!output) throw new Error('No display is available for the window switcher');
      const height = Math.max(1, Math.min(360, output.height - 32));
      if (!switcher || switcher.window.closed) switcher = newSurface(output, 'switcher', {
        layer: 'overlay', width: Math.max(1, Math.min(620, output.width - 32)), height,
        anchors: [], exclusiveZone: -1, keyboard: 'none', transparent: true,
      });
      render(switcherView(getDesktopTheme(themeId), snapshot, (serial, index) => {
        try { native.acceptWindowSwitch(serial, index); } catch (failure) { shortcutFailure(failure); }
      }, Math.max(1, Math.min(7, Math.floor((height - 70) / 38)))), switcher.window.document.body);
    } catch (failure) {
      closeSurface(switcher); switcher = null;
      try { native.cancelWindowSwitch(); } catch (cancelFailure) { report('[shell] Cannot cancel switcher: ' + String(cancelFailure)); }
      shortcutFailure(failure);
    }
  }

  function startShortcuts() {
    if (typeof native?.shortcuts !== 'function') return;
    previousShortcutsChanged = native.onShortcutsChanged;
    previousSwitcherChanged = native.onWindowSwitcherChanged;
    native.onShortcutsChanged = shortcutsChanged;
    native.onWindowSwitcherChanged = switcherChanged;
    try {
      shortcutBindings = native.shortcuts();
      const stored = storage.getItem(SHORTCUTS_KEY);
      if (stored !== null) { native.setShortcuts(JSON.parse(stored)); shortcutBindings = native.shortcuts(); }
    } catch (failure) { shortcutFailure(failure); }
    try { native.enableWindowSwitcher(true); }
    catch (failure) { shortcutFailure(failure); }
  }

  function outputFailure(failure) {
    error = 'Display settings: ' + String(failure);
    errorKind = 'outputs';
    report('[shell] ' + error);
    repaintMenu();
    for (const bundle of bundles.values()) paint(bundle, getDesktopTheme(themeId));
  }

  function showDisplays(outputId) {
    try {
      const snapshot = native.outputConfiguration();
      if (snapshot.pendingToken) { paintDisplayConfirmation(snapshot); return displayConfirmation?.window || null; }
      if (errorKind === 'outputs') { error = ''; errorKind = ''; }
      return openMenu(outputId, 'displays', null, {
        displayDraft: { serial: snapshot.serial, heads: snapshot.heads.map(head => ({ ...head })) },
        displayInputs: new Map(),
      });
    } catch (failure) { outputFailure(failure); return null; }
  }

  function applyDisplays(source) {
    try {
      const draft = readDisplayDraft(source.displayDraft, source.displayInputs);
      native.applyOutputConfiguration(draft);
      if (errorKind === 'outputs') { error = ''; errorKind = ''; }
      closeMenu();
      updateOutputs();
    } catch (failure) { outputFailure(failure); }
  }

  function finishDisplayChange(token, keep) {
    try {
      if (keep) native.confirmOutputConfiguration(token);
      else native.revertOutputConfiguration(token);
      if (keep && errorKind === 'outputs') { error = ''; errorKind = ''; }
      updateOutputs();
    } catch (failure) { outputFailure(failure); }
  }

  function paintDisplayConfirmation(snapshot = native.outputConfiguration()) {
    pendingDisplayToken = snapshot.pendingToken;
    if (!snapshot.pendingToken) {
      closeSurface(displayConfirmation); displayConfirmation = null;
      return;
    }
    const output = host.displays()[0];
    if (!output) throw new Error('No display is available for confirmation; changes will revert automatically');
    const token = snapshot.pendingToken;
    if (!displayConfirmation || displayConfirmation.window.closed ||
        displayConfirmation.token !== token || displayConfirmation.output !== output.id) {
      closeSurface(displayConfirmation);
      displayConfirmation = newSurface(output, 'display-confirmation', {
        layer: 'overlay', width: Math.max(1, Math.min(360, output.width - 16)),
        height: Math.max(1, Math.min(190, output.height - 16)), anchors: [],
        exclusiveZone: -1, keyboard: 'exclusive', transparent: true,
      });
      displayConfirmation.token = token;
      const body = displayConfirmation.window.document.body;
      body.tabIndex = 0;
      body.addEventListener('keydown', event => {
        if (event.key === 'Escape' || event.key === 'Enter') {
          event.preventDefault(); finishDisplayChange(token, event.key === 'Enter');
        }
      });
      body.focus();
    }
    render(displayConfirmationView(getDesktopTheme(themeId), snapshot.remainingMs,
      () => finishDisplayChange(token, true), () => finishDisplayChange(token, false)),
      displayConfirmation.window.document.body);
  }

  function updateOutputs() {
    try {
      const snapshot = native.outputConfiguration();
      if (menu?.mode === 'displays' && !snapshot.pendingToken && menu.displayDraft.serial !== snapshot.serial) {
        closeMenu();
        outputFailure('Outputs changed; reopen display settings before applying.');
      }
      if (snapshot.message && snapshot.message !== lastOutputMessage) {
        if (snapshot.outcome === 3) outputFailure(snapshot.message);
        else console.log('[shell] ' + snapshot.message);
      }
      lastOutputMessage = snapshot.message;
      paintDisplayConfirmation(snapshot);
    } catch (failure) { outputFailure(failure); }
  }

  function windowFailure(failure) {
    error = 'Window management failed: ' + String(failure);
    errorKind = 'windows';
    report('[shell] ' + error);
    repaintMenu();
    for (const bundle of bundles.values()) paint(bundle, getDesktopTheme(themeId));
  }

  function refreshWindows() {
    try {
      const previous = workspaces.find(workspace => workspace.active)?.id;
      const nextWorkspaces = typeof native.workspaces === 'function' ?
        native.workspaces().sort((a, b) => a.order - b.order) : [];
      const nextWindows = native.windows().sort((a, b) => a.id - b.id);
      workspaces = nextWorkspaces;
      windows = nextWindows;
      if (previous && previous !== workspaces.find(workspace => workspace.active)?.id) closeMenu();
      if (errorKind === 'windows') { error = ''; errorKind = ''; }
      repaintMenu();
      refresh(true);
    } catch (failure) { windowFailure(failure); }
  }

  function windowAction(id, action) {
    try {
      native[action](id);
      if (!['closeWindow', 'minimizeWindow', 'activateWindow'].includes(action))
        native.activateWindow(id);
      closeMenu();
      return true;
    } catch (failure) { windowFailure(failure); return false; }
  }

  function toggleWindow(id) {
    try {
      const selected = native.windows().find(window => window.id === id);
      if (!selected) throw new Error('Window no longer exists');
      return windowAction(id, selected.active && !selected.minimized ? 'minimizeWindow' : 'activateWindow');
    } catch (failure) { windowFailure(failure); return false; }
  }

  function showWindowActions(outputId, id) {
    if (!windows.some(window => window.id === id)) throw new RangeError('Unknown window');
    return openMenu(outputId, 'windows', id);
  }

  function showWorkspaces(outputId) {
    if (typeof native?.workspaces !== 'function') throw new Error('Workspace management requires --desktop');
    return openMenu(outputId, 'workspaces');
  }

  function workspaceAction(action, id) {
    try {
      if (action === 'createWorkspace') native.createWorkspace();
      else native[action](id);
      if (action === 'activateWorkspace') closeMenu();
      return true;
    } catch (failure) { windowFailure(failure); return false; }
  }

  function moveWindow(id, workspaceId) {
    try {
      native.moveWindowToWorkspace(id, workspaceId);
      closeMenu();
      return true;
    } catch (failure) { windowFailure(failure); return false; }
  }

  function reloadApplications() {
    if (!launcher) throw new Error('Application launching requires --desktop');
    try {
      applications = launcher.refresh();
      if (errorKind === 'application') { error = ''; errorKind = ''; }
    } catch (failure) {
      error = 'Application discovery failed: ' + String(failure);
      errorKind = 'application';
      report('[shell] ' + error);
    }
    repaintMenu();
  }

  function showApplications(outputId) {
    if (!launcher) {
      error = 'Application launching requires a desktop-enabled build and --desktop';
      errorKind = 'application';
      report('[shell] ' + error);
      return openMenu(outputId, 'applications');
    }
    reloadApplications();
    return openMenu(outputId, 'applications');
  }

  function launchApplication(id) {
    if (!running || !launcher) throw new Error('Application launcher is unavailable');
    try {
      const pid = launcher.launch(id);
      if (errorKind === 'application') { error = ''; errorKind = ''; }
      closeMenu();
      return pid;
    } catch (failure) {
      error = 'Could not launch application: ' + String(failure);
      errorKind = 'application';
      report('[shell] ' + error);
      repaintMenu();
      return null;
    }
  }

  function showNetwork(output) {
    closeMenu();
    return network.show(output);
  }

  function refresh(force = false) {
    if (!running) return;
    notifications.paint();
    tray.paint();
    network.refresh();
    if (pendingDisplayToken) {
      try { paintDisplayConfirmation(); } catch (failure) { outputFailure(failure); }
    }
    let signature = '';
    try {
      const outputs = host.displays();
      signature = JSON.stringify([themeId, outputs]);
      if (!force && signature === lastFailure) {
        for (const bundle of bundles.values()) paint(bundle, getDesktopTheme(themeId));
        return;
      }
      if (menu && !outputs.some(output => output.id === menu.output)) closeMenu();
      reconcile(themeId, false);
      if (errorKind === 'display') {
        error = ''; errorKind = '';
        repaintMenu();
        for (const bundle of bundles.values()) paint(bundle, getDesktopTheme(themeId));
      }
    } catch (failure) {
      lastFailure = signature;
      error = 'Display setup failed: ' + String(failure);
      errorKind = 'display';
      report('[shell] ' + error);
      repaintMenu();
      for (const bundle of bundles.values()) paint(bundle, getDesktopTheme(themeId));
    }
  }

  return {
    start() {
      if (running) throw new Error('Shell is already running');
      host.close();
      running = true;
      try { reconcile(themeId, false); }
      catch (failure) { running = false; throw failure; }
      timer = setInterval(refresh, 1000);
      if (native) { previousExit = native.onExit; native.onExit = exited; }
      if (typeof native?.windows === 'function') {
        previousWindowsChanged = native.onWindowsChanged;
        native.onWindowsChanged = windowsChanged;
        previousWorkspacesChanged = native.onWorkspacesChanged;
        native.onWorkspacesChanged = workspacesChanged;
        refreshWindows();
      }
      startShortcuts();
      notifications.start();
      tray.start();
      if (typeof native?.outputConfiguration === 'function') {
        previousOutputsChanged = native.onOutputsChanged;
        native.onOutputsChanged = outputsChanged;
        updateOutputs();
      }
      return this;
    },
    stop() {
      running = false;
      notifications.stop();
      tray.stop();
      network.stop();
      if (timer !== null) clearInterval(timer);
      timer = null;
      if (native && native.onExit === exited) native.onExit = previousExit;
      if (native && native.onWindowsChanged === windowsChanged) native.onWindowsChanged = previousWindowsChanged;
      if (native && native.onWorkspacesChanged === workspacesChanged) native.onWorkspacesChanged = previousWorkspacesChanged;
      if (native && native.onShortcutsChanged === shortcutsChanged) native.onShortcutsChanged = previousShortcutsChanged;
      if (native && native.onWindowSwitcherChanged === switcherChanged) native.onWindowSwitcherChanged = previousSwitcherChanged;
      if (native && native.onOutputsChanged === outputsChanged) native.onOutputsChanged = previousOutputsChanged;
      if (typeof native?.outputConfiguration === 'function') {
        try {
          const token = native.outputConfiguration().pendingToken;
          if (token) native.revertOutputConfiguration(token);
        } catch (failure) { report('[shell] Cannot revert provisional displays on stop: ' + String(failure)); }
      }
      closeSurface(displayConfirmation); displayConfirmation = null;
      if (typeof native?.enableWindowSwitcher === 'function') {
        try { native.enableWindowSwitcher(false); } catch (failure) { report('[shell] Cannot stop switcher: ' + String(failure)); }
      }
      closeSurface(switcher); switcher = null;
      closeMenu();
      for (const bundle of bundles.values())
        for (const surface of Object.values(bundle.surfaces)) closeSurface(surface);
      bundles.clear();
    },
    selectTheme, showSettings, showApplications, launchApplication, showWindowActions, showWorkspaces, showShortcuts, showDisplays,
    showNotifications: notifications.show, showNetwork, refresh,
    getState() { return { themeId, error, outputs: [...bundles.keys()], running }; },
    getSurfaces() { return [...bundles.values()].flatMap(bundle => Object.values(bundle.surfaces)); },
  };
}
