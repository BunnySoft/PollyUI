import { h, render } from './gui/sdk/js/reconciler.mjs';
import { DEFAULT_DESKTOP_THEME, getDesktopTheme } from './desktop/shell/themes.mjs';
import { settingsView } from './desktop/shell/views.mjs';
import { systemSettingsView, aboutSettingsView } from './desktop/shell/settings.mjs';
import { SETTINGS_APP_ID, SETTINGS_VERSION, MANAGED_PAGES, runtimeBuild, buildLabel } from './desktop/client/settings-contract.mjs';
import { desktopCommand, desktopIcon, desktopText, settingsCard, horizontal } from './desktop/shell/presentation.mjs';
import { createSettingsController } from './desktop/apps/settings/logic/controller.mjs';

export function createSettingsApp({ client, page = 'appearance', host = window, report = console.error,
  identity = typeof application === 'undefined' ? { id: SETTINGS_APP_ID } : application,
  onStop = () => {} }) {
  let surface = null, timer = null, stopped = false, revision = 0, details = false;
  const ownBuild = runtimeBuild(identity);
  const controller = createSettingsController({ client, page, changed: paint, report });
  function paint() {
    if (stopped || !surface || surface.closed) return;
    const state = controller.getState(), scope = ++revision;
    const theme = state.appearance ?
      state.appearance.catalog.themes.find(theme => theme.id === state.appearance.themeId) : getDesktopTheme(DEFAULT_DESKTOP_THEME);
    const guarded = action => (...args) => { if (!stopped && scope === revision) return action(...args); };
    const available = action => guarded((...args) => {
      if (!controller.getState().busy && !controller.getState().unavailable && controller.getState().appearance)
        return action(...args);
    });
    const label = text => desktopText(text, theme.colors.text, 14, { flexShrink: 1 });
    const build = state.appearance?.build || ownBuild;
    let content;
    if (state.page === 'appearance') {
      content = settingsView(theme, available(controller.select), stop, guarded(controller.refresh),
        state.error || state.appearance?.error || '', false, null, null, null, null,
        state.appearance?.themeFilesAvailable ? { enabled: state.appearance.themeFilesEnabled,
          reload: available(controller.reload), restore: available(controller.restore) } : null,
        null, true, state.busy ? 'Waiting for Shell acknowledgement...' : state.appearance?.status || '',
        state.appearance?.catalog.themes);
    } else if (MANAGED_PAGES.includes(state.page)) {
      const descriptions = {
        displays: ['Connected displays', 'Resolution, scale, arrangement and confirmed display profiles.'],
        network: ['Wi-Fi connections', 'Available networks, connection status and saved Wi-Fi preferences.'],
        audio: ['Sound devices', 'Outputs, microphones, volume and the preferred audio device.'],
        keyboard: ['Keyboard shortcuts', 'Choose and record desktop shortcuts for window and workspace actions.'],
      };
      content = h('view', { style: { padding: 8, gap: 16, flexShrink: 0 } },
        settingsCard(theme, descriptions[state.page][0], descriptions[state.page][1], [
          h('view', { style: { ...horizontal, gap: 14, flexWrap: 'wrap' } },
            desktopIcon(state.page, theme.colors.accent, 36),
            desktopCommand('settings-open-managed-' + state.page, 'Open desktop controls', theme,
              available(() => controller.managed(state.page)), { icon: 'open' })),
          desktopText('Opens a separate desktop control panel. Settings stays open.', theme.colors.muted, 13),
        ]),
        desktopText('These controls are managed by the desktop Shell, not by the Settings application.',
          theme.colors.muted, 13, { flexShrink: 1 }),
        state.busy ? h('view', { role: 'status' }, label('Opening desktop controls...')) : null,
        state.error ? h('view', { role: 'alert' }, label(state.error)) : null);
    } else {
      content = h('view', { style: { minHeight: 0, gap: 12, flexShrink: 0 } },
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
      surface.document.activeElement?.blur();
      render(null, surface.document.body);
      controller.navigate(page);
      surface.document.getElementById('shell-settings-page-' + page)?.focus();
    }), stop, content, null, 'Settings', [], build);
    if (JSON.stringify(build) !== JSON.stringify(ownBuild))
      tree.children.push(h('view', { role: 'status', style: { padding: 8, flexShrink: 0,
        backgroundColor: theme.colors.selection } }, label('Settings runtime differs: ' + buildLabel(ownBuild))));
    if (state.busy || !state.appearance)
      tree.props['aria-busy'] = 'true';
    function disable(node) {
      if (node.props?.id && /^(shell-theme-|settings-open-managed-)/.test(node.props.id) &&
          (state.busy || state.unavailable || !state.appearance)) {
        node.props['aria-disabled'] = 'true'; node.props.tabIndex = -1;
        node.props.style.opacity = theme.layout.disabledOpacity;
      }
      node.children?.forEach(disable);
    }
    disable(tree);
    render(tree, surface.document.body);
  }
  function keydown(event) {
    if (!event.defaultPrevented && event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); stop();
    }
  }
  function stop() {
    if (stopped) return;
    stopped = true; revision++;
    if (timer !== null) clearInterval(timer);
    surface?.document.body.removeEventListener('keydown', keydown);
    controller.close(); onStop();
    if (surface && !surface.closed) surface.close();
  }
  return Object.freeze({
    controller, stop, getWindow: () => surface,
    present(page) {
      if (stopped) throw new Error('Settings instance is closed');
      surface.document.activeElement?.blur(); render(null, surface.document.body);
      return controller.navigate(page);
    },
    start() {
      if (stopped) throw new Error('Closed Settings cannot restart');
      if (surface) return this;
      surface = host.create({ title: 'Settings', width: 900, height: 650 });
      surface.onclose = stop; surface.document.body.tabIndex = 0;
      surface.document.body.addEventListener('keydown', keydown);
      host.close(); paint(); surface.document.body.focus();
      controller.refresh(); timer = setInterval(controller.refresh, 1000);
      return this;
    },
  });
}
