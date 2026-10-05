import { h, render } from './js/reconciler.mjs';

function button(id, label, theme, action) {
  return h('view', { id, role: 'button', 'aria-label': label, tabIndex: 0,
    style: { padding: 6, borderWidth: 1, borderColor: theme.colors.border, borderRadius: theme.button.radius,
      backgroundColor: theme.colors.surface, color: theme.colors.text, fontSize: 12 },
    onClick: event => { event.stopPropagation(); action(); },
    onKeydown: event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); action(); }
    },
  }, label);
}
export function createNotificationSurfaces({ host, native, theme, report, changed }) {
  let started = false, notices = [], toast = null, center = null, previous;
  const close = surface => { if (surface && !surface.closed) surface.close(); };
  function action(notice, key) {
    try {
      if (key === null) native.dismissNotification(notice.id, notice.revision);
      else native.invokeNotificationAction(notice.id, notice.revision, key);
      refresh();
    } catch (error) { report('[shell] Notification action failed: ' + String(error)); refresh(); }
  }
  function card(notice) {
    const current = theme();
    return h('view', { id: 'shell-notification-' + notice.id, role: 'status',
      style: { padding: 10, gap: 5, flexShrink: 0, borderWidth: 1,
        borderColor: notice.urgency === 2 ? current.colors.accent : current.colors.border,
        borderRadius: current.window.radius, backgroundColor: current.colors.body } },
    h('view', { style: { flexDirection: 'row', alignItems: 'center', gap: 8 } },
      h('view', { style: { flexGrow: 1, fontSize: 11, color: current.colors.muted, maxHeight: 28, overflow: 'hidden' } },
        notice.application || 'Application'),
      button('shell-notification-close-' + notice.id, 'Dismiss', current, () => action(notice, null))),
    h('view', { style: { fontSize: 14, color: current.colors.text, maxHeight: 52, overflow: 'hidden' } }, notice.summary),
    notice.body ? h('view', { style: { fontSize: 12, color: current.colors.text, maxHeight: 90, overflow: 'scroll' } }, notice.body) : null,
    notice.actions.length ? h('view', { style: { flexDirection: 'row', gap: 6, overflow: 'scroll', flexShrink: 0 } },
      ...notice.actions.map((item, index) => button('shell-notification-action-' + notice.id + '-' + index,
        item.label, current, () => action(notice, item.key)))) : null);
  }
  function geometry(kind, output) {
    const count = Math.min(notices.length, 3);
    const contentHeight = notices.slice(0, count).reduce((height, item) =>
      height + 28 + 52 + 20 + (item.body ? 90 : 0) + (item.actions.length ? 34 : 0) + 8, 0) +
      (notices.length > 3 ? 36 : 0);
    return {
      width: Math.max(1, Math.min(380, output.width - 24)),
      height: Math.max(1, Math.min(kind === 'center' ? 600 : contentHeight, output.height - 64)),
    };
  }
  function surface(kind, keyboard, output) {
    const size = geometry(kind, output);
    const result = host.create({ title: 'PollyShell.notifications-' + kind + '.' + output.id,
      output: output.id, layer: 'overlay', keyboard, anchors: ['top', 'right'],
      ...size,
      margins: { top: 36, right: 12 }, exclusiveZone: -1, transparent: true });
    result.onclose = () => { if (toast?.window === result) toast = null; if (center?.window === result) center = null; };
    return { window: result, output: output.id, geometry: JSON.stringify(size) };
  }
  function paint() {
    if (!started) return;
    const output = host.displays()[0];
    if (!output || !notices.length) { close(toast?.window); close(center?.window); toast = center = null; return; }
    if (toast && (toast.output !== output.id || toast.geometry !== JSON.stringify(geometry('toast', output)))) {
      close(toast.window); toast = null;
    }
    if (center && (center.output !== output.id || center.geometry !== JSON.stringify(geometry('center', output)))) {
      close(center.window); center = null;
    }
    if (!center && !toast) toast = surface('toast', 'none', output);
    if (center) { close(toast?.window); toast = null; }
    const current = theme(), target = center || toast;
    Object.assign(target.window.document.body.style, { gap: 8, backgroundColor: '#00000000' });
    render(h('view', { id: center ? 'shell-notification-center' : 'shell-notification-toasts',
      style: { flex: 1, gap: 8, overflow: 'scroll' } },
      center ? button('shell-notification-center-close', 'Close notifications', current, () => {
        close(center.window); center = null; paint();
      }) : null,
      ...(center ? notices : notices.slice(0, 3)).map(card),
      !center && notices.length > 3 ? button('shell-notification-more', 'All notifications (' + notices.length + ')',
        current, show) : null), target.window.document.body);
  }
  function refresh() {
    if (!started) return;
    try { notices = native.notifications(); paint(); changed(); }
    catch (error) {
      report('[shell] Notifications unavailable: ' + String(error));
      notices = []; close(toast?.window); close(center?.window); toast = center = null; changed();
    }
  }
  function show() {
    if (!started || !notices.length) return;
    const output = host.displays()[0];
    if (!output) return;
    if (!center) center = surface('center', 'on-demand', output);
    paint();
  }
  const onChanged = () => { refresh(); if (typeof previous === 'function') previous(); };
  return {
    start() {
      if (!native?.notificationsAvailable) return;
      try {
        native.startNotifications();
        started = true;
        previous = native.onNotificationsChanged;
        native.onNotificationsChanged = onChanged;
        refresh();
      } catch (error) { report('[shell] Cannot start notifications: ' + String(error)); }
    },
    stop() {
      close(toast?.window); close(center?.window); toast = center = null; notices = [];
      if (!started) return;
      started = false;
      if (native.onNotificationsChanged === onChanged) native.onNotificationsChanged = previous;
      try { native.stopNotifications(); } catch (error) { report('[shell] Cannot stop notifications: ' + String(error)); }
    },
    paint, show, count: () => notices.length,
  };
}
