import { h, render } from './gui/sdk/js/reconciler.mjs';
import { DEFAULT_DESKTOP_THEME, getDesktopTheme } from './desktop/shared/ui/themes.mjs';
import { settingsView } from './desktop/apps/settings/ui/appearance.mjs';
import { systemSettingsView, aboutSettingsView } from './desktop/apps/settings/ui/frame.mjs';
import { SETTINGS_APP_ID, SETTINGS_VERSION, runtimeBuild, buildLabel } from './desktop/client/settings-contract.mjs';
import { desktopCommand, themedText, settingsCard, scrollDesktop } from './desktop/shared/ui/presentation.mjs';
import { selectionInk } from './desktop/shared/ui/surface-primitives.mjs';
import { createSettingsController } from './desktop/apps/settings/logic/controller.mjs';
import { createSettingsNetworkClient } from './desktop/apps/settings/network-client.mjs';
import { createNetworkSettings } from './desktop/apps/settings/ui/network.mjs';
import { createSettingsPages } from './desktop/apps/settings/logic/pages.mjs';
import { createDisplayPage } from './desktop/apps/settings/ui/display-page.mjs';
import { audioSettingsView } from './desktop/apps/settings/ui/audio.mjs';
import { shortcutsView } from './desktop/apps/settings/ui/keyboard.mjs';
import { createWallpaperMaterial } from './desktop/shared/ui/material.mjs';
import { parseMaterialSource } from './desktop/client/settings-contract.mjs';

