import { dockSurfaceWidth, applicationMenuPlacement, applicationMenuHeight } from './desktop/shared/ui/theme-layout.mjs';
import { encodeDecorationLayout } from './desktop/shared/ui/caption-layout.mjs';
import { h, render } from './gui/sdk/js/reconciler.mjs';
import { DEFAULT_DESKTOP_THEME, getDesktopTheme, THEME_LOAD_ERROR, THEME_REVISION,
  BUILTIN_THEME_CATALOG, DESKTOP_THEMES, installThemeCatalog } from './desktop/shell/themes.mjs';
import { readUserThemeCatalog } from './desktop/shell/theme-files.mjs';
import { panelView, dockView, settingsView, applicationsView, windowActionsView, workspacesView, switcherView, displayConfirmationView, button } from './desktop/shell/views.mjs';
import { createApplicationLauncher, applicationForWindow } from './desktop/shell/applications.mjs';
import { startMenuView } from './desktop/shell/start-menu.mjs';
import { programsPlacement } from './desktop/shell/programs-menu.mjs';
import { surfaceStyle } from './desktop/shared/ui/surface-primitives.mjs';
import { createNotificationSurfaces } from './desktop/shell/notifications.mjs';
import { createTray } from './desktop/shell/tray.mjs';
import { createNetworkSettings } from './desktop/shell/network.mjs';
import { createAudioPolicy } from './desktop/shell/audio-policy.mjs';
import { createSettingsDomains } from './desktop/shell/settings-domains.mjs';
import { createShortcutRecorder } from './desktop/shell/shortcut-recorder.mjs';
import { createPowerSettings } from './desktop/shell/power.mjs';
import { createSessionExitController, createLogoutSurface } from './desktop/shell/session-exit.mjs';
import { createWorkspacePersistence, workspaceName } from './desktop/shell/workspaces.mjs';
import { createTextInput } from './gui/sdk/js/textinput.mjs';
import { inputAppearance } from './desktop/shared/ui/input-appearance.mjs';
import { createDisplayPersistence } from './desktop/shell/display-profiles.mjs';
import { createSessionMonitor } from './desktop/shell/health.mjs';
import { SETTINGS_APPLICATION_ID } from './desktop/shell/settings.mjs';
import { settingsPage, runtimeBuild } from './desktop/client/settings-contract.mjs';
import { outputIdentity, outputKey, desktopOutputIdentity, desktopArea, layoutDesktop, gridPoint } from './desktop/shell/desktop-shortcuts.mjs';
import { createDesktopInteraction, bindDesktopInteraction } from './desktop/shell/desktop-interactions.mjs';
import { desktopView, desktopMenuView } from './desktop/shell/desktop-view.mjs';
import { windowTasks, taskIdentity } from './desktop/shell/window-groups.mjs';
import { windowGroupMenu } from './desktop/shell/window-group-menu.mjs';
export function createDesktopShell({ host = window, configuration, report = console.error,
  native = typeof desktop === 'undefined' ? null : desktop, settingsFactory = null } = {}) {
  if (!configuration) throw new TypeError('Shell requires its typed application configuration');
  const bundles = new Map();
  let themeId = DEFAULT_DESKTOP_THEME;
  let themeAsset = '';
  let themeAssetSource = '';
  let appliedTheme = null;
  let error = THEME_LOAD_ERROR;
  let errorKind = error ? 'settings' : '';
  const serviceMonitor = createSessionMonitor({ native, report });
  let serviceError = '';
  let lastServicePoll = 0;
  let timer = null;
  let menu = null;
  let settingsBridge = null, settingsReady = null, settingsStartupError = null, settingsScope = {};
  let appearanceRevision = 0;
  let switcher = null;
  let displayConfirmation = null;
  let pendingDisplayToken = 0;
  let previousOutputsChanged = null, lastOutputMessage = '';
  const displayPersistence = createDisplayPersistence({ native, configuration, failure: outputFailure });
  const outputsChanged = () => {
    if (!running) return;
    updateOutputs();
    if (typeof previousOutputsChanged === 'function') previousOutputsChanged();
  };
  let previousShortcutsChanged = null, previousSwitcherChanged = null;
  const shortcutsChanged = () => {
    if (!running) return;
    try { native.shortcuts(); repaintMenu(); }
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
  let taskCache = null;
  let workspaceEditor = null;
  const workspacePersistence = createWorkspacePersistence({ native, configuration, failure: workspaceSettingsFailure });
  let previousWorkspacesChanged = null;
  const workspacesChanged = () => {
    if (!running) return;
    refreshWindows();
    if (typeof previousWorkspacesChanged === 'function') previousWorkspacesChanged();
  };
  let compositorAppearance = null;
  let appearanceStatus = '';
  let previousWindowsChanged = null;
  const windowsChanged = () => {
    if (!running) return;
    refreshWindows();
    if (typeof previousWindowsChanged === 'function') previousWindowsChanged();
  };
  const launcher = native ? createApplicationLauncher(native, report) : null;
  let applicationLaunchScope = {};
  let desktopStatus = '';
  let lastCatalogPoll = 0;
  let iconResources = null, iconLoading = false, iconLoadError = null, iconScope = {};
  const desktopImages = new Map(), desktopImageErrors = new Map();
  const notifications = createNotificationSurfaces({ host, native, theme: () => getDesktopTheme(themeId), report,
    changed: () => { for (const bundle of bundles.values()) paint(bundle, getDesktopTheme(themeId)); } });
  const tray = createTray({ native, report, host, theme: () => getDesktopTheme(themeId),
    changed: () => { for (const bundle of bundles.values()) paint(bundle, getDesktopTheme(themeId)); } });
  const network = createNetworkSettings({ native, report, host, theme: () => getDesktopTheme(themeId) });
  const audio = createAudioPolicy({ native, report, configuration });
  const recorder = createShortcutRecorder({ native, host, report, theme: () => getDesktopTheme(themeId) });
  const domains = createSettingsDomains({ native, configuration, audio, recorder, displayPersistence, updateOutputs,
    displayError: () => errorKind === 'outputs' ? error : '', report });
  const sessionExit = createSessionExitController({ native, report });
  const logout = createLogoutSurface({ controller: sessionExit, host, theme: () => getDesktopTheme(themeId),
    commit: () => {
      if (!running) throw new Error('The desktop session is no longer running.');
      host.quit();
    } });
  const power = createPowerSettings({ native, report, host, theme: () => getDesktopTheme(themeId), sessionExit });
  let previousSessionExit = null;
  const sessionExitRequested = () => {
    if (!running) return;
    try { showLogout(host.displays()[0]?.id); }
    catch (failure) { report('[shell] Cannot show logout confirmation: ' + String(failure)); }
    if (typeof previousSessionExit === 'function') previousSessionExit();
  };
  let previousExit = null;
  const exited = event => {
    if (!running) return;
    settingsBridge?.exited(event);
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
    themeFilesEnabled = configuration.snapshot.theme.filesEnabled;
    try { installThemeCatalog(themeFilesEnabled ? readUserThemeCatalog(native) : BUILTIN_THEME_CATALOG); }
    catch (failure) {
      installThemeCatalog(BUILTIN_THEME_CATALOG);
      error = 'Cannot load user theme files; using packaged themes. ' + String(failure);
      errorKind = 'theme-files';
      report('[shell] ' + error);
    }
  }
  const stored = configuration.snapshot.theme.id;
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
    surface.desktopBinding?.stop();
    surface.desktopBinding = null;
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
    const search = surface.search;
    surface.search = null;
    if (search) {
      search.input.root.cancelComposition();
      search.input.root.blur();
      search.input.value = '';
    }
    if (running && surface.mode === 'applications') syncShellIcons(getDesktopTheme(themeId));
    return true;
  }

  function closeMenu(surface = menu, returnFocus = false) {
    if (releaseMenu(surface)) {
      closeSurface(surface);
      if (returnFocus) surface.returnFocus?.();
    }
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
    const ids = (menu.mode === 'windows' && event.button === 2 ||
      menu.mode === 'window-group' && [0, 2].includes(event.button)) ?
      ['shell-window-' + menu.windowId] :
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
    if (['wallpaper', 'panel', 'dock'].includes(kind)) listen(surface, 'keydown', event => {
      if (running && event.ctrlKey && event.altKey && !event.shiftKey && event.key.toLowerCase() === 'l') {
        event.preventDefault();
        showLogout(output.id);
      }
    });
    if (['wallpaper', 'panel', 'dock'].includes(kind)) listen(surface, 'mousedown', event => {
      if (!running || surface.expectedClose || nativeWindow.closed ||
          bundles.get(output.id)?.surfaces[kind] !== surface || !menu) return;
      // Owned layers retain opener toggles; the WM handles presses outside Shell layers.
      if (!menuOpener(surface, event)) closeMenu();
    });
    if (kind === 'wallpaper') {
      nativeWindow.document.body.tabIndex = 0;
      surface.desktopController = createDesktopInteraction({
        changed: () => {
          const bundle = bundles.get(surface.output);
          if (running && bundle?.surfaces.wallpaper === surface && !nativeWindow.closed) paintDesktop(bundle);
        },
        save: (items, selected) => saveDesktopPositions(surface.output, items.filter(item => selected.has(item.id))),
        launch: id => launchApplication(id, surface.output),
        context: () => openMenu(surface.output, 'desktop'),
        failure: desktopFailure,
      });
      surface.desktopBinding = bindDesktopInteraction(nativeWindow.document.body, surface.desktopController, desktopFailure);
    }
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
      if (!surface.expectedClose && running && kind !== 'menu') {
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

  function displayTasks(theme) {
    const grouping = theme.panel.taskGrouping ?? 'windows';
    const pins = configuration.snapshot.launchers.applications;
    if (!taskCache || taskCache.windows !== windows || taskCache.workspaces !== workspaces ||
        taskCache.applications !== applications || taskCache.grouping !== grouping || taskCache.pins !== pins)
      taskCache = { windows, workspaces, applications, grouping, pins,
        items: windowTasks(visibleWindows(), grouping, desktopCatalog(), pins,
          workspaces.find(workspace => workspace.active)?.id, applications) };
    return taskCache.items;
  }

  function definitions(theme, output) {
    const dock = theme.panel.kind === 'dock';
    const layout = theme.layout;
    const result = {
      wallpaper: { layer: 'background', width: 0, height: 0,
        anchors: ['top', 'bottom', 'left', 'right'], exclusiveZone: -1, keyboard: 'on-demand' },
      panel: { layer: 'top', width: 0, height: dock ? layout.menuBarHeight : theme.panel.height,
        anchors: [dock ? 'top' : 'bottom', 'left', 'right'], exclusiveZone: dock ? layout.menuBarHeight : theme.panel.height },
    };
    if (dock) result.dock = {
      layer: 'top', width: dockSurfaceWidth(theme, displayTasks(theme).length, output.width), height: theme.panel.height,
      anchors: ['bottom'], margins: { bottom: theme.panel.inset }, exclusiveZone: theme.panel.height,
      transparent: true,
    };
    return result;
  }

  function desktopCatalog() {
    return [{ id: SETTINGS_APPLICATION_ID, name: 'Settings', genericName: 'System settings',
      comment: 'Appearance, displays, Wi-Fi, audio and keyboard', keywords: ['preferences', 'desktop'] },
    ...applications.filter(entry => entry.id !== SETTINGS_APPLICATION_ID)];
  }

  function shortcutsFor(bundle) {
    const connected = new Set([...bundles.values()].filter(item => item.identity).map(item => outputKey(item.identity)));
    const first = bundles.values().next().value;
    return configuration.snapshot.desktop.shortcuts.filter(item =>
      (bundle.identity && outputKey(item.output) === outputKey(bundle.identity)) ||
      (!connected.has(outputKey(item.output)) && bundle === first));
  }

  function areaFor(bundle) {
    const theme = getDesktopTheme(themeId), body = bundle.surfaces.wallpaper.window.document.body;
    return desktopArea(body.offsetWidth || bundle.output.width, body.offsetHeight || bundle.output.height,
      theme.panel.kind === 'dock' ? theme.layout.menuBarHeight : 0,
      theme.panel.height + (theme.panel.kind === 'dock' ? theme.panel.inset : 0));
  }

  function paintDesktop(bundle, theme = getDesktopTheme(themeId)) {
    const surface = bundle.surfaces.wallpaper;
    if (surface.window.closed) return;
    const area = areaFor(bundle), shortcuts = shortcutsFor(bundle), items = layoutDesktop(shortcuts, area);
    surface.desktopController.update(items, area);
    const overflow = shortcuts.length - items.length;
    const displaced = shortcuts.some(item => !bundle.identity || outputKey(item.output) !== outputKey(bundle.identity));
    syncShellIcons(theme);
    const imageError = items.map(item => desktopImageErrors.get(item.id)?.message).find(Boolean);
    const message = desktopStatus || (errorKind === 'application' ? error : '') || imageError ||
      (overflow ? overflow + ' shortcut(s) do not fit. Right-click to manage them or enlarge this output.' :
        displaced ? 'Disconnected display shortcuts are shown here temporarily. Move to save their new display.' : '');
    render(desktopView(theme, themeAsset, surface.desktopController.state, desktopCatalog(), message, desktopImages),
      surface.window.document.body);
  }

  function syncShellIcons(theme) {
    const ids = new Set(configuration.snapshot.desktop.shortcuts.map(item => item.id));
    if (theme.panel.taskGrouping === 'applications')
      for (const id of configuration.snapshot.launchers.applications) ids.add(id);
    if (menu?.mode === 'applications' && currentMenu(menu)) {
      const query = menu.query.toLowerCase();
      for (const entry of desktopCatalog().filter(entry =>
        [entry.name, entry.genericName || '', entry.comment || '', ...(entry.keywords || [])]
          .join(' ').toLowerCase().includes(query)).slice(0, 100)) ids.add(entry.id);
    }
    const appIds = new Set(displayTasks(theme).map(task => task.appId).filter(Boolean));
    for (const appId of appIds) {
      const entry = applicationForWindow(applications, appId);
      if (entry) ids.add(entry.id);
    }
    const entries = applications.filter(entry => entry.icon && ids.has(entry.id));
    if (!iconResources && entries.length && !iconLoading) {
      iconLoading = true;
      const scope = iconScope;
      import('./desktop/shell/desktop-icon-resources.mjs').then(module => {
        if (!running || scope !== iconScope) return;
        if (typeof globalThis.createBitmap !== 'function') throw new Error('GUI bitmap decoding is unavailable');
        iconResources = module.createDesktopIconResources(globalThis.createBitmap);
        iconLoading = false;
        for (const bundle of bundles.values()) paint(bundle, getDesktopTheme(themeId));
        repaintMenu();
      }).catch(failure => {
        if (!running || scope !== iconScope) return;
        iconLoadError = failure;
        for (const entry of entries) iconFailure(entry, failure);
        // Do not retry a failed module import on every Shell repaint.
        for (const bundle of bundles.values()) paint(bundle, getDesktopTheme(themeId));
        repaintMenu();
      });
    }
    if (!iconResources) {
      if (iconLoadError) for (const entry of entries)
        if (desktopImageErrors.get(entry.id)?.path !== entry.icon) iconFailure(entry, iconLoadError);
      return;
    }
    iconResources.retain(entries);
    for (const id of [...desktopImages.keys()]) if (!entries.some(entry => entry.id === id)) desktopImages.delete(id);
    for (const id of [...desktopImageErrors.keys()]) if (!entries.some(entry => entry.id === id)) desktopImageErrors.delete(id);
    for (const entry of entries) {
      if (desktopImageErrors.get(entry.id)?.path === entry.icon) continue;
      try { desktopImages.set(entry.id, iconResources.load(entry)); desktopImageErrors.delete(entry.id); }
      catch (failure) { desktopImages.delete(entry.id); iconFailure(entry, failure); }
    }
  }

  function iconFailure(entry, failure) {
    const message = 'Cannot load ' + entry.name + ' icon; using original fallback artwork. ' + String(failure);
    desktopImageErrors.set(entry.id, { path: entry.icon, message });
    report('[shell] ' + message);
  }

  function changeLauncherPin(id, pinned) {
    if (!running || getDesktopTheme(themeId).panel.taskGrouping !== 'applications') return false;
    id = launcherCatalogId(id);
    const previous = configuration.snapshot.launchers.applications;
    if (previous.includes(id) === pinned) return false;
    try {
      if (pinned) {
        if (id !== SETTINGS_APPLICATION_ID) applications = launcher.refresh();
        const entry = desktopCatalog().find(entry => entry.id === id);
        if (!entry || entry.unavailable) throw new Error(entry?.unavailable || 'Application is no longer in the catalog');
        if (previous.length >= 32) throw new Error('At most 32 applications can be pinned');
      }
      configuration.update({ launchers: { version: 1,
        applications: pinned ? [...previous, id] : previous.filter(value => value !== id) } });
      if (errorKind === 'launchers') { error = ''; errorKind = ''; }
    } catch (failure) {
      error = (failure.committed ? 'Launcher pins saved, but durability confirmation failed: ' :
        'Launcher pins were not changed: ') + String(failure);
      errorKind = 'launchers';
      report('[shell] ' + error);
      refresh(true); repaintMenu();
      return false;
    }
    refresh(true); repaintMenu();
    return true;
  }

  function launcherCatalogId(id) {
    const registered = applicationForWindow(applications, SETTINGS_APPLICATION_ID);
    if (id !== SETTINGS_APPLICATION_ID && id !== registered?.id) return id;
    return configuration.snapshot.launchers.applications.includes(SETTINGS_APPLICATION_ID) ?
      SETTINGS_APPLICATION_ID : registered?.id || SETTINGS_APPLICATION_ID;
  }

  function cancelDesktopInteractions() {
    for (const bundle of bundles.values()) bundle.surfaces.wallpaper.desktopBinding?.cancel();
  }

  function desktopFailure(failure) {
    desktopStatus = (failure.committed ? 'Desktop shortcuts published, but durability confirmation failed: ' :
      'Desktop shortcut change did not complete: ') + String(failure);
    report('[shell] ' + desktopStatus);
    for (const bundle of bundles.values()) paintDesktop(bundle);
    repaintMenu();
  }

  function publishDesktop(shortcuts) {
    configuration.update({ desktop: { version: 1, shortcuts } });
    desktopStatus = '';
  }

  function desktopChange(action) {
    cancelDesktopInteractions();
    try { action(); }
    catch (failure) { desktopFailure(failure); return false; }
    for (const bundle of bundles.values()) paintDesktop(bundle);
    repaintMenu();
    return true;
  }

  function saveDesktopPositions(outputId, items) {
    const bundle = bundles.get(outputId);
    if (!bundle?.identity) throw new Error('This output has no stable identity; positions cannot be saved');
    const positions = new Map(items.map(item => [item.id, item]));
    publishDesktop(configuration.snapshot.desktop.shortcuts.map(item => positions.has(item.id) ?
      { ...item, output: bundle.identity, x: positions.get(item.id).x, y: positions.get(item.id).y } : item));
  }

  function addDesktopShortcut(outputId, id) {
    if (!running) throw new Error('Shell is not running');
    return desktopChange(() => {
      if (configuration.snapshot.desktop.shortcuts.some(item => item.id === id)) return;
      if (id !== SETTINGS_APPLICATION_ID) {
        if (!launcher) throw new Error('Application discovery requires --desktop');
        applications = launcher.refresh();
      }
      const entry = desktopCatalog().find(entry => entry.id === id);
      if (!entry || entry.unavailable) throw new Error(entry?.unavailable || 'Application is no longer available');
      const bundle = bundles.get(outputId);
      if (!bundle?.identity) throw new Error('This output has no stable identity; shortcuts cannot be saved');
      const area = areaFor(bundle), existing = layoutDesktop(shortcutsFor(bundle), area);
      if (shortcutsFor(bundle).length >= area.rows * area.columns) throw new Error('This desktop grid is full');
      const occupied = new Set(existing.map(item => item.x + ':' + item.y));
      let point = null;
      for (let row = 0; row < area.rows && !point; row++) for (let column = 0; column < area.columns; column++) {
        const candidate = gridPoint(area, column, row);
        if (!occupied.has(candidate.x + ':' + candidate.y)) { point = candidate; break; }
      }
      if (!point) throw new Error('This desktop grid is full');
      publishDesktop([...configuration.snapshot.desktop.shortcuts,
        { id: entry.id, name: entry.name, output: bundle.identity, ...point }]);
    });
  }

  function removeDesktopShortcuts(ids) {
    if (!running) throw new Error('Shell is not running');
    return desktopChange(() => {
      const removing = new Set(ids);
      publishDesktop(configuration.snapshot.desktop.shortcuts.filter(item => !removing.has(item.id)));
    });
  }

  function sortDesktopShortcuts(outputId) {
    if (!running) throw new Error('Shell is not running');
    return desktopChange(() => {
      const bundle = bundles.get(outputId);
      if (!bundle) throw new Error('Desktop output is no longer connected');
      const area = areaFor(bundle), catalog = new Map(desktopCatalog().map(entry => [entry.id, entry]));
      const shortcuts = [...shortcutsFor(bundle)].sort((a, b) =>
        (catalog.get(a.id)?.name || a.name).localeCompare(catalog.get(b.id)?.name || b.name) || a.id.localeCompare(b.id));
      if (shortcuts.length > area.rows * area.columns) throw new Error('Enlarge this output or remove shortcuts before sorting');
      const items = shortcuts.map((item, i) => ({ ...item, ...gridPoint(area, i % area.columns, Math.floor(i / area.columns)) }));
      saveDesktopPositions(outputId, items);
    });
  }

  function paint(bundle, theme) {
    const { wallpaper: background, panel, dock } = bundle.surfaces;
    const listed = displayTasks(theme);
    const current = workspaces.find(workspace => workspace.active);
    const workspaceControl = typeof native?.workspaces === 'function' ? {
      name: current?.name || 'Workspaces', open: () => showWorkspaces(bundle.output.id),
    } : null;
    if (!background.window.closed) paintDesktop(bundle, theme);
    else syncShellIcons(theme);
    const taskImages = new Map();
    for (const task of listed) {
      const entry = task.catalogId ? applications.find(entry => entry.id === task.catalogId) :
        applicationForWindow(applications, task.appId);
      if (entry && desktopImages.has(entry.id)) taskImages.set(task.id, desktopImages.get(entry.id));
    }
    if (!panel.window.closed) render(panelView(theme, clock(), () => showApplications(bundle.output.id),
      error || serviceError, () => showSystemSettings(bundle.output.id), listed,
      taskCallback(bundle, panel, false), taskCallback(bundle, panel, true), workspaceControl,
      notifications.count() ? { count: notifications.count(), open: notifications.show } : null,
      { items: tray.items(), error: tray.error(), activate: (item, kind, x, y) => tray.activate(item, kind,
        x + bundle.output.x, y + bundle.output.y + (theme.panel.kind === 'taskbar' ?
          bundle.output.height - theme.panel.height : 0)), scroll: tray.scroll }, taskImages),
      panel.window.document.body);
    if (dock && !dock.window.closed) render(dockView(theme, () => showSystemSettings(bundle.output.id),
      () => showSystemSettings(bundle.output.id, 'about'), () => showApplications(bundle.output.id), listed,
      taskCallback(bundle, dock, false), taskCallback(bundle, dock, true), taskImages), dock.window.document.body);
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

  function reconcile(nextTheme, persist, filesEnabled = themeFilesEnabled) {
    const theme = getDesktopTheme(nextTheme);
    const outputs = host.displays();
    const staged = [];
    const plans = [];
    const previousAppearance = compositorAppearance, previousTheme = appliedTheme ?? getDesktopTheme(themeId);
    let configured = false, publicationFailure = null;
    const appearance = nextTheme + ':' + THEME_REVISION;
    const assetSource = nextTheme + '/' + theme.desktop.asset;
    let asset = themeAsset, loadedAsset = false;
    try {
      if (themeAssetSource !== assetSource || persist) {
        asset = '';
        if (theme.desktop.asset) {
          if (typeof native?.loadThemeAsset !== 'function') throw new Error('Theme resources are unavailable');
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
        let identity = null;
        if (typeof native?.outputConfiguration === 'function') {
          identity = desktopOutputIdentity(output, native.outputConfiguration().heads);
        } else if (output.name) identity = outputIdentity(output);
        plans.push({ output, surfaces, identity });
      }
      if (compositorAppearance !== appearance && typeof native?.configureAppearance === 'function') {
        native.configureAppearance(theme, encodeDecorationLayout(theme));
        compositorAppearance = appearance;
        configured = true;
      }
      if (persist) {
        try { configuration.update({ theme: { id: nextTheme, filesEnabled } }); }
        catch (failure) {
          if (!failure.committed) throw failure;
          publicationFailure = failure;
        }
      }
    } catch (failure) {
      if (loadedAsset) releaseThemeAsset(asset);
      for (const surface of staged) closeSurface(surface);
      if (configured) {
        try {
          native.configureAppearance(previousTheme, encodeDecorationLayout(previousTheme));
          compositorAppearance = previousAppearance;
        } catch (rollback) {
          throw new Error(String(failure) + '; could not restore native appearance: ' + String(rollback));
        }
      }
      throw failure;
    }
    const retained = new Set(plans.flatMap(plan => Object.values(plan.surfaces)));
    for (const bundle of bundles.values())
      for (const surface of Object.values(bundle.surfaces)) if (!retained.has(surface)) closeSurface(surface);
    bundles.clear();
    themeId = nextTheme;
    appliedTheme = theme;
    if (persist) themeFilesEnabled = filesEnabled;
    const previousAsset = themeAsset;
    themeAsset = asset;
    themeAssetSource = assetSource;
    try {
      for (const plan of plans) bundles.set(plan.output.id, plan);
      for (const plan of plans) paint(plan, theme);
    } finally {
      if (previousAsset && previousAsset !== asset) releaseThemeAsset(previousAsset);
    }
    lastFailure = '';
    if (publicationFailure) throw publicationFailure;
  }

  function releaseThemeAsset(asset) {
    if (!asset) return;
    try { native.releaseThemeAsset(asset); }
    catch (failure) { report('[shell] Cannot release theme resource: ' + String(failure)); }
  }

  function applySelectedTheme(id, filesEnabled = themeFilesEnabled) {
    let publicationFailure = null;
    try { reconcile(id, true, filesEnabled); }
    catch (failure) { if (!failure.committed) throw failure; publicationFailure = failure; }
    appearanceRevision++;
    error = '';
    errorKind = '';
    closeMenu();
    for (const bundle of bundles.values()) paint(bundle, getDesktopTheme(themeId));
    notifications.paint();
    tray.paint();
    network.refresh();
    power.paint();
    if (switcher) switcherChanged();
    if (pendingDisplayToken) paintDisplayConfirmation();
    if (publicationFailure) throw publicationFailure;
  }

  function selectTheme(id) {
    if (!running) throw new Error('Shell is not running');
    getDesktopTheme(id);
    appearanceStatus = 'Applying and saving appearance...';
    repaintMenu();
    try {
      applySelectedTheme(id);
      appearanceStatus = getDesktopTheme(id).name + ' applied and saved.';
        return true;
    } catch (failure) {
      appearanceStatus = '';
      error = (failure.committed ? 'Appearance applied and saved, but durability confirmation failed: ' :
        'Could not apply/save appearance: ') + String(failure);
      errorKind = 'settings';
      report('[shell] ' + error);
      repaintMenu();
      return false;
    }
  }

  function replaceThemes(catalog, enabled) {
    if (!running) throw new Error('Shell is not running');
    const previous = { schemaVersion: 1, default: DEFAULT_DESKTOP_THEME, themes: DESKTOP_THEMES };
    const selected = catalog.themes.some(theme => theme.id === themeId) ? themeId : enabled ? null : DEFAULT_DESKTOP_THEME;
    if (!selected) throw new Error('The active theme is missing; restore a packaged theme before removing it');
    let installed = false;
    try {
      installThemeCatalog(catalog); installed = true;
      applySelectedTheme(selected, enabled);
      } catch (failure) {
      if (installed && !failure.committed) installThemeCatalog(previous);
      throw failure;
    }
  }

  function changeThemeFiles(enabled) {
    appearanceStatus = 'Loading and applying theme files...';
    repaintMenu();
    try {
      replaceThemes(enabled ? readUserThemeCatalog(native) : BUILTIN_THEME_CATALOG, enabled);
      appearanceStatus = enabled ? 'Theme files reloaded and applied.' : 'Packaged themes applied and saved.';
        return true;
    } catch (failure) {
      appearanceStatus = '';
      error = (failure.committed ? 'Theme files applied and saved, but durability confirmation failed: ' :
        'Could not apply theme files: ') + String(failure);
      errorKind = 'theme-files';
      report('[shell] ' + error);
      repaintMenu();
      return false;
    }
  }
  function reloadThemes() { return changeThemeFiles(true); }
  function restoreThemes() { return changeThemeFiles(false); }

  function applicationSearch(current, theme, { style, placeholder, submit, focused }) {
    let record = current.search;
    if (!record) {
      const input = createTextInput({ window: current.window, value: current.query, width: '100%',
        fontSize: theme.layout.fontSize, padding: 4, maxLength: 128 });
      record = current.search = { input, theme: null, composing: false };
      input.root.id = 'shell-app-search';
      input.root.setAttribute('role', 'textbox');
      input.root.setAttribute('aria-label', 'Search applications');
      const live = () => currentMenu(current) && current.search === record;
      const edited = () => {
        if (!live() || current.query === input.value) return;
        current.query = input.value;
        repaintMenu();
      };
      const hint = composing => {
        if (!live()) return;
        record.composing = composing;
        const node = current.window.document.getElementById('shell-app-search-hint');
        if (node) node.style.display = composing || input.value ? 'none' : 'flex';
      };
      input.root.addEventListener('textinput', edited);
      input.root.addEventListener('auxclick', edited);
      input.root.addEventListener('compositionstart', () => hint(true));
      input.root.addEventListener('compositionend', () => hint(false));
      input.root.addEventListener('focus', event => { if (live()) record.focused?.(event); });
      input.root.addEventListener('keydown', event => {
        if (!live()) return;
        if (['Backspace', 'Delete'].includes(event.key) ||
            ((event.ctrlKey || event.metaKey) && ['x', 'v'].includes(event.key.toLowerCase()))) edited();
        if (event.key === 'Enter') {
          event.preventDefault(); event.stopPropagation();
          if (!event.repeat && !event.isComposing && !record.composing) record.submit();
        } else if (event.defaultPrevented) event.stopPropagation();
      });
    }
    record.submit = submit; record.focused = focused;
    if (record.input.value !== current.query) record.input.value = current.query;
    if (record.theme !== theme) {
      record.input.setAppearance(inputAppearance(theme));
      record.theme = theme;
    }
    record.input.root.style.height = String(style.height);
    return h('view', { id: 'shell-app-search-slot', style: { ...style, position: 'relative' },
      onMount: node => node.insertBefore(record.input.root, node.firstChild) },
    h('view', { id: 'shell-app-search-hint', 'aria-hidden': 'true', style: { position: 'absolute', top: 4, left: 4,
      color: theme.colors.muted, fontSize: theme.layout.fontSize, pointerEvents: 'none',
      display: current.query || record.composing ? 'none' : 'flex' } }, placeholder));
  }

  function repaintMenu() {
    if (!menu || menu.window.closed) return;
    const current = menu;
    const scoped = action => (...args) => {
      if (currentMenu(current)) return action(...args);
    };
    const close = scoped(() => closeMenu(current));
    if (current.mode === 'workspaces') {
      if (workspaceEditor) workspaceEditor.input.setAppearance(inputAppearance(getDesktopTheme(themeId)));
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
    if (current.mode === 'window-group') {
      const group = displayTasks(getDesktopTheme(themeId)).find(task =>
        task.id === current.windowId && (task.grouped || task.launcher));
      if (!group || group.appId !== current.groupAppId || group.catalogId !== current.groupCatalogId ||
          !!group.launcher !== current.groupLauncher ||
          workspaces.find(workspace => workspace.active)?.id !== current.groupWorkspaceId) {
        closeMenu(current); return;
      }
      const entry = group.catalogId ? desktopCatalog().find(entry => entry.id === group.catalogId) :
        applicationForWindow(applications, group.appId);
      const pinned = !!entry && configuration.snapshot.launchers.applications.includes(entry.id);
      render(windowGroupMenu(getDesktopTheme(themeId), group, {
        slots: current.groupSlots,
        action: (id, action) => {
          if (!currentMenu(current)) return false;
          try {
            if (!host.displays().some(output => output.id === current.output)) return false;
            const live = liveTasks(current.groupWorkspaceId).find(task =>
              task.grouped && task.id === current.windowId && task.appId === current.groupAppId);
            const selected = live?.windows.find(window => window.id === id);
            if (!selected || action === 'minimizeWindow' && selected.minimized ||
                action === 'restoreWindow' && !selected.minimized) return false;
            return windowAction(id, action);
          } catch (failure) { windowFailure(failure); return false; }
        },
        close: () => currentMenu(current) ? closeMenu(current, true) : false,
        pin: group.pinned || entry ? {
          label: pinned || group.pinned ? 'Unpin from ' : 'Pin to ',
          target: getDesktopTheme(themeId).panel.kind === 'dock' ? 'Dock' : 'taskbar',
          change: () => {
            if (!currentMenu(current) || !host.displays().some(output => output.id === current.output) ||
                !liveTasks(current.groupWorkspaceId).some(task =>
                task.id === group.id && taskIdentity(task) === taskIdentity(group))) return false;
            const changed = changeLauncherPin(group.catalogId || entry.id, !pinned && !group.pinned);
            if (changed && currentMenu(current)) closeMenu(current, true);
            return changed;
          },
        } : null,
        error: error || group.unavailable,
      }), current.window.document.body);
      return;
    }
    if (current.mode === 'applications') {
      const menuTheme = getDesktopTheme(themeId);
      if (surfaceStyle(menuTheme, 'panel') !== 'classic' && current.programsOpen) {
        current.programsOpen = false;
        current.programsEpoch = (current.programsEpoch ?? 0) + 1;
        current.programsSlots = [];
      }
      const programsEpoch = current.programsEpoch ?? 0;
      const applicationMenu = surfaceStyle(menuTheme, 'panel') === 'classic' ? startMenuView : applicationsView;
      syncShellIcons(menuTheme);
      const searchFocused = current.search?.input.root === current.window.document.activeElement;
      render(applicationMenu(menuTheme, desktopCatalog(), current.query,
        scoped(value => { current.query = value; repaintMenu(); }),
        scoped(launchApplication), scoped(reloadApplications), close, error,
        typeof native?.beginSessionExit === 'function' ? scoped(() => showLogout(current.output)) : null, {
          has: id => configuration.snapshot.desktop.shortcuts.some(item => item.id === id),
          add: scoped(id => addDesktopShortcut(current.output, id)),
          remove: scoped(id => removeDesktopShortcuts([id])),
        }, {
          open: current.programsOpen === true,
          slots: current.programsSlots ??= [],
          placement: current.programsPlacement,
          launch: scoped(id => {
            if (current.programsOpen && current.programsEpoch === programsEpoch &&
                desktopCatalog().some(entry => entry.id === id && !entry.unavailable))
              return launchApplication(id);
          }),
          pin: scoped(id => {
            if (!current.programsOpen || current.programsEpoch !== programsEpoch ||
                !desktopCatalog().some(entry => entry.id === id)) return;
            if (configuration.snapshot.desktop.shortcuts.some(item => item.id === id)) return removeDesktopShortcuts([id]);
            return addDesktopShortcut(current.output, id);
          }),
          change: scoped((open, focus = '') => {
            if ((current.programsEpoch ?? 0) !== programsEpoch) return;
            if (open) {
              const document = current.window.document;
              current.programsPlacement = programsPlacement(document.getElementById('shell-applications'),
                document.getElementById('shell-all-programs'), getDesktopTheme(themeId).layout.menuRowHeight ?? 32);
            }
            if (current.programsOpen !== open) current.programsEpoch = (current.programsEpoch ?? 0) + 1;
            current.programsOpen = open;
            if (!open) current.programsSlots = [];
            repaintMenu();
            const epoch = current.programsEpoch;
            if (focus) requestAnimationFrame(() => {
              if (!currentMenu(current) || current.programsOpen !== open || current.programsEpoch !== epoch) return;
              const document = current.window.document;
              const target = focus === 'trigger' ? document.getElementById('shell-all-programs') :
                Array.from(document.getElementById('shell-program-list')?.childNodes ?? []).find(node => node.tabIndex >= 0) ??
                  document.getElementById('shell-program-back');
              target?.focus();
            });
          }),
        }, desktopImages, options => applicationSearch(current, menuTheme, options),
        menuTheme.panel.taskGrouping === 'applications' ? {
          target: menuTheme.panel.kind === 'dock' ? 'Dock' : 'taskbar',
          id: launcherCatalogId,
          has: id => configuration.snapshot.launchers.applications.includes(id),
          change: scoped((id, expected) => host.displays().some(output => output.id === current.output) &&
            configuration.snapshot.launchers.applications.includes(id) === expected ?
            changeLauncherPin(id, !expected) : false),
        } : null),
        current.window.document.body);
      const search = current.search?.input.root;
      const slot = current.window.document.getElementById('shell-app-search-slot');
      if (search && slot && search.parentNode !== slot) slot.insertBefore(search, slot.firstChild);
      if (searchFocused && search && current.window.document.activeElement !== search) search.focus();
      return;
    }
    if (current.mode === 'desktop') {
      const bundle = bundles.get(current.output);
      if (!bundle) { closeMenu(); return; }
      const state = bundle.surfaces.wallpaper.desktopController.state;
      render(desktopMenuView(getDesktopTheme(themeId), { ...state, shortcuts: shortcutsFor(bundle) },
        desktopCatalog(), {
          open: scoped(id => launchApplication(id, current.output)),
          remove: scoped(() => removeDesktopShortcuts([...state.selected])),
          removeOne: scoped(id => removeDesktopShortcuts([id])),
          sort: scoped(() => sortDesktopShortcuts(current.output)),
          applications: scoped(() => showApplications(current.output)),
          settings: scoped(() => showSystemSettings(current.output)), close,
        }, desktopStatus || error), current.window.document.body);
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
    cancelDesktopInteractions();
    const theme = getDesktopTheme(themeId);
    const layout = theme.layout;
    const root = bundle.surfaces.wallpaper.window.document.body;
    const width = root.offsetWidth || bundle.output.width;
    const height = root.offsetHeight || bundle.output.height;
    try {
      menu = newSurface(bundle.output, 'menu', {
        layer: 'overlay', width: Math.max(1, Math.min(layout.menuWidth, width - layout.screenInset * 2)),
        height: applicationMenuHeight(theme, height),
        ...applicationMenuPlacement(theme, width),
        // Placement already includes panel/menu-bar offsets in full-output coordinates.
        exclusiveZone: -1,
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
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); closeMenu(current, current.mode === 'window-group');
      }
    });
    body.focus();
    repaintMenu();
    if (mode === 'applications' && currentMenu(current))
      current.window.document.getElementById('shell-app-search').focus();
    if (mode === 'window-group' && currentMenu(current))
      current.window.document.getElementById('shell-group-list')?.firstChild?.firstChild?.focus();
    return current.window;
  }

  function showSettings(outputId, about = false) {
    return about ? showSystemSettings(outputId, 'about') : openMenu(outputId, 'appearance');
  }

  function showManagedSettings(outputId, page) {
    return showSystemSettings(outputId, settingsPage(page));
  }

  function appearanceSnapshot() {
    return { version: 1, revision: appearanceRevision, catalogRevision: THEME_REVISION, themeId,
      catalog: { schemaVersion: 1, default: DEFAULT_DESKTOP_THEME, themes: DESKTOP_THEMES },
      themeFilesEnabled, themeFilesAvailable: typeof native?.readThemeFiles === 'function',
      status: appearanceStatus, error: ['settings', 'theme-files'].includes(errorKind) ? error : '', build: runtimeBuild() };
  }
  function aboutSnapshot() {
    return { version: 1, services: serviceMonitor.snapshot(), outputs: bundles.size, themeId, build: runtimeBuild(),
      applicationId: typeof application === 'undefined' ? 'PollyShell' : application.id,
      profiles: { display: displayPersistence.status,
        audio: configuration.snapshot.audio === null ? 'No saved audio profile' : 'Saved audio profile',
        workspace: configuration.snapshot.workspace === null ? 'No saved workspace profile' : 'Saved workspace profile' } };
  }
  function settingsFailure(failure) {
    error = 'Could not open Settings: ' + String(failure); errorKind = 'settings';
    report('[shell] ' + error); repaintMenu();
    for (const bundle of bundles.values()) paint(bundle, getDesktopTheme(themeId));
    return null;
  }
  function startSettingsBridge() {
    const scope = settingsScope;
    const handlers = { native, network: native, domains, appearance: appearanceSnapshot, about: aboutSnapshot,
      select: selectTheme, reload: reloadThemes, restore: restoreThemes,
      managed(page) {
        return showSystemSettings(host.displays()[0]?.id, page);
      }, report };
    if (settingsFactory) { settingsBridge = settingsFactory(handlers); return; }
    if (typeof application === 'undefined') {
      settingsStartupError = new Error('Independent Settings requires the SysRT private session-bus runtime');
      return;
    }
    settingsReady = import('./desktop/shell/settings-native.mjs').then(({ openShellSettings }) => {
      if (running && scope === settingsScope) settingsBridge = openShellSettings(handlers);
    }).catch(failure => { if (scope === settingsScope) settingsStartupError = failure; });
  }
  function showSystemSettings(outputId, page = 'appearance') {
    if (!running) throw new Error('Shell is not running');
    settingsPage(page);
    if (!bundles.has(outputId)) throw new RangeError('Unknown shell output');
    closeMenu();
    cancelDesktopInteractions();
    const open = () => {
      if (!running) throw new Error('Shell stopped before Settings could open');
      if (!settingsBridge) throw settingsStartupError || new Error('Independent Settings service is unavailable');
      return settingsBridge.open(page);
    };
    try {
      const result = settingsBridge ? open() : (settingsReady || Promise.resolve()).then(open);
      return result && typeof result.then === 'function' ? result.catch(settingsFailure) : result;
    } catch (failure) { return settingsFailure(failure); }
  }

  function shortcutFailure(failure) {
    error = 'Shortcut settings: ' + String(failure);
    errorKind = 'shortcuts';
    report('[shell] ' + error);
    repaintMenu();
    for (const bundle of bundles.values()) paint(bundle, getDesktopTheme(themeId));
  }

  function showShortcuts(outputId) {
    return showSystemSettings(outputId, 'keyboard');
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
      native.shortcuts();
      const stored = configuration.snapshot.shortcuts;
      if (stored !== null) native.setShortcuts(stored);
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
    return showSystemSettings(outputId, 'displays');
  }

  function finishDisplayChange(token, keep) {
    try {
      if (keep) native.confirmOutputConfiguration(token);
      else native.revertOutputConfiguration(token);
      if (keep && errorKind === 'outputs') { error = ''; errorKind = ''; }
      if (keep) {
        try { displayPersistence.save(native.outputConfiguration()); }
        catch (failure) { outputFailure((failure.committed ?
          'Changes and the startup profile were saved, but durability confirmation failed: ' :
          'Changes were kept, but the startup profile was not saved: ') + String(failure)); }
      }
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

  function liveTasks(workspaceId) {
    const current = typeof native.workspaces === 'function' ?
      native.workspaces().find(workspace => workspace.active)?.id : undefined;
    if (current !== workspaceId) return [];
    const live = native.windows().filter(window =>
      typeof native.workspaces !== 'function' || window.workspaceId === current);
    return windowTasks(live, getDesktopTheme(themeId).panel.taskGrouping, desktopCatalog(),
      configuration.snapshot.launchers.applications, current, applications);
  }

  function taskCallback(bundle, surface, context) {
    const workspaceId = workspaces.find(workspace => workspace.active)?.id;
    const grouping = getDesktopTheme(themeId).panel.taskGrouping ?? 'windows';
    const identities = new Map(displayTasks(getDesktopTheme(themeId)).map(task => [task.id, taskIdentity(task)]));
    return id => {
      if (!running || surface.window.closed || bundles.get(bundle.output.id)?.surfaces[surface.kind] !== surface ||
          (getDesktopTheme(themeId).panel.taskGrouping ?? 'windows') !== grouping) return false;
      try {
        if (!host.displays().some(output => output.id === bundle.output.id)) return false;
        const task = liveTasks(workspaceId).find(task => task.id === id);
        if (!task || taskIdentity(task) !== identities.get(id)) return false;
        if (task.launcher && !context && !task.unavailable) return launchApplication(task.catalogId, bundle.output.id);
        if (!task.grouped && !task.launcher) return context ? showWindowActions(bundle.output.id, id) : toggleWindow(id);
        if (task.launcher || context || task.count > 1) return openMenu(bundle.output.id, 'window-group', task.id, {
          groupAppId: task.appId, groupWorkspaceId: workspaceId, groupSlots: [],
          groupCatalogId: task.catalogId, groupLauncher: !!task.launcher,
          returnFocus: () => {
            try {
              if (!surface.window.closed && bundles.get(bundle.output.id)?.surfaces[surface.kind] === surface &&
                  host.displays().some(output => output.id === bundle.output.id) &&
                  liveTasks(workspaceId).some(item => item.id === id))
                surface.window.document.getElementById('shell-window-' + id)?.focus();
            } catch (failure) { windowFailure(failure); }
          },
        });
        const selected = task.windows[0];
        return getDesktopTheme(themeId).panel.kind === 'dock' ? windowAction(selected.id, 'activateWindow') :
          toggleWindow(selected.id);
      } catch (failure) { windowFailure(failure); return false; }
    };
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
      input.setAppearance(inputAppearance(theme));
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
    lastCatalogPoll = Date.now();
    try {
      applications = launcher.refresh();
      if (errorKind === 'application') { error = ''; errorKind = ''; }
    } catch (failure) {
      applications = [];
      error = 'Application discovery failed: ' + String(failure);
      errorKind = 'application';
      report('[shell] ' + error);
    }
    repaintMenu();
    refresh(true);
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

  function launchApplication(id, outputId = menu?.output || host.displays()[0]?.id) {
    if (!running) throw new Error('Application launcher is unavailable');
    if (id === SETTINGS_APPLICATION_ID) return showSystemSettings(outputId);
    if (!launcher) throw new Error('Application launcher is unavailable');
    const current = menu;
    const scope = applicationLaunchScope;
    const succeeded = result => {
      if (running && scope === applicationLaunchScope && menu === current) {
        if (errorKind === 'application') { error = ''; errorKind = ''; }
        closeMenu(current);
      }
      return result;
    };
    const failed = failure => {
      const message = 'Could not launch application: ' + String(failure);
      report('[shell] ' + message);
      if (running && scope === applicationLaunchScope && menu === current) {
        error = message;
        errorKind = 'application';
        repaintMenu();
        for (const bundle of bundles.values()) paintDesktop(bundle);
      }
      return null;
    };
    try {
      if (applicationForWindow(applications, SETTINGS_APPLICATION_ID)?.id === id) {
        applications = launcher.refresh();
        if (applicationForWindow(applications, SETTINGS_APPLICATION_ID)?.id === id)
          return showSystemSettings(outputId);
      }
      const result = launcher.launch(id);
      return result && typeof result.then === 'function' ? result.then(succeeded, failed) : succeeded(result);
    } catch (failure) { return failed(failure); }
  }

  function showNetwork(output) {
    closeMenu();
    return network.show(output);
  }
  function showAudio(output) {
    closeMenu();
    return showSystemSettings(output, 'audio');
  }
  function showPower(output) {
    closeMenu();
    return power.show(output);
  }
  function showLogout(output) {
    if (!running) throw new Error('Shell is not running');
    closeMenu();
    cancelDesktopInteractions();
    try { return logout.show(output); }
    catch (failure) {
      error = 'Logout is unavailable; this session is retained. ' + String(failure);
      errorKind = 'session-exit';
      report('[shell] ' + error);
      for (const bundle of bundles.values()) paint(bundle, getDesktopTheme(themeId));
      return null;
    }
  }

  function refresh(force = false) {
    if (!running) return;
    const now = Date.now();
    if (launcher && now - lastCatalogPoll >= 5000) {
      lastCatalogPoll = now;
      reloadApplications();
    }
    if (force || now - lastServicePoll >= 1000) {
      lastServicePoll = now;
      const nextError = serviceMonitor.refresh().message;
      if (nextError !== serviceError) {
        serviceError = nextError;
        repaintMenu();
      }
    }
    notifications.paint();
    sessionExit.refresh();
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
      if (launcher) reloadApplications();
      sessionExit.start();
      if (native && typeof native.beginSessionExit === 'function') {
        previousSessionExit = native.onSessionExitRequested;
        native.onSessionExitRequested = sessionExitRequested;
      }
      appearanceStatus = '';
      lastServicePoll = 0;
      try { reconcile(themeId, false); }
      catch (failure) {
        compositorAppearance = null;
        running = false; throw failure;
      }
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
      settingsStartupError = null;
      startSettingsBridge();
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
      compositorAppearance = null;
      iconScope = {};
      settingsScope = {};
      settingsBridge?.close(); settingsBridge = null; settingsReady = null;
      applicationLaunchScope = {};
      serviceMonitor.reset(); serviceError = '';
      notifications.stop();
      tray.stop();
      recorder.stop();
      network.stop();
      audio.stop();
      power.stop();
      sessionExit.stop();
      logout.stop();
      if (native && native.onSessionExitRequested === sessionExitRequested)
        native.onSessionExitRequested = previousSessionExit;
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
      iconResources?.close(); iconResources = null; iconLoading = false; iconLoadError = null;
      desktopImages.clear(); desktopImageErrors.clear();
      releaseThemeAsset(themeAsset); themeAsset = ''; themeAssetSource = '';
    },
    selectTheme, reloadThemes, restoreThemes, showSettings, showSystemSettings, showManagedSettings,
    showApplications, launchApplication, addDesktopShortcut, removeDesktopShortcuts, sortDesktopShortcuts,
    showWindowActions, showWorkspaces, showShortcuts, showDisplays,
    showNotifications: notifications.show, showNetwork, showAudio, showPower, showLogout, refresh,
    sessionExit,
    getSettingsState: () => settingsBridge?.getState() || { pid: 0, connected: false, error: String(settingsStartupError || '') },
    getState() {
      const services = serviceMonitor.snapshot();
      return { themeId, error: error || services.error,
        services, outputs: [...bundles.keys()], running, themeFilesEnabled, themeRevision: THEME_REVISION };
    },
    getSurfaces() { return [...bundles.values()].flatMap(bundle => Object.values(bundle.surfaces)); },
  };
}
