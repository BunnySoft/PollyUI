import { h } from './gui/sdk/js/reconciler.mjs';
import { desktopCommand, desktopIcon, desktopText, settingsCard, horizontal, scrollDesktop } from './desktop/shared/ui/presentation.mjs';
import { SETTINGS_APP_ID, SETTINGS_PAGES, runtimeBuild, buildLabel } from './desktop/client/settings-contract.mjs';

export const SETTINGS_APPLICATION_ID = SETTINGS_APP_ID;
export { SETTINGS_PAGES };
const titles = { appearance: 'Appearance', displays: 'Displays', network: 'Network',
  audio: 'Audio', keyboard: 'Keyboard', about: 'About' };

export function systemSettingsView(theme, page, navigate, close, content, mount = null, title = 'Settings', controls = [],
  build = runtimeBuild()) {
  return h('view', { id: 'shell-system-settings', style: {
    width: '100%', height: '100%', minHeight: 0, backgroundColor: theme.colors.body, overflow: 'hidden',
  } },
  h('view', { style: { flexDirection: 'row', flexGrow: 1, flexBasis: 0, minHeight: 0 } },
    h('view', { role: 'navigation', 'aria-label': 'Settings pages', style: {
      width: 196, minWidth: 142, flexShrink: 1, padding: 12, gap: 6,
      overflow: 'scroll', backgroundColor: theme.colors.body,
    }, onWheel: scrollDesktop },
    h('view', { style: { ...horizontal, gap: 10, height: 64, paddingLeft: 10, flexShrink: 0 } },
      desktopIcon('appearance', theme.colors.accent, 28), desktopText('Settings', theme.colors.text, 20, { fontWeight: 600 })),
    SETTINGS_PAGES.map(id => {
      const item = desktopCommand('shell-settings-page-' + id, titles[id], theme, () => navigate(id),
        { icon: id, quiet: true, selected: page === id, style: { height: 42 } });
      item.props['aria-current'] = page === id ? 'page' : null;
      return item;
    })),
    h('view', { style: { flexGrow: 1, flexBasis: 0, minWidth: 0, minHeight: 0, paddingTop: 18, paddingRight: 20 } },
      h('view', { style: { ...horizontal, flexShrink: 0, gap: 12, padding: 8, paddingBottom: 18, flexWrap: 'wrap' } },
        desktopText(titles[page], theme.colors.text, 26, { fontWeight: 600 }),
        h('view', { style: { flexGrow: 1 } }), controls),
      h('view', { id: 'shell-settings-content', role: 'region', 'aria-label': titles[page],
        style: { flexGrow: 1, flexBasis: 0, minWidth: 0, minHeight: 0, maxWidth: 900, overflow: 'scroll' },
        onWheel: scrollDesktop, ...(mount ? { onMount: mount } : {}),
      }, content))),
  h('view', { style: { ...horizontal, padding: 10, paddingLeft: 22, gap: 12, flexShrink: 0,
    borderTopWidth: 1, borderColor: theme.colors.border } },
    h('view', { id: 'settings-system-version', role: 'status', style: { flexGrow: 1, flexBasis: 0, minWidth: 0 } },
      desktopText(buildLabel(build), theme.colors.muted, 12, { flexShrink: 1 })),
    desktopText(title === 'Settings' ? 'Personal preferences' : 'Desktop controls', theme.colors.muted, 12)));
}

export function unavailableSettingsView(theme, title, explanation) {
  return settingsCard(theme, title, explanation, [
    desktopText('Unavailable in this session', theme.colors.muted, 14),
  ]);
}

export function aboutSettingsView(theme, { services, outputs, themeId, build = runtimeBuild() }) {
  const label = text => desktopText(text, theme.colors.text, 14);
  return h('view', { id: 'shell-settings-about', style: { flexShrink: 0, padding: 8, gap: 16 } },
    settingsCard(theme, 'PollyDesktop', 'An independent desktop built with PollyWM and native PollyUI.', [
      label('System release: ' + build.version),
      desktopText('Build: ' + build.revision, theme.colors.muted, 13, { flexShrink: 1 }),
      label('Source: ' + (build.sourceDirty === null ? 'unknown' : build.sourceDirty ? 'modified working tree' : 'clean')),
    ]),
    settingsCard(theme, 'This session', outputs + ' active displays', [
      label('Appearance: ' + themeId),
      label('Input method: ' + services.inputMethod + ' | Audio: ' + services.audio),
      services.message ? h('view', { role: 'status' }, label(services.message)) : null,
      services.error ? h('view', { role: 'alert' }, label(services.error)) : null,
    ]),
    settingsCard(theme, 'Your preferences', 'Changes apply to your current user account.', [
      desktopText('Memory-only Live sessions retain preferences only until reboot.', theme.colors.muted, 13),
      desktopText('Account and sign-in management are not available in Settings. Login and locking depend on the deployed session policy.',
        theme.colors.muted, 13, { flexShrink: 1 }),
    ]));
}
