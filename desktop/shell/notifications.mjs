import { h, render } from './gui/sdk/js/reconciler.mjs';

function button(id, label, theme, action) {
  return h('view', { id, role: 'button', 'aria-label': label, tabIndex: 0,
    style: { padding: theme.layout.notificationButtonPadding, borderWidth: theme.layout.borderWidth,
      borderColor: theme.colors.border, borderRadius: theme.button.radius,
      backgroundColor: theme.colors.surface, color: theme.colors.text, fontSize: theme.layout.fontSize },
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
      style: { padding: current.layout.noticeCardPadding, gap: current.layout.noticeCardGap,
        flexShrink: 0, borderWidth: current.layout.borderWidth,
        borderColor: notice.urgency === 2 ? current.colors.accent : current.colors.border,
        borderRadius: current.window.radius, backgroundColor: current.colors.body } },
    h('view', { style: { flexDirection: 'row', alignItems: 'center', gap: current.layout.contentGap } },
      h('view', { style: { flexGrow: 1, fontSize: current.layout.mutedFontSize,
        color: current.colors.muted, maxHeight: current.layout.noticeHeaderHeight, overflow: 'hidden' } },
        notice.application || 'Application'),
      button('shell-notification-close-' + notice.id, 'Dismiss', current, () => action(notice, null))),
    h('view', { style: { fontSize: current.layout.sectionFontSize, color: current.colors.text,
      maxHeight: current.layout.noticeTitleHeight, overflow: 'hidden' } }, notice.summary),
    notice.body ? h('view', { style: { fontSize: current.layout.fontSize, color: current.colors.text,
      maxHeight: current.layout.noticeBodyHeight, overflow: 'scroll' } }, notice.body) : null,
    notice.actions.length ? h('view', { style: { flexDirection: 'row', gap: current.layout.controlGap, overflow: 'scroll', flexShrink: 0 } },
      ...notice.actions.map((item, index) => button('shell-notification-action-' + notice.id + '-' + index,
        item.label, current, () => action(notice, item.key)))) : null);
  }
  function geometry(kind, output) {
    const layout = theme().layout;
    const count = Math.min(notices.length, layout.notificationVisibleCount);
    const contentHeight = notices.slice(0, count).reduce((height, item) =>
      height + layout.noticeHeaderHeight + layout.noticeTitleHeight + 2 * layout.noticeCardPadding +
      (item.body ? layout.noticeBodyHeight : 0) + (item.actions.length ? layout.noticeActionHeight : 0) + layout.noticeStackGap, 0) +
      (notices.length > layout.notificationVisibleCount ? layout.noticeFooterHeight : 0);
    return {
      width: Math.max(1, Math.min(layout.notificationWidth, output.width - layout.overlayInset * 2)),
      height: Math.max(1, Math.min(kind === 'center' ? layout.notificationCenterHeight : contentHeight,
        output.height - layout.notificationVerticalInset * 2)),
    };
  }
  function surface(kind, keyboard, output) {
    const size = geometry(kind, output);
    const result = host.create({ title: 'PollyShell.notifications-' + kind + '.' + output.id,
      output: output.id, layer: 'overlay', keyboard, anchors: ['top', 'right'],
      ...size,
      margins: { top: theme().layout.notificationTopMargin, right: theme().layout.overlayRightMargin },
      exclusiveZone: -1, transparent: true });
    result.onclose = () => { if (toast?.window === result) toast = null; if (center?.window === result) center = null; };
    return { window: result, output: output.id, geometry: JSON.stringify(size) };
  }
  function paint() {
    if (!started) return;
    const output = host.displays()[0];
    if (!output || !notices.length) { close(toast?.window); close(center?.window); toast = center = null; return; }
    const wasCenter = !!center;
    if (toast && (toast.output !== output.id || toast.geometry !== JSON.stringify(geometry('toast', output)))) {
      close(toast.window); toast = null;
    }
    if (center && (center.output !== output.id || center.geometry !== JSON.stringify(geometry('center', output)))) {
      close(center.window); center = null;
    }
    if (!center && !toast) {
      if (wasCenter) center = surface('center', 'on-demand', output);
      else toast = surface('toast', 'none', output);
    }
    if (center) { close(toast?.window); toast = null; }
    const current = theme(), target = center || toast;
    Object.assign(target.window.document.body.style, { gap: current.layout.noticeStackGap, backgroundColor: '#00000000' });
    render(h('view', { id: center ? 'shell-notification-center' : 'shell-notification-toasts',
      style: { flex: 1, gap: current.layout.noticeStackGap, overflow: 'scroll' } },
      center ? button('shell-notification-center-close', 'Close notifications', current, () => {
        close(center.window); center = null; paint();
      }) : null,
      ...(center ? notices : notices.slice(0, current.layout.notificationVisibleCount)).map(card),
      !center && notices.length > current.layout.notificationVisibleCount ? button('shell-notification-more', 'All notifications (' + notices.length + ')',
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
