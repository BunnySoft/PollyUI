import { h } from './gui/sdk/js/reconciler.mjs';
import { button } from './desktop/shell/views.mjs';
import { themeTextSize } from './desktop/shell/theme-layout.mjs';

export const SETTINGS_APPLICATION_ID = 'org.pollyui.shell.Settings';
export const SETTINGS_PAGES = ['appearance', 'displays', 'network', 'audio', 'keyboard', 'about'];
const titles = { appearance: 'Appearance', displays: 'Displays', network: 'Network',
  audio: 'Audio', keyboard: 'Keyboard', about: 'About' };

export function systemSettingsView(theme, page, navigate, close, content, mount = null) {
  return h('view', { id: 'shell-system-settings', style: {
    width: '100%', height: '100%', minHeight: 0, backgroundColor: theme.colors.body,
  } },
  h('view', { style: { flexDirection: 'row', alignItems: 'center', flexShrink: 0,
    padding: theme.layout.compactPadding, gap: theme.layout.contentGap,
    backgroundColor: theme.colors.surface, borderBottomWidth: theme.layout.borderWidth,
    borderColor: theme.colors.border } },
    h('view', { style: { color: theme.colors.text, fontSize: theme.layout.largeHeadingFontSize } }, 'Settings'),
    h('view', { style: { flexGrow: 1 } }),
    button('shell-system-settings-close', 'Close', theme, close)),
  h('view', { style: { flexDirection: 'row', flexGrow: 1, flexBasis: 0, minHeight: 0 } },
    h('view', { role: 'navigation', 'aria-label': 'Settings pages', style: {
      width: 142, flexShrink: 0, padding: theme.layout.controlGap, gap: theme.layout.controlGap,
      overflow: 'scroll', backgroundColor: theme.colors.surface,
      borderRightWidth: theme.layout.borderWidth, borderColor: theme.colors.border,
    } }, SETTINGS_PAGES.map(id => {
      const item = button('shell-settings-page-' + id, titles[id], theme, () => navigate(id), page === id,
        { height: theme.layout.choiceHeight, alignItems: 'flex-start' });
      item.props['aria-current'] = page === id ? 'page' : null;
      return item;
    })),
    h('view', { id: 'shell-settings-content', role: 'region', 'aria-label': titles[page],
      style: { flexGrow: 1, flexBasis: 0, minWidth: 0, minHeight: 0 },
      ...(mount ? { onMount: mount } : {}),
    }, content)));
}

export function unavailableSettingsView(theme, title, explanation) {
  return h('view', { style: { padding: theme.layout.contentPadding, gap: theme.layout.contentGap } },
    h('view', { style: { color: theme.colors.text, fontSize: theme.layout.sectionFontSize } }, title),
    h('view', { role: 'status', style: { color: theme.colors.muted,
      fontSize: themeTextSize(theme, 12) } }, explanation),
    h('view', { role: 'button', 'aria-disabled': 'true', tabIndex: -1,
      style: { padding: theme.layout.serviceButtonPadding, color: theme.colors.muted,
        backgroundColor: theme.colors.surface, opacity: theme.layout.disabledOpacity } }, 'Unavailable in this session'));
}

export function aboutSettingsView(theme, { services, outputs, themeId, applicationId }) {
  const label = text => h('view', { style: { color: theme.colors.text,
    fontSize: themeTextSize(theme, 12), flexShrink: 0 } }, text);
  return h('view', { id: 'shell-settings-about', style: { height: '100%', padding: theme.layout.contentPadding,
    gap: theme.layout.contentGap, overflow: 'scroll' } },
    label('PollyDesktop - PollyWM + native PollyUI'),
    label('Development build. Release version is not exposed by this runtime.'),
    label('Settings owner: ' + applicationId),
    label('Session: ordinary-user desktop; management stays on the trusted Shell connection.'),
    label('Appearance: ' + themeId + ' | Active displays: ' + outputs),
    label('Input method: ' + services.inputMethod + ' | Private audio: ' + services.audio),
    services.message ? h('view', { role: 'status' }, label(services.message)) : null,
    label('Login and locking depend on the deployed session policy; this page does not certify either.'),
    label('Account, password and administrator changes require a separate qualified authentication interface.'),
    h('view', { role: 'button', 'aria-disabled': 'true', tabIndex: -1,
      style: { color: theme.colors.muted, opacity: theme.layout.disabledOpacity } }, 'Manage accounts (unavailable here)'),
    label('Changes use existing user preferences and service profiles. A memory-only Live session does not retain them after reboot.'),
    label('Closing Settings leaves the desktop, audio policy and other applications running.'));
}
