import { render } from './js/reconciler.mjs';
import { DEFAULT_DESKTOP_THEME, getDesktopTheme } from './desktop/shell/themes.mjs';
import { wallpaper, panelView, dockView, settingsView, applicationsView } from './desktop/shell/views.mjs';
import { createApplicationLauncher } from './desktop/shell/applications.mjs';

export const SHELL_THEME_KEY = 'desktop.theme';

export function createDesktopShell({ host = window, storage = localStorage, report = console.error,
  native = typeof desktop === 'undefined' ? null : desktop } = {}) {
  const bundles = new Map();
  let themeId = DEFAULT_DESKTOP_THEME;
  let error = '';
  let errorKind = '';
  let timer = null;
  let menu = null;
  let running = false;
  let lastFailure = '';
  let applications = [];
  const launcher = native ? createApplicationLauncher(native, report) : null;
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
    const old = menu;
    menu = null;
    closeSurface(old);
  }

  function newSurface(output, kind, options) {
    const native = host.create({ title: `PollyShell.${kind}.${output.id}`, output: output.id, ...options });
    const surface = { output: output.id, kind, window: native, signature: JSON.stringify(options), expectedClose: false };
    native.onclose = () => {
      if (surface === menu) menu = null;
      if (!surface.expectedClose && running && kind !== 'settings') {
        lastFailure = '';
      }
    };
    return surface;
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
      layer: 'top', width: Math.max(1, Math.min(320, output.width - 16)), height: theme.panel.height,
      anchors: ['bottom'], margins: { bottom: theme.panel.inset }, exclusiveZone: theme.panel.height,
      transparent: true,
    };
    return result;
  }

  function paint(bundle, theme) {
    const { wallpaper: background, panel, dock } = bundle.surfaces;
    if (!background.window.closed) render(wallpaper(theme, 'shell-wallpaper'), background.window.document.body);
    if (!panel.window.closed) render(panelView(theme, clock(), () => showApplications(bundle.output.id),
      error, () => showSettings(bundle.output.id)),
      panel.window.document.body);
    if (dock && !dock.window.closed) render(dockView(theme, () => showSettings(bundle.output.id),
      () => showSettings(bundle.output.id, true), () => showApplications(bundle.output.id)), dock.window.document.body);
  }

  function reconcile(nextTheme, persist) {
    const theme = getDesktopTheme(nextTheme);
    const outputs = host.displays();
    const staged = [];
    const plans = [];
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
      if (persist) storage.setItem(SHELL_THEME_KEY, nextTheme);
    } catch (failure) {
      for (const surface of staged) closeSurface(surface);
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
    if (menu.mode === 'applications') {
      render(applicationsView(getDesktopTheme(themeId), applications, menu.query,
        value => { if (menu) { menu.query = value; repaintMenu(); } },
        launchApplication, reloadApplications, closeMenu, error), menu.window.document.body);
      return;
    }
    render(settingsView(getDesktopTheme(themeId), selectTheme, closeMenu, () => refresh(true),
      error, menu.about), menu.window.document.body);
  }

  function openMenu(outputId, mode) {
    if (!running) throw new Error('Shell is not running');
    const bundle = bundles.get(outputId);
    if (!bundle) throw new RangeError('Unknown shell output');
    if (menu && menu.output === outputId && menu.mode === mode) { closeMenu(); return null; }
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
    menu.about = mode === 'about';
    menu.query = '';
    const body = menu.window.document.body;
    body.tabIndex = 0;
    body.addEventListener('keydown', event => {
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

  function refresh(force = false) {
    if (!running) return;
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
      return this;
    },
    stop() {
      running = false;
      if (timer !== null) clearInterval(timer);
      timer = null;
      if (native && native.onExit === exited) native.onExit = previousExit;
      closeMenu();
      for (const bundle of bundles.values())
        for (const surface of Object.values(bundle.surfaces)) closeSurface(surface);
      bundles.clear();
    },
    selectTheme, showSettings, showApplications, launchApplication, refresh,
    getState() { return { themeId, error, outputs: [...bundles.keys()], running }; },
    getSurfaces() { return [...bundles.values()].flatMap(bundle => Object.values(bundle.surfaces)); },
  };
}
