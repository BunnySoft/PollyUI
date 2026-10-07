import { render } from './js/reconciler.mjs';
import { DEFAULT_DESKTOP_THEME, getDesktopTheme, THEME_LOAD_ERROR, THEME_REVISION,
  BUILTIN_THEME_CATALOG, DESKTOP_THEMES, installThemeCatalog } from './desktop/shell/themes.mjs';
import { readUserThemeCatalog } from './desktop/shell/theme-files.mjs';
import { wallpaper, panelView, dockView, settingsView, applicationsView, windowActionsView, workspacesView, shortcutsView, switcherView, displaysView, displayConfirmationView } from './desktop/shell/views.mjs';
import { createApplicationLauncher } from './desktop/shell/applications.mjs';
import { SHORTCUTS_KEY, saveShortcuts, shortcutFromEvent } from './desktop/shell/shortcuts.mjs';
import { readDisplayDraft } from './desktop/shell/displays.mjs';
import { createNotificationSurfaces } from './desktop/shell/notifications.mjs';
import { createTray } from './desktop/shell/tray.mjs';
import { createNetworkSettings } from './desktop/shell/network.mjs';
import { createAudioSettings } from './desktop/shell/audio.mjs';
import { createPowerSettings } from './desktop/shell/power.mjs';
import { createWorkspacePersistence, workspaceName } from './desktop/shell/workspaces.mjs';
import { createTextInput } from './js/textinput.mjs';
import { createDisplayPersistence } from './desktop/shell/display-profiles.mjs';
import { createSessionMonitor } from './desktop/shell/health.mjs';

export const SHELL_THEME_KEY = 'desktop.theme';
export const SHELL_THEME_FILES_KEY = 'desktop.theme.files';

