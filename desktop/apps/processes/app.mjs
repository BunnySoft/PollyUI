import { h, render } from './gui/sdk/js/reconciler.mjs';
import { getDesktopTheme, DEFAULT_DESKTOP_THEME } from './desktop/shell/themes.mjs';
import { desktopText, desktopCommand, desktopIcon, horizontal, scrollDesktop } from './desktop/shell/presentation.mjs';
import { subscribeDesktopTheme } from './desktop/client/theme.mjs';
import { formatSize } from './desktop/apps/files/ui/format.mjs';
import { createProcessController } from './desktop/apps/processes/logic/controller.mjs';
import { sortedProcesses, PROCESS_STATES } from './desktop/apps/processes/logic/model.mjs';

export function createProcessesApp({ provider, host = window, native = typeof desktop === 'undefined' ? null : desktop,
  report = console.error } = {}) {
  let surface = null, timer = null, subscription = null, stopped = false;
  let theme = getDesktopTheme(DEFAULT_DESKTOP_THEME), themeError = '';
  const controller = createProcessController({ provider, changed: paint, report });
  const guard = action => () => { if (!stopped && !surface?.closed) return action(); };
  function paint() {
    if (stopped || !surface || surface.closed) return;
    const state = controller.getState(), rows = sortedProcesses(state);
    const text = (value, muted = false) => desktopText(value, theme.colors[muted ? 'muted' : 'text'], 14,
      { flexShrink: 1, minWidth: 0, overflow: 'hidden' });
    const cell = (content, index) => h('view', { style: { width: ['34%', '12%', '20%', '17%', '17%'][index],
      minWidth: 0, padding: 10, overflow: 'hidden', flexShrink: 0 } }, content);
    render(h('view', { id: 'processes-root', style: { height: '100%', minHeight: 0, backgroundColor: theme.colors.body } },
      h('view', { style: { ...horizontal, padding: 18, gap: 12, flexShrink: 0 } },
        desktopIcon('apps', theme.colors.accent, 28), desktopText('Processes', theme.colors.text, 24),
        h('view', { style: { flexGrow: 1 } }),
        desktopCommand('processes-refresh', state.loading ? 'Refreshing...' : 'Refresh', theme,
          guard(controller.refresh), { enabled: !state.loading, icon: 'refresh' })),
      h('view', { style: { paddingLeft: 18, paddingRight: 18, paddingBottom: 12, flexShrink: 0 } },
        text('Read-only monitor. No process termination or administrator actions are available.', true),
        text('CPU is the sampled share of total machine CPU time; the first sample is unavailable. Memory is resident (RSS).', true)),
      state.error || themeError ? h('view', { id: 'processes-error', role: 'alert',
        style: { padding: 12, flexShrink: 0 } }, text(state.error || themeError),
        state.updated !== null ? text('Last successful sample retained; these rows are stale.', true) : null) : null,
      h('view', { role: 'row', style: { ...horizontal, flexShrink: 0, backgroundColor: theme.colors.surface } },
        [['name', 'Name'], ['pid', 'PID'], ['state', 'State'], ['memoryBytes', 'Memory'], ['cpuPercent', 'CPU']]
          .map(([key, title], index) => cell(desktopCommand('processes-sort-' + key,
            title + (state.sort.key === key ? state.sort.direction === 1 ? ' ^' : ' v' : ''), theme,
            guard(() => controller.sortBy(key)), { quiet: true, style: { padding: 0, height: 24 } }), index))),
      h('view', { id: 'processes-list', role: 'table', 'aria-label': 'Current processes',
        style: { flexGrow: 1, flexBasis: 0, minHeight: 0, overflow: 'scroll', backgroundColor: theme.colors.surface },
        onWheel: scrollDesktop },
        rows.map(item => h('view', { id: 'processes-pid-' + item.pid, role: 'row',
          style: { ...horizontal, flexShrink: 0, height: 42, borderBottomWidth: 1, borderColor: theme.colors.border } },
          [item.name, String(item.pid), PROCESS_STATES[item.state],
            item.memoryBytes === null ? 'Unavailable' : formatSize(item.memoryBytes),
            item.cpuPercent === null ? 'Unavailable' : item.cpuPercent.toFixed(1) + '%']
            .map((value, index) => cell(text(value), index)))),
        !rows.length ? h('view', { style: { padding: 24 } },
          text(state.loading ? 'Reading processes...' : state.error ? 'Process list unavailable' : 'No visible processes')) : null),
      h('view', { id: 'processes-status', role: 'status', style: { padding: 12, gap: 6, flexShrink: 0 } },
        text(rows.length + ' processes' + (state.updated === null ? '' : ' | Sample: ' + new Date(state.updated).toLocaleTimeString()), true),
        !state.complete ? text('Partial list: the 4096-process snapshot limit was reached.', true) : null,
        state.skipped ? text(state.skipped + ' processes exited, changed identity or were denied by OS permissions during this sample.', true) : null)),
    surface.document.body);
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer !== null) clearInterval(timer);
    controller.close(); subscription?.stop();
    if (surface && !surface.closed) surface.close();
  }
  return Object.freeze({
    controller, stop, getWindow: () => surface,
    start() {
      if (stopped) throw new Error('Closed Processes cannot restart');
      if (surface) return this;
      surface = host.create({ title: 'Processes', width: 900, height: 640 });
      surface.onclose = stop; host.close(); paint();
      surface.document.body.addEventListener('keydown', event => {
        if (!event.defaultPrevented && event.key === 'F5') { event.preventDefault(); controller.refresh(); }
      });
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
