import { h, render } from './gui/sdk/js/reconciler.mjs';
import { displayConfirmationView } from './desktop/shell/views.mjs';
import { getDesktopTheme } from './desktop/shared/ui/themes.mjs';
import { createNetworkSettings } from './desktop/apps/settings/ui/network.mjs';
import { createSessionExitController, createLogoutSurface } from './desktop/shell/session-exit.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
const settle = async () => { for (let i = 0; i < 4; i++) { await Promise.resolve(); host.render(); } };
const box = node => { const r = node.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
const edgePixels = root => {
  const r = root.getBoundingClientRect();
  return [host.pixel(Math.floor(r.x + r.width / 2), r.y), host.pixel(Math.floor(r.x + r.width / 2), r.bottom - 1),
    host.pixel(r.x, Math.floor(r.y + r.height / 2)), host.pixel(r.right - 1, Math.floor(r.y + r.height / 2))];
};
const visible = (node, viewport) => {
  const a = node.getBoundingClientRect(), b = viewport.getBoundingClientRect();
  return a.x >= b.x && a.y >= b.y && a.right <= b.right && a.bottom <= b.bottom;
};
const stage = (width, height) => {
  render(h('view', { id: 'viewport-stage', style: { width, height, overflow: 'hidden' } }), document.body);
  host.render(); return document.getElementById('viewport-stage');
};
export async function checkFixedPanelViewports(verify = true) {
  const theme = getDesktopTheme('server2003'), results = [];
  let root = stage(260, 90);
  render(displayConfirmationView(theme, 15000, () => {}, () => {}), root); await settle();
  const confirmation = document.getElementById('shell-output-confirmation');
  let viewport = document.getElementById('shell-output-confirmation-viewport') || confirmation;
  const before = edgePixels(confirmation), r = confirmation.getBoundingClientRect();
  host.scroll(r.x + r.width / 2, r.y + r.height / 2, 10000); await settle();
  const after = edgePixels(confirmation), keep = document.getElementById('shell-output-keep');
  keep.focus(); await settle();
  host.key('Tab', 'keydown', { text: false }); await settle();
  const focused = document.activeElement;
  const display = { consumer: 'display', before, after, rootScroll: confirmation.scrollTop,
    viewportScroll: viewport.scrollTop, viewport: box(viewport), actualFocused: focused?.id,
    focusedVisible: visible(focused, viewport) };
  if (verify) check(before.join(':') === after.join(':') && confirmation.scrollTop === 0 &&
    viewport.scrollTop > 0 && display.focusedVisible, 'Real short display confirmation scrolls only content and reveals the native Tab target');
  results.push(display); render(null, document.body);

  root = stage(300, 180);
  const native = { startNetwork() {}, stopNetwork() {},
    networkState: () => ({ ready: true, revision: 1, devices: [], networks: [], operation: '', error: '',
      authentication: { id: 3, kind: 'username-password', username: 'fixture' } }),
    replyNetworkAuthentication(id, username, password) { check(id === 3 && username === null && password === null, 'Only inert cancellation is allowed'); } };
  const network = createNetworkSettings({ native, host: {}, theme: () => theme, report: message => { throw new Error(message); } });
  try {
    network.attach({ document, closed: false }, root); await settle();
    const form = document.getElementById('shell-network-settings');
    viewport = document.getElementById('shell-network-settings-viewport') || form;
    const username = document.getElementById('shell-network-username'), password = document.getElementById('shell-network-password');
    const originalParent = password.parentNode;
    username.focus(); await settle();
    const requestFrame = globalThis.requestAnimationFrame;
    let inputFrames = 0;
    globalThis.requestAnimationFrame = callback => { inputFrames++; return requestFrame(callback); };
    try { host.key('Tab', 'keydown', { text: false }); await settle(); }
    finally { globalThis.requestAnimationFrame = requestFrame; }
    const passwordVisible = document.activeElement === password && visible(password, viewport);
    document.getElementById('shell-network-auth-cancel').focus(); await settle();
    const cancelVisible = visible(document.activeElement, viewport);
    if (verify) check(passwordVisible && cancelVisible && inputFrames === 2 &&
      password.parentNode === originalParent && form.scrollTop === 0,
      'Native fields and confirmation actions reveal within the shared content viewport without moving their wrappers');
    const result = { consumer: 'network', rootScroll: form.scrollTop, viewportScroll: viewport.scrollTop,
      passwordVisible, cancelVisible, inputFrames, viewport: box(viewport), sameInputParent: password.parentNode === originalParent };
    if (verify) {
      viewport.scrollTop = 0; await settle();
      network.refresh(); await settle();
      check(viewport.scrollTop === 0 && document.activeElement?.id === 'shell-network-auth-cancel',
        'Repainting the same content does not undo a manual scroll or change the actual focus');
      result.manualScrollPreserved = true;
      const cancelFrame = globalThis.cancelAnimationFrame;
      let cancelled = 0, scheduled = 0;
      globalThis.requestAnimationFrame = callback => { scheduled++; return requestFrame(callback); };
      globalThis.cancelAnimationFrame = frame => { cancelled++; return cancelFrame(frame); };
      try {
        password.focus(); await Promise.resolve();
        network.detach();
        const beforeIdle = scheduled; await settle();
        check(cancelled === 1 && scheduled === beforeIdle,
          'Leaving cancels the pending bounded reveal and does not continue scheduling frames');
        result.cancelledOnLeave = cancelled; result.idleFrames = scheduled - beforeIdle;
      } finally { globalThis.requestAnimationFrame = requestFrame; globalThis.cancelAnimationFrame = cancelFrame; }
    }
    results.push(result);
  } finally { network.stop(); render(null, document.body); }

  let inventory = { version: 1, phase: 'idle', pendingWindows: 1, pendingApplications: 1, pendingActivations: 0,
    windows: [{ title: 'Unsaved ordinary content', appId: 'fixture' }], applications: ['fixture'], error: '', profile: 'development' };
  const controller = createSessionExitController({ native: {
    sessionExitState: () => ({ ...inventory }),
    beginSessionExit() { throw new Error('No real close requests in this visibility fixture'); },
    cancelSessionExit() { inventory.phase = 'idle'; return { ...inventory }; },
    sealSessionExit() { throw new Error('No actual session exit'); },
  }, report: message => { throw new Error(message); } });
  const logout = createLogoutSurface({ controller, theme: () => theme, commit() { throw new Error('No actual logout'); },
    host: { displays: () => [{ id: 1, width: 300, height: 130 }],
      create() {
        const container = stage(300, 130), doc = Object.create(document);
        Object.defineProperty(doc, 'body', { value: container });
        Object.defineProperty(doc, 'activeElement', { get: () => document.activeElement });
        return { document: doc, closed: false, close() { if (!this.closed) { this.closed = true; this.onclose?.(); } } };
      } } });
  try {
    logout.show(1); await settle();
    const panel = document.getElementById('shell-logout');
    viewport = document.getElementById('shell-logout-viewport') || panel;
    const initial = edgePixels(panel), bounds = panel.getBoundingClientRect();
    host.scroll(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, 10000); await settle();
    const scrolled = edgePixels(panel), confirm = document.getElementById('shell-logout-confirm');
    confirm.focus(); await settle(); const directFocusVisible = visible(confirm, viewport);
    host.key('Tab', 'keydown', { text: false }); await settle();
    const cancelVisible = document.activeElement?.id === 'shell-logout-cancel' && visible(document.activeElement, viewport);
    if (verify) check(initial.join(':') === scrolled.join(':') && panel.scrollTop === 0 &&
      viewport.scrollTop > 0 && directFocusVisible && cancelVisible,
      'Short logout surface keeps its outer frame while revealing direct-focus and Tab targets inside content');
    results.push({ consumer: 'logout', before: initial, after: scrolled, rootScroll: panel.scrollTop,
      viewportScroll: viewport.scrollTop, directFocusVisible, cancelVisible, viewport: box(viewport) });
  } finally { logout.stop(); controller.stop(); render(null, document.body); }
  console.log('FIXED_PANEL_VIEWPORT ' + JSON.stringify({ verify, results,
    scope: 'Actual software GUI and native focus/input; no credential delivery, close requests or session effects' }));
}
