import { h } from './gui/sdk/js/reconciler.mjs';
import { desktopCommand, desktopIcon, desktopText, scrollDesktop } from './desktop/shared/ui/presentation.mjs';
import { surfaceStyle, bevel } from './desktop/shared/ui/surface-primitives.mjs';
import { themeTextSize } from './desktop/shared/ui/theme-layout.mjs';

const row = { flexDirection: 'row', alignItems: 'center' };
const text = (theme, value, color = theme.colors.text, extra = {}) =>
  desktopText(value, color, themeTextSize(theme), extra);

export function startMenuView(theme, entries, query, changeQuery, launch, refresh, close,
  error = '', logout = null, desktop = null) {
  const kind = surfaceStyle(theme, 'panel'), xp = kind === 'luna', fluent = kind === 'fluent';
  const l = theme.layout, c = theme.colors, classic = kind === 'classic';
  const filtered = entries.filter(entry =>
    [entry.name, entry.genericName || '', entry.comment || '', ...(entry.keywords || [])]
      .join(' ').toLowerCase().includes(query.toLowerCase()));
  const command = (id, title, action, icon = '', extra = {}) =>
    desktopCommand(id, title, theme, action, { icon, quiet: true, style: {
      borderRadius: fluent ? 4 : 0, height: l.menuRowHeight ?? 32, borderWidth: 0,
      paddingLeft: fluent ? 12 : 6, paddingRight: 6, ...extra } });
  const search = h('view', { id: 'shell-app-search', role: 'textbox', tabIndex: 0,
    'aria-label': 'Search applications', style: { ...row, flexShrink: 0, minWidth: 0,
      height: fluent ? 32 : 24, paddingLeft: 8, paddingRight: 8, gap: 8,
      ...(fluent ? { marginTop: 24, marginLeft: 24, marginRight: 24 } : {}),
      backgroundColor: c.surface, borderWidth: 1, borderColor: fluent ? c.border : c.dark,
      borderBottomWidth: fluent ? 2 : 1, borderRadius: fluent ? 16 : 0, position: 'relative' },
    focusStyle: { borderColor: c.accent },
    onTextinput: event => changeQuery(Array.from(query + event.data).slice(0, 128).join('')),
    onKeydown: event => {
      if (event.key === 'Backspace') {
        event.preventDefault(); changeQuery(Array.from(query).slice(0, -1).join(''));
      } else if (event.key === 'Enter' && filtered.find(entry => !entry.unavailable)) {
        event.preventDefault(); launch(filtered.find(entry => !entry.unavailable).id);
      }
    },
  }, classic ? bevel(theme, { inset: true }) : null,
  fluent ? desktopIcon('search', c.muted, 16) : null,
  text(theme, query || 'Search applications', query ? c.text : c.muted,
    { pointerEvents: 'none', flexShrink: 1, minWidth: 0 }));
  const app = entry => {
    const icon = entry.id === 'org.pollyui.settings' ? 'appearance' : entry.id.includes('files') ? 'folder' : 'apps';
    const item = desktopCommand('shell-app-' + entry.id, entry.name, theme, () => launch(entry.id), {
      icon, enabled: !entry.unavailable, quiet: true, style: {
        height: fluent ? 80 : l.menuRowHeight ?? 32, borderRadius: fluent ? 4 : 0,
        borderWidth: 0, paddingLeft: fluent ? 4 : 6, paddingRight: fluent ? 4 : 6,
        ...(fluent ? { width: 88, flexDirection: 'column', justifyContent: 'center', gap: 6 } :
          { flexGrow: 1, flexBasis: 0, minWidth: 0 }),
      },
    });
    if (fluent && item.children.length) {
      const label = item.children.at(-1);
      label.props.style.fontSize = 12;
      const art = item.children.find(child => child.props?.['aria-hidden'] === 'true' && child.props?.style?.width === 20);
      if (art) item.children[item.children.indexOf(art)] = desktopIcon(icon, c.accent, 32);
    }
    if (entry.unavailable) item.props['aria-description'] = entry.unavailable;
    return h('view', { key: entry.id, style: { ...row, flexShrink: 0, gap: 2,
      ...(fluent ? { flexDirection: 'column', width: 88 } : {}) } }, item,
    desktop ? command('shell-app-pin-' + entry.id, desktop.has(entry.id) ? 'Unpin' : 'Pin',
      () => desktop.has(entry.id) ? desktop.remove(entry.id) : desktop.add(entry.id), '',
      { height: fluent ? 20 : l.menuRowHeight ?? 32, width: fluent ? 64 : 38,
        paddingLeft: 3, paddingRight: 3 }) : null);
  };
  const list = h('view', { id: 'shell-start-apps', style: {
    flexGrow: 1, flexBasis: 0, minHeight: 0, minWidth: 0, overflow: 'scroll',
    gap: fluent ? 8 : 0, padding: fluent ? 8 : 2,
    ...(fluent ? { ...row, alignItems: 'flex-start', alignContent: 'flex-start', flexWrap: 'wrap' } : {}),
  }, onWheel: scrollDesktop }, filtered.slice(0, 100).map(app),
  !filtered.length ? text(theme, 'No matching applications', c.muted) : null);
  const tools = [
    command('shell-app-refresh', 'Refresh', refresh, 'refresh'),
    command('shell-app-close', 'Close menu', close),
  ];
  const settings = entries.find(entry => entry.id === 'org.pollyui.settings' && !entry.unavailable);
  return h('view', { id: 'shell-applications', style: { width: '100%', height: '100%',
    backgroundColor: c.body, borderWidth: xp ? 2 : 1, borderColor: xp ? '#1854c2' : c.border,
    borderRadius: fluent ? 8 : xp ? 6 : 0, overflow: 'hidden', position: 'relative',
    padding: classic ? 3 : 0, gap: fluent ? 20 : 0 } },
  classic ? bevel(theme) : null,
  xp ? h('view', { id: 'shell-start-profile', style: { ...row, height: l.menuHeaderHeight ?? 64,
    flexShrink: 0, paddingLeft: 8, gap: 10, backgroundColor: '#1c62d1',
    gradientFrom: '#1c62d1', gradientTo: '#4a93e5', borderBottomWidth: 1, borderColor: '#efb843' } },
    h('view', { style: { width: 48, height: 48, borderRadius: 4, borderWidth: 2,
      borderColor: '#ffffff', backgroundColor: '#e5f2ff', justifyContent: 'center', alignItems: 'center' } },
      desktopIcon('apps', c.accent, 32)),
    desktopText('PollyDesktop', '#ffffff', 18, { fontWeight: 700 })) : null,
  fluent ? search : null,
  fluent ? h('view', { style: { ...row, paddingLeft: 36, paddingRight: 36, gap: 12 } },
    text(theme, 'Applications', c.text, { fontWeight: 600 }),
    h('view', { style: { flexGrow: 1 } }),
    ...tools.map(tool => { tool.props.style.height = 28; return tool; })) : null,
  h('view', { style: { ...row, alignItems: 'stretch', flexGrow: 1, flexBasis: 0, minHeight: 0,
    ...(fluent ? { paddingLeft: 24, paddingRight: 24 } : {}) } },
    classic ? h('view', { id: 'shell-start-brand', 'aria-hidden': 'true', style: { width: 24,
      flexShrink: 0, backgroundColor: '#0a246a', gradientFrom: '#0a246a', gradientTo: '#a6caf0' } }) : null,
    h('view', { style: { flexGrow: 1, flexBasis: 0, minWidth: 0, backgroundColor: xp ? c.surface : c.body,
      padding: fluent ? 0 : 4, gap: 4 } },
      list,
      fluent ? null : search,
      filtered.length > 100 ? text(theme, 'Showing 100 matches; refine the search.', c.muted) : null),
    xp ? h('view', { id: 'shell-start-links', style: { width: 132, flexShrink: 0,
      padding: 6, gap: 6, backgroundColor: '#d3e5fa', borderLeftWidth: 1, borderColor: '#95b8e9' } },
      settings ? command('shell-start-settings', 'Settings', () => launch(settings.id), 'appearance') : null,
      ...tools) : null),
  h('view', { id: 'shell-start-footer', style: { ...row, flexShrink: 0,
    height: l.menuFooterHeight ?? 36, gap: 6, paddingLeft: fluent ? 36 : 6, paddingRight: fluent ? 36 : 6,
    backgroundColor: xp ? '#4487de' : fluent ? '#eaeaea' : c.body,
    borderTopWidth: 1, borderColor: xp ? '#75b3f6' : c.border } },
    fluent ? text(theme, 'PollyDesktop') : null,
    classic ? tools : null,
    h('view', { style: { flexGrow: 1 } }),
    logout ? command('shell-app-logout', 'Log out...', logout, '', { height: 28 }) : null),
  error ? h('view', { role: 'alert', style: { padding: 6, backgroundColor: c.selection } },
    text(theme, error, classic ? c.accentText : c.text)) : null);
}
