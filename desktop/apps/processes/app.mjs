import { h, render } from './gui/sdk/js/reconciler.mjs';
import { fixedRowWindow } from './gui/sdk/js/virtual-list.mjs';
import { createVerticalScrollbar } from './gui/sdk/js/scrollbar.mjs';
import { scrollbarAppearance } from './desktop/shared/ui/scrollbar-appearance.mjs';
import { getDesktopTheme, DEFAULT_DESKTOP_THEME } from './desktop/shell/themes.mjs';
import { themedText, desktopCommand, desktopIcon, horizontal } from './desktop/shell/presentation.mjs';
import { subscribeDesktopTheme } from './desktop/client/theme.mjs';
import { formatSize } from './desktop/apps/files/ui/format.mjs';
import { createProcessController } from './desktop/apps/processes/logic/controller.mjs';
import { sortedProcesses, PROCESS_STATES } from './desktop/apps/processes/logic/model.mjs';

export function createProcessesApp({ provider, host = window, native = typeof desktop === 'undefined' ? null : desktop,
  report = console.error } = {}) {
  let surface = null, timer = null, subscription = null, stopped = false;
  let viewport = null, viewportHeight = 0, frame = null, stopState = null, painted = null;
  let scrollbar = null, scrollTrack = null;
  let sorted = { source: null, key: '', direction: 0, rows: [] };
  let theme = getDesktopTheme(DEFAULT_DESKTOP_THEME), themeError = '';
  const controller = createProcessController({ provider, changed: paint, report });
  const guard = action => () => { if (!stopped && !surface?.closed) return action(); };
  function measureViewport() {
    if (stopped || !viewport || frame !== null) return;
    // Native rAF precedes layout; the second callback sees the updated viewport.
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        if (stopped || !viewport || surface.closed) { frame = null; return; }
        if (viewportHeight !== viewport.offsetHeight) {
          viewportHeight = viewport.offsetHeight;
          paint();
        } else scrollbar?.update();
        frame = null;
      });
    });
  }
  const trackViewport = node => { viewport = node; measureViewport(); };
  function keydown(event) {
    if (!event.defaultPrevented && event.key === 'F5') { event.preventDefault(); controller.refresh(); }
  }
  function scrolled() {
    if (stopped || !viewport || surface.closed) return;
    viewportHeight = viewport.offsetHeight;
    const next = fixedRowWindow(controller.getState().rows.length, 42, viewportHeight, Number(viewport.scrollTop));
    if (!painted || next.start !== painted.start || next.end !== painted.end) paint();
  }
  function scroll(event) {
    event.preventDefault();
    if (stopped || !viewport || surface.closed) return;
    viewportHeight = event.currentTarget.offsetHeight;
    const next = fixedRowWindow(controller.getState().rows.length, 42, viewportHeight,
      Number(event.currentTarget.scrollTop) + event.deltaY);
    event.currentTarget.scrollTop = next.offset;
    scrollbar.update();
  }
  function paint() {
    if (stopped || !surface || surface.closed) return;
    const state = controller.getState();
    if (sorted.source !== state.rows || sorted.key !== state.sort.key || sorted.direction !== state.sort.direction)
      sorted = { source: state.rows, key: state.sort.key, direction: state.sort.direction, rows: sortedProcesses(state) };
    const rows = sorted.rows;
    const range = fixedRowWindow(rows.length, 42, viewportHeight, Number(viewport?.scrollTop || 0));
    painted = range;
    const text = (value, muted = false) => themedText(theme, value, theme.colors[muted ? 'muted' : 'text'],
      theme.layout[muted ? 'statusFontSize' : 'fontSize'],
      { flexShrink: 1, minWidth: 0, overflow: 'hidden' });
    const cell = (content, index) => h('view', { style: { width: ['34%', '12%', '20%', '17%', '17%'][index],
      minWidth: 0, padding: 10, overflow: 'hidden', flexShrink: 0 } }, content);
    render(h('view', { id: 'processes-root', style: { height: '100%', minHeight: 0, backgroundColor: theme.colors.body } },
      h('view', { style: { ...horizontal, padding: theme.layout.contentPadding,
        gap: theme.layout.controlGap, flexShrink: 0 } },
        desktopIcon('apps', theme.colors.accent, 28),
        themedText(theme, 'Processes', theme.colors.text, theme.layout.headingFontSize),
        h('view', { style: { flexGrow: 1 } }),
        desktopCommand('processes-refresh', state.loading ? 'Refreshing...' : 'Refresh', theme,
          guard(controller.refresh), { enabled: !state.loading, icon: 'refresh' })),
      h('view', { style: { paddingLeft: theme.layout.contentPadding, paddingRight: theme.layout.contentPadding,
        paddingBottom: theme.layout.contentGap, flexShrink: 0 } },
        text('Read-only monitor. No process termination or administrator actions are available.', true),
        text('CPU is the sampled share of total machine CPU time; the first sample is unavailable. Memory is resident (RSS).', true)),
      h('view', { id: 'processes-error', role: 'alert',
        style: { display: state.error || themeError ? 'flex' : 'none',
          padding: theme.layout.contentPadding, flexShrink: 0 } },
        state.error || themeError ? text(state.error || themeError) : null,
        (state.error || themeError) && state.updated !== null ?
          text('Last successful sample retained; these rows are stale.', true) : null),
      h('view', { role: 'row', style: { ...horizontal, flexShrink: 0, backgroundColor: theme.colors.surface } },
        [['name', 'Name'], ['pid', 'PID'], ['state', 'State'], ['memoryBytes', 'Memory'], ['cpuPercent', 'CPU']]
          .map(([key, title], index) => cell(desktopCommand('processes-sort-' + key,
            title + (state.sort.key === key ? state.sort.direction === 1 ? ' ^' : ' v' : ''), theme,
            guard(() => controller.sortBy(key)), { quiet: true, style: { padding: 0, height: 24 } }), index))),
      h('view', { id: 'processes-list-region', style: { position: 'relative', flexGrow: 1,
        flexBasis: 0, minHeight: 0, minWidth: 0 } },
      h('view', { id: 'processes-list', role: 'table', 'aria-label': 'Current processes',
        'aria-rowcount': String(rows.length),
        style: { flexGrow: 1, flexBasis: 0, minHeight: 0, overflow: 'scroll', backgroundColor: theme.colors.surface },
        onWheel: scroll, onMount: trackViewport, onUpdate: trackViewport },
        h('view', { 'aria-hidden': 'true', style: { height: range.start * 42, flexShrink: 0 } }),
        rows.slice(range.start, range.end).map((item, index) => h('view', {
          id: 'processes-pid-' + item.pid, role: 'row', 'aria-rowindex': String(range.start + index + 1),
          style: { ...horizontal, flexShrink: 0, height: 42, borderBottomWidth: 1, borderColor: theme.colors.border } },
          [item.name, String(item.pid), PROCESS_STATES[item.state],
            item.memoryBytes === null ? 'Unavailable' : formatSize(item.memoryBytes),
            item.cpuPercent === null ? 'Unavailable' : item.cpuPercent.toFixed(1) + '%']
            .map((value, index) => cell(text(value), index)))),
        h('view', { 'aria-hidden': 'true', style: { height: (rows.length - range.end) * 42, flexShrink: 0 } }),
        !rows.length ? h('view', { style: { padding: theme.layout.contentPadding } },
          text(state.loading ? 'Reading processes...' : state.error ? 'Process list unavailable' : 'No visible processes')) : null),
      h('view', { id: 'processes-scrollbar', role: 'scrollbar', 'aria-label': 'Scroll processes',
        'aria-controls': 'processes-list', 'aria-orientation': 'vertical', tabIndex: -1,
        style: { position: 'absolute', right: 0, top: 0, bottom: 0, width: 10,
          opacity: 0, pointerEvents: 'none' } },
      h('view', { id: 'processes-scroll-thumb', style: { position: 'absolute', left: 2, top: 0,
        width: 4, height: 28, pointerEvents: 'none' } }))),
      h('view', { id: 'processes-status', role: 'status', style: {
        padding: theme.layout.contentPadding, gap: theme.layout.controlGap, flexShrink: 0 } },
        text(rows.length + ' processes' + (state.updated === null ? '' : ' | Sample: ' + new Date(state.updated).toLocaleTimeString()), true),
        !state.complete ? text('Partial list: the 4096-process snapshot limit was reached.', true) : null,
        state.skipped ? text(state.skipped + ' processes exited, changed identity or were denied by OS permissions during this sample.', true) : null)),
    surface.document.body);
    if (Number(viewport.scrollTop) !== range.offset) viewport.scrollTop = range.offset;
    const track = surface.document.getElementById('processes-scrollbar');
    const appearance = scrollbarAppearance(theme, 'overlay');
    if (track !== scrollTrack) {
      scrollbar?.stop(); scrollTrack = track;
      scrollbar = createVerticalScrollbar({ viewport, track,
        thumb: surface.document.getElementById('processes-scroll-thumb'), appearance,
        isCurrent: () => !stopped && !surface.closed, onScroll: scrolled });
    } else scrollbar.setAppearance(appearance);
    scrollbar.update();
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer !== null) clearInterval(timer);
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    stopState?.(); stopState = null;
    scrollbar?.stop(); scrollbar = null; scrollTrack = null;
    viewport = null;
    controller.close(); subscription?.stop();
    surface?.document.body.removeEventListener('keydown', keydown);
    if (surface && !surface.closed) surface.close();
  }
  return Object.freeze({
    controller, stop, getWindow: () => surface,
    start() {
      if (stopped) throw new Error('Closed Processes cannot restart');
      if (surface) return this;
      surface = host.create({ title: 'Processes', width: 900, height: 640 });
      surface.onclose = stop; host.close(); paint();
      if (typeof surface.observeState === 'function') {
        const geometry = state => [state.width, state.height, state.scale].join(':');
        let previous = geometry(surface.state);
        stopState = surface.observeState(state => {
          const next = geometry(state);
          if (next !== previous) { previous = next; measureViewport(); }
        });
      }
      surface.document.body.addEventListener('keydown', keydown);
      if (typeof native?.startThemeSubscription === 'function') {
        try {
          subscription = subscribeDesktopTheme(snapshot => {
            theme = snapshot.ready ? snapshot.theme : getDesktopTheme(DEFAULT_DESKTOP_THEME); paint();
          }, { native, onError: error => { themeError = String(error); report(themeError); paint(); } });
        } catch (error) { themeError = String(error); report(themeError); paint(); }
      }
      controller.refresh(); timer = setInterval(controller.refresh, 2000);
      return this;
    },
  });
}
