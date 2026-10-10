import { h, render } from './gui/sdk/js/reconciler.mjs';
import { DEFAULT_DESKTOP_THEME, getDesktopTheme } from './desktop/shell/themes.mjs';
import { settingsView, button } from './desktop/shell/views.mjs';
import { systemSettingsView, aboutSettingsView } from './desktop/shell/settings.mjs';
import { SETTINGS_APP_ID, SETTINGS_VERSION, MANAGED_PAGES } from './desktop/client/settings-contract.mjs';
import { createSettingsController } from './desktop/apps/settings/logic/controller.mjs';

export function createSettingsApp({ client, page = 'appearance', host = window, report = console.error,
  identity = typeof application === 'undefined' ? { id: SETTINGS_APP_ID } : application,
  onStop = () => {} }) {
  let surface = null, timer = null, stopped = false, revision = 0;
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
    const label = text => h('view', { style: { color: theme.colors.text, fontSize: theme.layout.fontSize } }, text);
    let content;
    if (state.page === 'appearance') {
      content = settingsView(theme, available(controller.select), stop, guarded(controller.refresh),
        state.error || state.appearance?.error || '', false, null, null, null, null,
        state.appearance?.themeFilesAvailable ? { enabled: state.appearance.themeFilesEnabled,
          reload: available(controller.reload), restore: available(controller.restore) } : null,
        null, true, state.busy ? 'Waiting for Shell acknowledgement...' : state.appearance?.status || '',
        state.appearance?.catalog.themes);
    } else if (MANAGED_PAGES.includes(state.page)) {
      content = h('view', { style: { padding: theme.layout.contentPadding, gap: theme.layout.contentGap } },
        label('This control remains in the trusted desktop Shell.'),
        label('Settings does not own display, Wi-Fi, audio or keyboard management connections.'),
        button('settings-open-managed-' + state.page, 'Open in desktop control panel', theme,
          available(() => controller.managed(state.page))),
        state.error ? label(state.error) : null);
    } else {
      content = h('view', { style: { height: '100%', minHeight: 0, overflow: 'scroll' } },
        label('Settings ' + SETTINGS_VERSION + ' | ' + identity.id),
        identity.configDir ? label('Application preferences: ' + identity.configDir) : null,
        identity.dataDir ? label('Application data: ' + identity.dataDir) : null,
        label('Entry: desktop/apps/settings/main.mjs'),
        state.error && state.about ? h('view', { role: 'alert' }, label(state.error)) : null,
        state.about ? aboutSettingsView(theme, state.about) : label(state.error || 'Inspecting the running desktop...'),
        state.about ? label('Profiles: display ' + state.about.profiles.display + ' | audio ' +
          state.about.profiles.audio + ' | workspace ' + state.about.profiles.workspace) : null);
    }
    const tree = systemSettingsView(theme, state.page, guarded(page => {
      surface.document.activeElement?.blur();
      render(null, surface.document.body);
      controller.navigate(page);
      surface.document.getElementById('shell-settings-page-' + page)?.focus();
    }), stop, content);
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
