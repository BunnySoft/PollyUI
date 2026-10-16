import { h } from './gui/sdk/js/reconciler.mjs';
import { verticalScrollMetrics } from './gui/sdk/js/scrollbar.mjs';
import { desktopCommand, desktopIcon, desktopText, scrollDesktop } from './desktop/shared/ui/presentation.mjs';
import { surfaceStyle, bevel } from './desktop/shared/ui/surface-primitives.mjs';
import { themeTextSize } from './desktop/shared/ui/theme-layout.mjs';
import { programsMenu, programsPlacement } from './desktop/shell/programs-menu.mjs';
import { guardTaskGesture } from './desktop/shell/window-group-menu.mjs';

const row = { flexDirection: 'row', alignItems: 'center' };
const text = (theme, value, color = theme.colors.text, extra = {}) =>
  desktopText(value, color, themeTextSize(theme), extra);

function revealGridItem(item) {
  let innerScroll = 0;
  for (let strip = item.parentNode; strip; strip = strip.parentNode) {
    if (strip.id === 'shell-start-apps' || strip.id === 'shell-applications') {
      const top = item.offsetTop - strip.offsetTop - innerScroll, start = Number(strip.scrollTop);
      const end = top + item.offsetHeight, height = strip.offsetHeight;
      const next = item.offsetHeight > height ? top : top < start ? top :
        end > start + height ? end - height : start;
      if (next !== start) strip.scrollTop = Math.max(0, Math.min(verticalScrollMetrics(strip).maximum, next));
    }
    if (strip.id === 'shell-applications') break;
    // Native offsets are unscrolled; the outer target must subtract newly applied inner scrolling.
    innerScroll += Number(strip.scrollTop ?? 0);
  }
}

const gridLayouts = new WeakMap();
function syncGridScroll(node) {
  let state = gridLayouts.get(node);
  if (!state) { state = { frame: null, geometry: null }; gridLayouts.set(node, state); }
  if (state.frame !== null) return;
  // Reconciliation and Yoga settle before measuring; retained updates coalesce without polling.
  state.frame = requestAnimationFrame(() => {
    state.frame = requestAnimationFrame(() => {
      state.frame = null;
      if (!node.ownerDocument || node.style.overflow !== 'scroll') return;
      const list = node.querySelector('#shell-start-apps');
      if (!list) return;
      const geometry = [];
      for (const viewport of [list, node]) {
        const metrics = verticalScrollMetrics(viewport);
        geometry.push(viewport.offsetWidth, metrics.height, metrics.maximum);
        if (Number(viewport.scrollTop) !== metrics.value) viewport.scrollTop = metrics.value;
      }
      const changed = !state.geometry || geometry.some((value, index) => value !== state.geometry[index]);
      state.geometry = geometry;
      if (!changed) return;
      const focused = node.ownerDocument.activeElement;
      for (let parent = focused; parent; parent = parent.parentNode) {
        if (parent === node) { revealGridItem(focused); break; }
      }
    });
  });
}
function stopGridScroll(node, done) {
  const state = gridLayouts.get(node);
  if (state && state.frame !== null) cancelAnimationFrame(state.frame);
  gridLayouts.delete(node);
  done();
}