export function createDesktopShell({ host = window, storage = localStorage, report = console.error,
  native = typeof desktop === 'undefined' ? null : desktop } = {}) {
  const bundles = new Map();
  let themeId = DEFAULT_DESKTOP_THEME;
  let themeAsset = '';
  let themeAssetSource = '';
  let error = THEME_LOAD_ERROR;
  let errorKind = error ? 'settings' : '';
  const serviceMonitor = createSessionMonitor({ native, report });
  let serviceError = '';
  let lastServicePoll = 0;
  let timer = null;
  let menu = null;
  let switcher = null;
  let displayConfirmation = null;
  let pendingDisplayToken = 0;
  let previousOutputsChanged = null, lastOutputMessage = '';
  const displayPersistence = createDisplayPersistence({ native, storage, failure: outputFailure });
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
  let workspaceEditor = null;
  const workspacePersistence = createWorkspacePersistence({ native, storage, failure: workspaceSettingsFailure });
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
  const audio = createAudioSettings({ native, report, host, storage, theme: () => getDesktopTheme(themeId) });
  const power = createPowerSettings({ native, report, host, theme: () => getDesktopTheme(themeId) });
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
  let themeFilesEnabled = true;
  if (typeof native?.readThemeFiles === 'function') {
    themeFilesEnabled = storage.getItem(SHELL_THEME_FILES_KEY) !== 'disabled';
    try { installThemeCatalog(themeFilesEnabled ? readUserThemeCatalog(native) : BUILTIN_THEME_CATALOG); }
    catch (failure) {
      installThemeCatalog(BUILTIN_THEME_CATALOG);
      error = 'Cannot load user theme files; using packaged themes. ' + String(failure);
      errorKind = 'theme-files';
      report('[shell] ' + error);
    }
  }
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
    releaseSurface(surface);
    if (!surface.window.closed) surface.window.close();
  }

  function releaseSurface(surface) {
    for (const remove of surface.listeners.splice(0)) remove();
    surface.window.document.activeElement?.blur();
    surface.displayInputs?.clear();
  }

  function releaseMenu(surface) {
    if (!surface || surface !== menu) return false;
    menu = null;
    const editor = workspaceEditor;
    workspaceEditor = null;
    editor?.input.root.blur();
    stopRecording();
    return true;
  }

  function closeMenu(surface = menu) {
    if (releaseMenu(surface)) closeSurface(surface);
  }

  function currentMenu(surface) {
    return running && surface === menu && !surface.window.closed;
  }

  function listen(surface, type, callback) {
    const body = surface.window.document.body;
    body.addEventListener(type, callback);
    surface.listeners.push(() => body.removeEventListener(type, callback));
  }

  function menuOpener(surface, event) {
    if (surface.output !== menu.output) return false;
    const ids = event.button === 2 && menu.mode === 'windows' ? ['shell-window-' + menu.windowId] :
      event.button === 0 ? {
        applications: ['shell-menu', 'shell-dock-applications'],
        appearance: ['shell-panel-settings', 'shell-dock-settings'],
        about: ['shell-dock-about'], workspaces: ['shell-workspaces'],
      }[menu.mode] || [] : [];
    for (let node = event.target; node; node = node.parentNode)
      if (ids.includes(node.id)) return true;
    return false;
  }

  function newSurface(output, kind, options) {
    const nativeWindow = host.create({ title: `PollyShell.${kind}.${output.id}`, output: output.id, ...options });
    const surface = { output: output.id, kind, window: nativeWindow, signature: JSON.stringify(options),
      expectedClose: false, listeners: [] };
    if (['wallpaper', 'panel', 'dock'].includes(kind)) listen(surface, 'mousedown', event => {
      if (!running || surface.expectedClose || nativeWindow.closed ||
          bundles.get(output.id)?.surfaces[kind] !== surface || !menu) return;
      // Only these owned documents deliver this event; foreign application presses need a native popup API.
      if (!menuOpener(surface, event)) closeMenu();
    });
    nativeWindow.onclose = () => {
      releaseMenu(surface);
      releaseSurface(surface);
      if (surface === switcher) {
        switcher = null;
        if (!surface.expectedClose && running) {
          try { native.cancelWindowSwitch(); } catch (failure) { shortcutFailure(failure); }
        }
      }
      if (surface === displayConfirmation) {
        displayConfirmation = null;
        if (!surface.expectedClose && running) {
          try {
            if (native.outputConfiguration().pendingToken === surface.token) native.revertOutputConfiguration(surface.token);
          } catch (failure) { outputFailure(failure); }
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
    const layout = theme.layout;
    const result = {
      wallpaper: { layer: 'background', width: 0, height: 0,
        anchors: ['top', 'bottom', 'left', 'right'], exclusiveZone: -1 },
      panel: { layer: 'top', width: 0, height: dock ? layout.menuBarHeight : theme.panel.height,
        anchors: [dock ? 'top' : 'bottom', 'left', 'right'], exclusiveZone: dock ? layout.menuBarHeight : theme.panel.height },
    };
    if (dock) result.dock = {
      layer: 'top', width: Math.max(1, Math.min(layout.dockBaseWidth +
        visibleWindows().length * (layout.dockWindowWidth + layout.windowGap), output.width - layout.screenInset * 2)), height: theme.panel.height,
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
    if (!background.window.closed) render(wallpaper(theme, 'shell-wallpaper', themeAsset), background.window.document.body);
    if (!panel.window.closed) render(panelView(theme, clock(), () => showApplications(bundle.output.id),
      error || serviceError, () => showSettings(bundle.output.id), listed, toggleWindow,
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
    const appearance = nextTheme + ':' + THEME_REVISION;
    const assetSource = nextTheme + '/' + theme.desktop.asset;
    let asset = themeAsset, loadedAsset = false;
    try {
      if (themeAssetSource !== assetSource || persist) {
        asset = '';
        if (theme.desktop.asset) {
          if (typeof native?.loadThemeAsset !== 'function') throw new Error('Native theme resources are unavailable');
          asset = native.loadThemeAsset(theme.id, theme.desktop.asset);
          loadedAsset = true;
        }
      }
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
      if (compositorAppearance !== appearance && typeof native?.configureAppearance === 'function') {
        native.configureAppearance(theme);
        compositorAppearance = appearance;
      } else if (compositorAppearance !== appearance && typeof native?.setAppearance === 'function') {
        native.setAppearance(nextTheme);
        compositorAppearance = appearance;
      }
    } catch (failure) {
      if (loadedAsset) releaseThemeAsset(asset);
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
    const previousAsset = themeAsset;
    themeAsset = asset;
    themeAssetSource = assetSource;
    try {
      for (const plan of plans) { bundles.set(plan.output.id, plan); paint(plan, theme); }
    } finally {
      if (previousAsset && previousAsset !== asset) releaseThemeAsset(previousAsset);
    }
    lastFailure = '';
  }

  function releaseThemeAsset(asset) {
    if (!asset) return;
    try { native.releaseThemeAsset(asset); }
    catch (failure) { report('[shell] Cannot release theme resource: ' + String(failure)); }
  }

  function applySelectedTheme(id) {
    reconcile(id, true);
    error = '';
    errorKind = '';
    closeMenu();
    for (const bundle of bundles.values()) paint(bundle, getDesktopTheme(themeId));
    notifications.paint();
    tray.paint();
    network.refresh();
    audio.paint();
    power.paint();
    if (switcher) switcherChanged();
    if (pendingDisplayToken) paintDisplayConfirmation();
  }

  function selectTheme(id) {
    if (!running) throw new Error('Shell is not running');
    getDesktopTheme(id);
    try {
      applySelectedTheme(id);
      return true;
    } catch (failure) {
      error = 'Could not apply/save appearance: ' + String(failure);
      errorKind = 'settings';
      report('[shell] ' + error);
      repaintMenu();
      return false;
    }
  }

  function replaceThemes(catalog, enabled) {
    if (!running) throw new Error('Shell is not running');
    const previous = { schemaVersion: 1, default: DEFAULT_DESKTOP_THEME, themes: DESKTOP_THEMES };
    const stored = storage.getItem(SHELL_THEME_FILES_KEY);
    const selected = catalog.themes.some(theme => theme.id === themeId) ? themeId : enabled ? null : DEFAULT_DESKTOP_THEME;
    if (!selected) throw new Error('The active theme is missing; restore a packaged theme before removing it');
    let installed = false, saved = false;
    try {
      installThemeCatalog(catalog); installed = true;
      storage.setItem(SHELL_THEME_FILES_KEY, enabled ? 'enabled' : 'disabled'); saved = true;
      applySelectedTheme(selected);
      themeFilesEnabled = enabled;
    } catch (failure) {
      if (installed) installThemeCatalog(previous);
      if (saved) {
        try {
          if (stored === null) storage.removeItem(SHELL_THEME_FILES_KEY);
          else storage.setItem(SHELL_THEME_FILES_KEY, stored);
        } catch (rollback) {
          throw new Error(String(failure) + '; cannot restore theme-file preference: ' + String(rollback));
        }
      }
      throw failure;
    }
  }

  function changeThemeFiles(enabled) {
    try {
      replaceThemes(enabled ? readUserThemeCatalog(native) : BUILTIN_THEME_CATALOG, enabled);
      return true;
    } catch (failure) {
      error = 'Could not apply theme files: ' + String(failure);
      errorKind = 'theme-files';
      report('[shell] ' + error);
      repaintMenu();
      return false;
    }
  }
  function reloadThemes() { return changeThemeFiles(true); }
  function restoreThemes() { return changeThemeFiles(false); }

  function repaintMenu() {
    if (!menu || menu.window.closed) return;
    const current = menu;
    const scoped = action => (...args) => {
      if (currentMenu(current)) return action(...args);
    };
    const close = scoped(() => closeMenu(current));
    if (current.mode === 'displays') {
      render(displaysView(getDesktopTheme(themeId), current.window.document, current.displayDraft,
        current.displayInputs, scoped(repaintMenu), scoped(() => applyDisplays(current)), close, error,
        { status: displayPersistence.status, forget: scoped(forgetDisplayProfile) }), current.window.document.body);
      return;
    }
    if (current.mode === 'shortcuts') {
      render(shortcutsView(getDesktopTheme(themeId), shortcutBindings, recordingShortcut, scoped(beginRecording),
        scoped(action => applyShortcuts(shortcutBindings.map(binding => binding.action === action ?
          { ...binding, modifiers: 0, key: '' } : binding))),
        scoped(() => applyShortcuts(native.shortcutDefaults())), close, error), current.window.document.body);
      return;
    }
    if (current.mode === 'workspaces') {
      render(workspacesView(getDesktopTheme(themeId), workspaces,
        scoped(id => workspaceAction('activateWorkspace', id)), scoped(id => workspaceAction('removeWorkspace', id)),
        scoped(() => workspaceAction('createWorkspace')), close, error,
        typeof native?.renameWorkspace === 'function' ? {
          rename: scoped(editWorkspace), reorder: scoped(reorderWorkspace), editor: workspaceEditor,
          save: scoped(saveWorkspaceName),
          cancel: scoped(() => { workspaceEditor?.input.root.blur(); workspaceEditor = null; repaintMenu(); }),
          saveCurrent: scoped(saveCurrentWorkspaces),
        } : null), current.window.document.body);
      return;
    }
    if (current.mode === 'windows') {
      const selected = visibleWindows().find(window => window.id === current.windowId);
      if (!selected) { closeMenu(); return; }
      render(windowActionsView(getDesktopTheme(themeId), selected,
        scoped(action => windowAction(selected.id, action)), close, error, workspaces,
        scoped(id => moveWindow(selected.id, id))), current.window.document.body);
      return;
    }
    if (current.mode === 'applications') {
      render(applicationsView(getDesktopTheme(themeId), applications, current.query,
        scoped(value => { current.query = value; repaintMenu(); }),
        scoped(launchApplication), scoped(reloadApplications), close, error), current.window.document.body);
      return;
    }
    render(settingsView(getDesktopTheme(themeId), scoped(selectTheme), close,
      scoped(() => errorKind === 'theme-files' ? reloadThemes() : refresh(true)),
      error, current.about, typeof native?.shortcuts === 'function' ? scoped(() => showShortcuts(current.output)) : null,
      typeof native?.outputConfiguration === 'function' ? scoped(() => showDisplays(current.output)) : null,
      typeof native?.startNetwork === 'function' ? scoped(() => showNetwork(current.output)) : null,
      typeof native?.startAudio === 'function' ? scoped(() => showAudio(current.output)) : null,
      typeof native?.readThemeFiles === 'function' ? {
        reload: scoped(reloadThemes), restore: scoped(restoreThemes), enabled: themeFilesEnabled,
      } : null,
      typeof native?.startPower === 'function' ? scoped(() => showPower(current.output)) : null),
      current.window.document.body);
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
    const layout = theme.layout;
    const root = bundle.surfaces.wallpaper.window.document.body;
    const width = root.offsetWidth || bundle.output.width;
    const height = root.offsetHeight || bundle.output.height;
    const mac = theme.panel.kind === 'dock';
    try {
      menu = newSurface(bundle.output, 'settings', {
        layer: 'overlay', width: Math.max(1, Math.min(layout.menuWidth, width - layout.screenInset * 2)),
        height: Math.max(1, Math.min(layout.menuHeight, height - theme.panel.height - layout.overlayInset * 2)),
        anchors: [mac ? 'top' : 'bottom', 'left'],
        margins: { left: layout.screenInset, [mac ? 'top' : 'bottom']:
          mac ? layout.menuBarHeight + layout.menuTopGap : theme.panel.height + layout.menuGap },
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
    const current = menu;
    const body = current.window.document.body;
    body.tabIndex = 0;
    listen(current, 'keydown', event => {
      if (!currentMenu(current)) return;
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
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(current); }
    });
    body.focus();
    repaintMenu();
    if (mode === 'applications' && currentMenu(current))
      current.window.document.getElementById('shell-app-search').focus();
    return current.window;
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
      const layout = getDesktopTheme(themeId).layout;
      const height = Math.max(1, Math.min(layout.switcherHeight, output.height - layout.switcherInset * 2));
      if (!switcher || switcher.window.closed) switcher = newSurface(output, 'switcher', {
        layer: 'overlay', width: Math.max(1, Math.min(layout.switcherWidth, output.width - layout.switcherInset * 2)), height,
        anchors: [], exclusiveZone: -1, keyboard: 'none', transparent: true,
      });
      render(switcherView(getDesktopTheme(themeId), snapshot, (serial, index) => {
        try { native.acceptWindowSwitch(serial, index); } catch (failure) { shortcutFailure(failure); }
      }, Math.max(1, Math.min(layout.switcherMaxRows,
        Math.floor((height - layout.switcherChromeHeight) / layout.switcherRowHeight)))), switcher.window.document.body);
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
      if (keep) {
        try { displayPersistence.save(native.outputConfiguration()); }
        catch (failure) { outputFailure('Changes were kept, but the startup profile was not saved: ' + String(failure)); }
      }
      updateOutputs();
    } catch (failure) { outputFailure(failure); }
  }

  function forgetDisplayProfile() {
    try {
      displayPersistence.forget();
      if (errorKind === 'outputs') { error = ''; errorKind = ''; }
      repaintMenu();
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
      const current = displayConfirmation;
      const body = displayConfirmation.window.document.body;
      body.tabIndex = 0;
      listen(current, 'keydown', event => {
        if (!running || displayConfirmation !== current || current.window.closed || pendingDisplayToken !== token) return;
        if (event.key === 'Escape' || event.key === 'Enter') {
          event.preventDefault(); finishDisplayChange(token, event.key === 'Enter');
        }
      });
      body.focus();
    }
    const current = displayConfirmation;
    const finish = keep => {
      if (running && displayConfirmation === current && !current.window.closed && pendingDisplayToken === token)
        finishDisplayChange(token, keep);
    };
    render(displayConfirmationView(getDesktopTheme(themeId), snapshot.remainingMs,
      () => finish(true), () => finish(false)),
      displayConfirmation.window.document.body);
  }

  function updateOutputs() {
    try {
      const snapshot = native.outputConfiguration();
      displayPersistence.observe(snapshot);
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

  function workspaceSettingsFailure(failure) {
    const message = 'Workspace settings were not saved/restored: ' + String(failure);
    if (error !== message) report('[shell] ' + message);
    error = message;
    errorKind = 'workspace-settings';
  }

  function refreshWindows() {
    try {
      const previous = workspaces.find(workspace => workspace.active)?.id;
      const nextWorkspaces = typeof native.workspaces === 'function' ?
        native.workspaces().sort((a, b) => a.order - b.order) : [];
      const nextWindows = native.windows().sort((a, b) => a.id - b.id);
      workspaces = nextWorkspaces;
      windows = nextWindows;
      workspacePersistence.sync(workspaces);
      if (workspaceEditor && !workspaces.some(workspace => workspace.id === workspaceEditor.id)) {
        workspaceEditor.input.root.blur();
        workspaceEditor = null;
      }
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

  function editWorkspace(id) {
    try {
      const selected = workspaces.find(workspace => workspace.id === id);
      if (!selected || menu?.mode !== 'workspaces') throw new Error('Workspace is no longer available');
      workspaceEditor?.input.root.blur();
      const theme = getDesktopTheme(themeId);
      const input = workspaceEditor?.input || createTextInput({ document: menu.window.document, value: selected.name,
        width: Math.max(1, menu.window.document.body.offsetWidth - theme.layout.compactPadding * 2),
        fontSize: theme.layout.fontSize, color: theme.colors.text, background: theme.colors.surface });
      input.root.id = 'shell-workspace-name';
      input.root.setAttribute('role', 'textbox');
      input.root.setAttribute('aria-label', 'Workspace name');
      const current = menu;
      if (!workspaceEditor) input.root.addEventListener('keydown', event => {
        if (!currentMenu(current) || workspaceEditor?.input !== input) return;
        if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); saveWorkspaceName(); }
      });
      input.value = selected.name;
      workspaceEditor = { id, input };
      repaintMenu();
      input.root.focus();
    } catch (failure) { windowFailure(failure); }
  }

  function saveWorkspaceName() {
    try {
      if (!workspaceEditor) return;
      native.renameWorkspace(workspaceEditor.id, workspaceName(workspaceEditor.input.value));
      workspaceEditor.input.root.blur();
      workspaceEditor = null;
      repaintMenu();
    } catch (failure) { windowFailure(failure); }
  }

  function reorderWorkspace(id, position) {
    try { native.reorderWorkspace(id, position); }
    catch (failure) { windowFailure(failure); }
  }

  function saveCurrentWorkspaces() {
    try {
      workspacePersistence.saveCurrent();
      if (errorKind === 'workspace-settings') { error = ''; errorKind = ''; }
    } catch (failure) { workspaceSettingsFailure(failure); }
    repaintMenu();
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
  function showAudio(output) {
    closeMenu();
    return audio.show(output);
  }
  function showPower(output) {
    closeMenu();
    return power.show(output);
  }

  function refresh(force = false) {
    if (!running) return;
    const now = Date.now();
    if (force || now - lastServicePoll >= 1000) {
      lastServicePoll = now;
      const nextError = serviceMonitor.refresh().message;
      if (nextError !== serviceError) {
        serviceError = nextError;
        repaintMenu();
      }
    }
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
      lastServicePoll = 0;
      try { reconcile(themeId, false); }
      catch (failure) { running = false; throw failure; }
      timer = setInterval(refresh, 1000);
      if (native) { previousExit = native.onExit; native.onExit = exited; }
      if (typeof native?.windows === 'function') {
        workspacePersistence.start();
        previousWindowsChanged = native.onWindowsChanged;
        native.onWindowsChanged = windowsChanged;
        previousWorkspacesChanged = native.onWorkspacesChanged;
        native.onWorkspacesChanged = workspacesChanged;
        refreshWindows();
      }
      startShortcuts();
      notifications.start();
      tray.start();
      audio.start();
      if (typeof native?.outputConfiguration === 'function') {
        previousOutputsChanged = native.onOutputsChanged;
        native.onOutputsChanged = outputsChanged;
        displayPersistence.start();
        updateOutputs();
      }
      return this;
    },
    stop() {
      running = false;
      serviceMonitor.reset(); serviceError = '';
      notifications.stop();
      tray.stop();
      network.stop();
      audio.stop();
      power.stop();
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
      releaseThemeAsset(themeAsset); themeAsset = ''; themeAssetSource = '';
    },
    selectTheme, reloadThemes, restoreThemes, showSettings, showApplications, launchApplication, showWindowActions, showWorkspaces, showShortcuts, showDisplays,
    showNotifications: notifications.show, showNetwork, showAudio, showPower, refresh,
    getState() {
      const services = serviceMonitor.snapshot();
      return { themeId, error: error || services.error,
        services, outputs: [...bundles.keys()], running, themeFilesEnabled, themeRevision: THEME_REVISION };
    },
    getSurfaces() { return [...bundles.values()].flatMap(bundle => Object.values(bundle.surfaces)); },
  };
}