export function createSettingsApp({ client, page = 'appearance', host = window, report = console.error,
  identity = typeof application === 'undefined' ? { id: SETTINGS_APP_ID } : application,
  onStop = () => {}, optInMaterial = false }) {
  if (typeof optInMaterial !== 'boolean') throw new TypeError('Settings material opt-in must be boolean');
  let surface = null, timer = null, pageTimer = null, stopped = false, revision = 0, details = false;
  let material = null, materialUnsubscribe = null, materialKey = '', materialInput = '', materialStatusPaint = false;
  let materialGeneration = 0, materialReady = false, materialError = '', materialSource = null, materialLoading = false;
  const ownBuild = runtimeBuild(identity);
  let currentTheme = getDesktopTheme(DEFAULT_DESKTOP_THEME);
  const networkClient = createSettingsNetworkClient(client, report);
  const network = createNetworkSettings({ native: networkClient, host, theme: () => currentTheme, report });
  const pages = createSettingsPages({ client, changed: paint, report });
  const displays = createDisplayPage();
  const controller = createSettingsController({ client, page, changed: paint, report });
  function materialPresentation() {
    if (!surface || surface.closed || stopped) return;
    const root = surface.document.getElementById('shell-system-settings');
    if (root) root.style.backgroundColor = materialReady ? 'transparent' : currentTheme.colors.body;
    if (material) material.canvas.style.display = materialReady ? 'flex' : 'none';
  }
  function setMaterialError(message) {
    if (materialError === message) return;
    materialError = message;
    if (materialStatusPaint) return;
    materialStatusPaint = true;
    Promise.resolve().then(() => {
      materialStatusPaint = false;
      if (!stopped && !surface.closed) paint();
    });
  }
  function retireMaterial() {
    materialGeneration++; materialReady = false; materialSource = null; materialLoading = false; materialInput = '';
    material?.dispose(); material = null;
  }
  function materialFailure(error, generation) {
    if (stopped || surface?.closed || generation !== materialGeneration) return;
    retireMaterial();
    setMaterialError(String(error.message || error));
    report('[settings material] ' + materialError);
    materialPresentation();
  }
  function updateMaterialPixels() {
    if (!materialSource || materialError || stopped || surface.closed) return;
    const state = surface.state;
    if (state.width < 1 || state.height < 1) return;
    const input = JSON.stringify([materialKey, state.width, state.height, state.scale, state.active]);
    if (input === materialInput) return;
    materialInput = input;
    const generation = materialGeneration;
    try {
      if (!material) {
        material = createWallpaperMaterial({ document: surface.document, onError: error => materialFailure(error, generation) });
        material.canvas.id = 'settings-material-base';
        material.canvas.setAttribute('aria-hidden', 'true');
        Object.assign(material.canvas.style, { position: 'absolute', left: '0', top: '0', pointerEvents: 'none' });
        surface.document.body.insertBefore(material.canvas, surface.document.body.firstChild);
      }
      const owner = material;
      materialReady = false; materialPresentation();
      owner.update({ theme: currentTheme, width: state.width, height: state.height, scale: state.scale,
        active: state.active, asset: materialSource.dataURL, sourceRevision: materialSource.revision }).then(() => {
        if (stopped || surface.closed || generation !== materialGeneration || owner !== material || input !== materialInput) return;
        materialReady = owner.stats.ready; materialPresentation();
      }, error => materialFailure(error, generation));
    } catch (error) { materialFailure(error, generation); }
  }
  function syncMaterial() {
    if (!optInMaterial || stopped || !surface || surface.closed) return;
    const { appearance, unavailable } = controller.getState();
    if (!appearance || unavailable || currentTheme.window.clientMaterial !== 'wallpaper') {
      if (materialKey) retireMaterial();
      materialKey = ''; setMaterialError('');
      materialUnsubscribe?.(); materialUnsubscribe = null;
      materialPresentation();
      return;
    }
    const key = JSON.stringify([appearance.revision, appearance.catalogRevision, currentTheme]);
    if (key !== materialKey) {
      retireMaterial(); setMaterialError(''); materialKey = key;
      materialPresentation();
      const generation = materialGeneration;
      try {
        if (!materialUnsubscribe) materialUnsubscribe = surface.observeState(() => syncMaterial());
        if (currentTheme.desktop.asset) {
          materialLoading = true;
          Promise.resolve().then(() => {
            if (stopped || generation !== materialGeneration) return null;
            if (typeof client.getMaterialSource !== 'function') throw new Error('Authenticated wallpaper source is unavailable');
            return client.getMaterialSource(appearance);
          }).then(source => {
            if (stopped || surface.closed || generation !== materialGeneration) return;
            const checked = parseMaterialSource(JSON.stringify(source));
            if (checked.themeId !== appearance.themeId || checked.revision !== appearance.revision)
              throw new Error('Wallpaper source no longer matches the displayed appearance');
            materialLoading = false; materialSource = checked; updateMaterialPixels();
          }).catch(error => materialFailure(error, generation));
        } else materialSource = { dataURL: '', revision: appearance.revision };
      } catch (error) { materialFailure(error, generation); }
    }
    if (!materialLoading) updateMaterialPixels();
  }
  function paint() {
    if (stopped || !surface || surface.closed) return;
    const state = controller.getState(), scope = ++revision;
    const theme = state.appearance ?
      state.appearance.catalog.themes.find(theme => theme.id === state.appearance.themeId) : getDesktopTheme(DEFAULT_DESKTOP_THEME);
    currentTheme = theme;
    const guarded = action => (...args) => { if (!stopped && scope === revision) return action(...args); };
    const available = action => guarded((...args) => {
      if (!controller.getState().busy && !controller.getState().unavailable && controller.getState().appearance)
        return action(...args);
    });
    const label = text => themedText(theme, text, theme.colors.text, theme.layout.fontSize, { flexShrink: 1 });
    const build = state.appearance?.build || ownBuild;
    let content;
    if (state.page === 'appearance') {
      content = settingsView(theme, available(controller.select), stop, guarded(controller.refresh),
        state.error || state.appearance?.error || '', false, null, null, null, null,
        state.appearance?.themeFilesAvailable ? { enabled: state.appearance.themeFilesEnabled,
          reload: available(controller.reload), restore: available(controller.restore) } : null,
        null, true, state.busy ? 'Waiting for Shell acknowledgement...' : state.appearance?.status || '',
        state.appearance?.catalog.themes);
    } else if (state.page === 'network') {
      content = h('view', { id: 'settings-network-slot', style: { minHeight: 0, flexGrow: 1, flexBasis: 0 },
        onMount: node => network.attach(surface, node) });
    } else if (['displays', 'audio', 'keyboard'].includes(state.page)) {
      const { snapshot, busy, error } = pages.getState();
      const command = guarded(pages.command);
      let pageContent = null;
      if (!snapshot) pageContent = label('Loading ' + state.page + ' service state...');
      else if (state.page === 'displays') {
        pageContent = h('view', { id: 'settings-display-slot', style: { minHeight: 0, flexGrow: 1, flexBasis: 0 } });
      } else if (state.page === 'audio') {
        pageContent = audioSettingsView(theme, snapshot, busy, command);
      } else if (!snapshot.available) pageContent = label('Trusted shortcut management is unavailable in this session.');
      else {
        const action = (operation, action = '') => command('KeyboardAction',
          JSON.stringify({ revision: snapshot.revision, operation, action }));
        pageContent = h('view', { style: { minHeight: 0, flexGrow: 1, flexBasis: 0, gap: theme.layout.contentGap } },
          shortcutsView(theme, snapshot.bindings, snapshot.recording?.action || null,
            id => action('record', id), id => action('disable', id), () => action('reset'), () => {}, snapshot.error),
          label('Recording uses a small trusted focus-bound prompt. It is not another Settings window or a global keyboard hook.'),
          snapshot.recording ? desktopCommand('settings-keyboard-cancel', 'Cancel recording', theme,
            guarded(() => pages.command('CancelShortcutRecording', snapshot.recording.token)), { enabled: !busy }) : null);
      }
      content = h('view', { style: { minHeight: 0, flexGrow: 1, flexBasis: 0, gap: theme.layout.contentGap } },
        state.error || error ? h('view', { role: 'alert' }, label(state.error || error)) : null,
        pageContent);
    } else {
      content = h('view', { style: { minHeight: 0, gap: theme.layout.contentGap, flexShrink: 0 } },
        state.error && state.about ? h('view', { role: 'alert' }, label(state.error)) : null,
        state.about ? aboutSettingsView(theme, state.about) : label(state.error || 'Inspecting the running desktop...'),
        desktopCommand('settings-about-details', details ? 'Hide technical details' : 'Technical details', theme,
          guarded(() => { details = !details; paint(); }), { quiet: true, icon: 'info' }),
        details ? settingsCard(theme, 'Technical details', 'Settings app version is separate from the system release.', [
          label('Settings application: ' + SETTINGS_VERSION + ' | ' + identity.id),
          label('Settings runtime: ' + buildLabel(ownBuild)),
          label('Settings full revision: ' + ownBuild.revision),
          state.about ? label('Management owner: ' + state.about.applicationId) : null,
          identity.configDir ? label('Application preferences: ' + identity.configDir) : null,
          identity.dataDir ? label('Application data: ' + identity.dataDir) : null,
          label('Entry: desktop/apps/settings/main.mjs'),
          state.about ? label('Profiles: display ' + state.about.profiles.display + ' | audio ' +
            state.about.profiles.audio + ' | workspace ' + state.about.profiles.workspace) : null,
          label('Closing Settings leaves desktop services and other applications running.'),
        ]) : null);
    }
    const tree = systemSettingsView(theme, state.page, guarded(page => {
      navigate(page);
      surface.document.getElementById('shell-settings-page-' + page)?.focus();
    }), stop, content, null, 'Settings', [], build);
    if (optInMaterial) tree.children.splice(tree.children.length - 1, 0,
      h('view', { id: 'settings-material-status', role: 'status', onWheel: scrollDesktop,
        style: { display: materialError ? 'flex' : 'none', minWidth: 0, maxHeight: '25%', flexShrink: 0,
          padding: theme.layout.compactPadding, paddingLeft: theme.layout.contentPadding, overflow: 'scroll' } },
      themedText(theme, materialError ? 'Wallpaper material unavailable: ' + materialError : '',
        theme.colors.text, theme.layout.statusFontSize, { minWidth: 0 })));
    if (optInMaterial && materialReady) tree.props.style.backgroundColor = 'transparent';
    if (JSON.stringify(build) !== JSON.stringify(ownBuild))
      tree.children.push(h('view', { role: 'status', style: { padding: theme.layout.compactPadding, flexShrink: 0,
        backgroundColor: theme.colors.selection } }, themedText(theme, 'Settings runtime differs: ' + buildLabel(ownBuild),
        selectionInk(theme, theme.colors.text), theme.layout.statusFontSize, { flexShrink: 1 })));
    if (state.busy || !state.appearance)
      tree.props['aria-busy'] = 'true';
    function disable(node) {
      if (node.props?.id && /^(shell-theme-)/.test(node.props.id) &&
          (state.busy || state.unavailable || !state.appearance)) {
        node.props['aria-disabled'] = 'true'; node.props.tabIndex = -1;
        node.props.style.opacity = theme.layout.disabledOpacity;
      }
      if (node.props?.id === 'shell-shortcuts-close') {
        node.props.style.display = 'none'; node.props.tabIndex = -1;
      }
      if (state.page === 'keyboard' && node.props?.id?.startsWith('shell-shortcut') &&
          (pages.getState().busy || pages.getState().snapshot?.recording)) {
        if (node.props.role === 'button') {
          node.props['aria-disabled'] = 'true'; node.props.tabIndex = -1;
          node.props.onClick = node.props.onKeydown = () => {};
        }
      }
      node.children?.forEach(disable);
    }
    disable(tree);
    render(tree, surface.document.body);
    syncMaterial();
    if (state.page === 'network') network.refresh();
    if (state.page === 'displays' && pages.getState().snapshot) {
      const { snapshot, busy } = pages.getState();
      const slot = surface.document.getElementById('settings-display-slot');
      if (slot) displays.paint(slot, theme, snapshot, busy, guarded(pages.command), paint);
    }
  }
  function navigate(page) {
    if (controller.getState().page === 'network') { network.detach(); networkClient.stopNetwork(); }
    displays.detach(); pages.detach();
    surface.document.activeElement?.blur(); render(null, surface.document.body);
    controller.navigate(page); pages.activate(page);
  }
  function keydown(event) {
    if (!event.isComposing && !event.defaultPrevented && event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); stop();
    }
  }
  function stop() {
    if (stopped) return;
    stopped = true; revision++;
    materialUnsubscribe?.(); materialUnsubscribe = null;
    retireMaterial();
    if (timer !== null) clearInterval(timer);
    if (pageTimer !== null) clearInterval(pageTimer);
    surface?.document.body.removeEventListener('keydown', keydown);
    network.stop(); networkClient.close(); pages.close(); displays.detach(); controller.close(); onStop();
    if (surface && !surface.closed) surface.close();
  }
  return Object.freeze({
    controller, pages, stop, getWindow: () => surface,
    getMaterialState: () => Object.freeze({ ready: materialReady, error: materialError, stats: material?.stats || null }),
    present(page) {
      if (stopped) throw new Error('Settings instance is closed');
      return navigate(page);
    },
    start() {
      if (stopped) throw new Error('Closed Settings cannot restart');
      if (surface) return this;
      surface = host.create({ title: 'Settings', width: 900, height: 650 });
      surface.onclose = stop; surface.document.body.tabIndex = 0;
      surface.document.body.addEventListener('keydown', keydown);
      host.close(); paint(); surface.document.body.focus();
      pages.activate(page); controller.refresh(); timer = setInterval(controller.refresh, 1000);
      pageTimer = setInterval(pages.refresh, 250);
      return this;
    },
  });
}