export function startMenuView(theme, entries, query, changeQuery, launch, refresh, close,
  error = '', logout = null, desktop = null, programs = null, images = null, searchInput = null, launchers = null) {
  const kind = surfaceStyle(theme, 'panel'), xp = kind === 'luna', modern = kind === 'fluent';
  const l = theme.layout, c = theme.colors, classic = kind === 'classic';
  const menuStyle = theme.panel.menuStyle ?? (modern ? 'grid' : xp ? 'two-column' : 'legacy');
  const grid = menuStyle === 'grid', twoColumn = menuStyle === 'two-column';
  const scrollGrid = modern && grid;
  const gridAppHeight = 80, gridPinHeight = 20, cardGap = 2, gridPadding = 8;
  const classicColumns = classic && twoColumn;
  const rowHeight = l.menuRowHeight ?? 32;
  const appHeight = twoColumn ? Math.max(rowHeight, (l.menuIconSize ?? 0) + 8) : rowHeight;
  const linkHeight = twoColumn ? Math.max(rowHeight, classicColumns ? 28 : l.menuIconSize ?? 0) : rowHeight;
  const filtered = entries.filter(entry =>
    [entry.name, entry.genericName || '', entry.comment || '', ...(entry.keywords || [])]
      .join(' ').toLowerCase().includes(query.toLowerCase()));
  const revealGrid = node => {
    if (!scrollGrid) return node;
    const focus = node.props.onFocus;
    node.props.onFocus = event => {
      focus?.(event);
      revealGridItem(event.currentTarget);
    };
    return node;
  };
  const command = (id, title, action, icon = '', extra = {}) => {
    const node = desktopCommand(id, title, theme, action, { icon, iconSize: classicColumns ? 24 : 0, quiet: true, style: {
      borderRadius: modern ? 4 : 0, height: linkHeight, borderWidth: 0,
      paddingLeft: grid ? 12 : 6, paddingRight: 6, ...extra } });
    if (xp && twoColumn) {
      const focus = node.props.onFocus;
      node.props.onFocus = event => {
        focus?.(event);
        const item = event.currentTarget, strip = item.parentNode;
        if (strip?.id !== 'shell-start-links') return;
        const top = item.offsetTop - strip.offsetTop, end = top + item.offsetHeight;
        const start = Number(strip.scrollTop);
        const next = top < start ? top : end > start + strip.offsetHeight ? end - strip.offsetHeight : start;
        if (next !== start) strip.scrollTop = Math.max(0, Math.min(verticalScrollMetrics(strip).maximum, next));
      };
    }
    return revealGrid(node);
  };
  const search = searchInput ? searchInput({
    style: { height: grid ? 32 : 24, flexShrink: 0, minWidth: 0,
      ...(grid ? { marginTop: 24, marginLeft: 24, marginRight: 24 } : {}) },
    placeholder: 'Search applications',
    submit: () => { const first = filtered.find(entry => !entry.unavailable); if (first) launch(first.id); },
    focused: scrollGrid ? event => revealGridItem(event.currentTarget) : null,
  }) : h('view', { id: 'shell-app-search', role: 'textbox', tabIndex: 0,
    'aria-label': 'Search applications', style: { ...row, flexShrink: 0, minWidth: 0,
      height: grid ? 32 : 24, paddingLeft: 8, paddingRight: 8, gap: 8,
      ...(grid ? { marginTop: 24, marginLeft: 24, marginRight: 24 } : {}),
      backgroundColor: c.surface, borderWidth: 1, borderColor: modern ? c.border : c.dark,
      borderBottomWidth: modern ? 2 : 1, borderRadius: modern ? 16 : 0, position: 'relative' },
    focusStyle: { borderColor: c.accent },
    onTextinput: event => changeQuery(Array.from(query + event.data).slice(0, 128).join('')),
    onKeydown: event => {
      if (event.key === 'Backspace') {
        event.preventDefault(); changeQuery(Array.from(query).slice(0, -1).join(''));
      } else if (event.key === 'Enter' && !event.isComposing && filtered.find(entry => !entry.unavailable)) {
        event.preventDefault(); launch(filtered.find(entry => !entry.unavailable).id);
      }
    },
  }, classic ? bevel(theme, { inset: true }) : null,
  grid ? desktopIcon('search', c.muted, 16) : null,
  text(theme, query || 'Search applications', query ? c.text : c.muted,
    { pointerEvents: 'none', flexShrink: 1, minWidth: 0 }));
  revealGrid(search);
  const app = entry => {
    const icon = entry.id === 'org.pollyui.settings' ? 'appearance' : entry.id.includes('files') ? 'folder' : 'apps';
    const item = desktopCommand('shell-app-' + entry.id, entry.name, theme, () => launch(entry.id), {
      icon, iconSize: grid || twoColumn ? l.menuIconSize ?? 0 : 0,
      enabled: !entry.unavailable, quiet: true, style: {
        height: grid ? gridAppHeight : appHeight, borderRadius: modern ? 4 : 0,
        borderWidth: 0, paddingLeft: grid ? 4 : 6, paddingRight: grid ? 4 : 6,
        ...(grid ? { width: 88, flexDirection: 'column', justifyContent: 'center', gap: 6 } :
          { flexGrow: 1, flexBasis: 0, minWidth: 0 }),
      },
    });
    let art = item.children.find(child => child.props?.className === 'theme-command-icon');
    if (grid && item.children.length) {
      const label = item.children.at(-1);
      label.props.style.fontSize = l.smallFontSize;
      if (art?.props.style.width === 20) {
        const index = item.children.indexOf(art);
        art = desktopIcon(icon, c.accent, 32);
        item.children[index] = art;
      }
    }
    const image = images?.get(entry.id);
    if (image && art) item.children[item.children.indexOf(art)] = h('view', {
      'aria-hidden': 'true', style: { ...art.props.style, backgroundImage: image },
    });
    if (entry.unavailable) item.props['aria-description'] = entry.unavailable;
    revealGrid(item);
    const pinId = launchers?.id(entry.id);
    const pinned = launchers?.has(pinId);
    const launcher = launchers ? command('shell-app-launcher-' + entry.id,
      (launchers.target === 'Dock' ? 'Dock' : 'Taskbar') + (pinned ? '-' : '+'),
      () => launchers.change(pinId, pinned), '', {
        height: grid ? gridPinHeight : l.menuRowHeight ?? 32, width: 80,
        paddingLeft: 3, paddingRight: 3 }) : null;
    if (launcher) {
      launcher.props['aria-label'] = (pinned ? 'Unpin ' : 'Pin ') + entry.name +
        (pinned ? ' from ' : ' to ') + launchers.target;
      guardTaskGesture(launcher, pinId + ':' + pinned);
    }
    const desktopPin = desktop ? command('shell-app-pin-' + entry.id, desktop.has(entry.id) ? 'Unpin' : 'Pin',
      () => desktop.has(entry.id) ? desktop.remove(entry.id) : desktop.add(entry.id), '',
      { height: grid ? gridPinHeight : l.menuRowHeight ?? 32, width: grid ? 64 : 38,
        paddingLeft: 3, paddingRight: 3 }) : null;
    if (desktopPin) desktopPin.props['aria-label'] = (desktop.has(entry.id) ? 'Unpin ' : 'Pin ') +
      entry.name + (desktop.has(entry.id) ? ' from desktop' : ' to desktop');
    return h('view', { key: entry.id, style: { ...row, flexShrink: 0, gap: cardGap,
      ...(grid ? { flexDirection: 'column', width: 88 } : launchers ? { flexWrap: 'wrap' } : {}) } }, item,
      desktopPin, launcher);
  };
  const list = h('view', { id: 'shell-start-apps', style: {
    flexGrow: 1, flexBasis: 0, minHeight: 0, minWidth: 0, overflow: 'scroll',
    gap: grid ? 8 : 0, padding: grid ? gridPadding : classicColumns ? 0 : 2,
    ...(grid ? { ...row, alignItems: 'flex-start', alignContent: 'flex-start', flexWrap: 'wrap' } : {}),
  }, onWheel: scrollGrid ? event => {
    const before = Number(event.currentTarget.scrollTop);
    scrollDesktop(event);
    if (Number(event.currentTarget.scrollTop) !== before) event.stopPropagation();
  } : scrollDesktop }, filtered.slice(0, 100).map(app),
  !filtered.length ? text(theme, 'No matching applications', c.muted) : null);
  const tools = [
    command('shell-app-refresh', 'Refresh', refresh, 'refresh'),
    command('shell-app-close', 'Close menu', close),
  ];
  const settings = entries.find(entry => entry.id === 'org.pollyui.settings' && !entry.unavailable);
  const files = entries.find(entry => entry.id === 'org.pollyui.files' && !entry.unavailable);
  const programTrigger = classic && programs ? command('shell-all-programs', 'All Programs >',
    () => programs.change(true, 'first'), 'apps') : null;
  if (programTrigger) {
    programTrigger.props['aria-haspopup'] = 'menu';
    programTrigger.props['aria-expanded'] = String(programs.open);
    const enter = programTrigger.props.onMouseenter, key = programTrigger.props.onKeydown;
    programTrigger.props.onMouseenter = event => {
      enter?.(event);
      const trigger = event.currentTarget;
      let root = trigger.parentNode;
      while (root && root.id !== 'shell-applications') root = root.parentNode;
      if (!root || programs.open) return;
      const placement = programsPlacement(root, trigger, rowHeight);
      if (placement.left >= trigger.offsetLeft + trigger.offsetWidth - root.offsetLeft - 1 ||
          placement.top >= trigger.offsetTop + trigger.offsetHeight - root.offsetTop) programs.change(true, 'first');
    };
    programTrigger.props.onKeydown = event => {
      if (event.key === 'ArrowRight') {
        event.preventDefault(); event.stopPropagation(); programs.change(true, 'first');
      } else key?.(event);
    };
  }
  return h('view', { id: 'shell-applications', style: { width: '100%', height: '100%',
    backgroundColor: c.body, borderWidth: classic ? 0 : xp ? 2 : 1, borderColor: xp ? '#1854c2' : c.border,
    borderRadius: modern ? 8 : xp ? 6 : theme.window.radius, overflow: scrollGrid ? 'scroll' : 'hidden', position: 'relative',
    padding: classic ? 3 : 0, gap: grid ? 20 : 0 },
    ...(scrollGrid ? { onWheel: scrollDesktop, onMount: syncGridScroll, onUpdate: syncGridScroll,
      onLeave: stopGridScroll } : {}),
    ...(classic && programs?.open ? {
      onKeydown: event => {
        if (event.key === 'Escape' || event.key === 'ArrowLeft') {
          event.preventDefault(); event.stopPropagation();
          if (programs.back && programs.view !== 'all') programs.back();
          else programs.change(false, 'trigger');
        }
      },
      onMousecancel: () => programs.change(false, 'trigger'),
      onMouseleave: event => {
        const box = event.currentTarget.getBoundingClientRect();
        if (event.clientX < box.x || event.clientX >= box.x + box.width ||
            event.clientY < box.y || event.clientY >= box.y + box.height) programs.change(false);
      },
    } : {}) },
  classic ? bevel(theme, { frame: true }) : null,
  twoColumn && (l.menuHeaderHeight ?? 64) > 0 ? h('view', { id: 'shell-start-profile', style: { ...row, height: l.menuHeaderHeight ?? 64,
    flexShrink: 0, paddingLeft: 8, gap: 10, backgroundColor: xp ? '#1c62d1' : theme.window.titleFrom,
    gradientFrom: xp ? '#1c62d1' : theme.window.titleFrom,
    gradientTo: xp ? '#4a93e5' : theme.window.titleTo,
    gradientDir: classic ? 'horizontal' : 'vertical',
    borderBottomWidth: xp ? 1 : 0, borderColor: '#efb843', overflow: 'hidden' } },
    xp ? h('view', { style: { width: 48, height: 48, borderRadius: 4, borderWidth: 2,
      borderColor: '#ffffff', backgroundColor: '#e5f2ff', justifyContent: 'center', alignItems: 'center' } },
      desktopIcon('apps', c.accent, 32)) : null,
    desktopText('PollyDesktop', theme.window.titleText, classic ? 20 : 18,
      { fontWeight: 700, fontStyle: classic ? 'italic' : 'normal' })) : null,
  grid ? search : null,
  grid ? h('view', { style: { ...row, paddingLeft: 36, paddingRight: 36, gap: 12 } },
    text(theme, 'Applications', c.text, { fontWeight: 600 }),
    h('view', { style: { flexGrow: 1 } }),
    ...tools.map(tool => { tool.props.style.height = 28; return tool; })) : null,
  h('view', { style: { ...row, alignItems: 'stretch', flexGrow: 1, flexBasis: 0,
    minHeight: scrollGrid ? gridPadding * 2 + gridAppHeight + (desktop ? cardGap + gridPinHeight : 0) +
      (launchers ? cardGap + gridPinHeight : 0) : 0,
    ...(grid ? { paddingLeft: 24, paddingRight: 24 } : {}) } },
    classic && menuStyle === 'legacy' ? h('view', { id: 'shell-start-brand', 'aria-hidden': 'true', style: { width: 24,
      flexShrink: 0, backgroundColor: '#0a246a', gradientFrom: '#0a246a', gradientTo: '#a6caf0' } }) : null,
    h('view', { style: { flexGrow: 1, flexBasis: 0, minWidth: 0, backgroundColor: xp ? c.surface : c.body,
      padding: grid || classicColumns ? 0 : 4, gap: 4 } },
      programTrigger, list,
      grid ? null : search,
      filtered.length > 100 ? text(theme, 'Showing 100 matches; refine the search.', c.muted) : null),
    twoColumn ? h('view', { id: 'shell-start-links', style: { width: l.menuSideWidth ?? 132, flexShrink: 0,
      padding: classic ? 4 : 6, gap: classic ? 0 : 6, backgroundColor: xp ? '#d3e5fa' : c.body,
      borderLeftWidth: classicColumns ? 0 : 1, borderColor: xp ? '#95b8e9' : c.dark, position: 'relative',
      ...(xp ? { minHeight: 0, overflow: 'scroll' } : {}) },
    ...(xp ? { onWheel: scrollDesktop } : {}) },
      classicColumns ? h('view', { 'aria-hidden': 'true', style: { position: 'absolute',
        left: 0, top: 0, bottom: 0, width: 1, backgroundColor: c.dark, pointerEvents: 'none' } }) : null,
      classicColumns ? h('view', { 'aria-hidden': 'true', style: { position: 'absolute',
        left: 1, top: 0, bottom: 0, width: 1, backgroundColor: c.light, pointerEvents: 'none' } }) : null,
      classicColumns && files ? command('shell-start-files', files.name, () => launch(files.id), 'folder') : null,
      settings ? command('shell-start-settings', 'Settings', () => launch(settings.id), 'appearance') : null,
      ...tools) : null),
  h('view', { id: 'shell-start-footer', style: { ...row, flexShrink: 0,
    height: l.menuFooterHeight ?? 36, gap: 6, paddingLeft: grid ? 36 : 6, paddingRight: grid ? 36 : 6,
    backgroundColor: xp ? '#4487de' : modern ? '#eaeaea' : c.body,
    borderTopWidth: classic ? 0 : 1, borderColor: xp ? '#75b3f6' : c.border,
    ...(classic ? { position: 'relative', paddingTop: 2 } : {}) } },
    classic ? h('view', { 'aria-hidden': 'true', style: { position: 'absolute', top: 0, left: 0, right: 0,
      height: 1, backgroundColor: c.dark, pointerEvents: 'none' } }) : null,
    classic ? h('view', { 'aria-hidden': 'true', style: { position: 'absolute', top: 1, left: 0, right: 0,
      height: 1, backgroundColor: c.light, pointerEvents: 'none' } }) : null,
    grid ? text(theme, 'PollyDesktop') : null,
    menuStyle === 'legacy' ? tools : null,
    h('view', { style: { flexGrow: 1 } }),
    logout ? command('shell-app-logout', 'Log out...', logout, '', { height: 28 }) : null),
  classic && programs ? h('view', { role: 'alert', style: {
    display: error ? 'flex' : 'none', padding: error ? 6 : 0, backgroundColor: c.selection,
  } }, error ? text(theme, error, c.accentText) : null) :
    error ? h('view', { role: 'alert', style: { padding: 6, backgroundColor: c.selection } },
      text(theme, error, classic ? c.accentText : c.text)) : null,
  classic && programs?.open ? programsMenu(theme, entries, desktop, { ...programs, error }) : null);
}
