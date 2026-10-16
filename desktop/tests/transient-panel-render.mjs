import { h, render } from './gui/sdk/js/reconciler.mjs';
import { getDesktopTheme } from './desktop/shared/ui/themes.mjs';
import { panelAppearance } from './desktop/shared/ui/panel-appearance.mjs';
import { createNetworkSettings } from './desktop/apps/settings/ui/network.mjs';
import { displayConfirmationView } from './desktop/shell/views.mjs';
import { createSessionExitController, createLogoutSurface } from './desktop/shell/session-exit.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
const settle = async () => { for (let i = 0; i < 4; i++) { await Promise.resolve(); host.render(); } };
const rect = node => {
  const r = node.getBoundingClientRect();
  return [r.x, r.y, r.width, r.height];
};
const edges = node => {
  const [x, y, width, height] = rect(node), cx = Math.floor(x + width / 2), cy = Math.floor(y + height / 2);
  return [host.pixel(cx, y), host.pixel(cx, y + height - 1), host.pixel(x, cy), host.pixel(x + width - 1, cy)];
};
function stage(width, height) {
  render(h('view', { id: 'transient-stage', style: { width, height, overflow: 'hidden', position: 'relative' } }), document.body);
  host.render();
  return document.getElementById('transient-stage');
}
const key = async (name, extra = {}) => { host.key(name, 'keydown', { text: false, ...extra }); await settle(); };
const click = async (node, button = 0) => {
  const [x, y, width, height] = rect(node);
  for (const type of ['mousedown', 'mouseup', 'click']) {
    host.mouse(type, x + width / 2, y + height / 2, { button }); await settle();
  }
};
async function reveal(node, viewport) {
  const box = node.getBoundingClientRect(), clip = viewport.getBoundingClientRect();
  if (box.bottom > clip.bottom) viewport.scrollTop += box.bottom - clip.bottom + 4;
  else if (box.top < clip.top) viewport.scrollTop = Math.max(0, viewport.scrollTop + box.top - clip.top - 4);
  await settle();
}
function inBounds(node, viewport) {
  const a = node.getBoundingClientRect(), b = viewport.getBoundingClientRect();
  return a.width > 0 && a.height > 0 && a.x >= b.x && a.right <= b.right && a.y >= b.y && a.bottom <= b.bottom;
}

export async function checkTransientPanels(directory, verify = true) {
  check(host.width === 800 && host.height === 600, 'Bounded scale-1 actual GUI viewport');
  let theme = getDesktopTheme('server2003');
  const summaries = [], reports = [];
  const report = message => { reports.push(message); };
  const clone = value => JSON.parse(JSON.stringify(value));
  const nativeState = { ready: true, revision: 1, operation: '', refreshing: false, registered: true,
    networkConfiguration: true, error: '',
    devices: [{ id: 'device', name: 'Fixture adapter', powered: true, station: true, state: 'disconnected' }],
    networks: [{ id: 'network', device: 'device', name: 'A deliberately long ordinary fixture network name for wrapping',
      order: 0, type: 'psk', known: false, connected: false, signal: -40 }],
    authentication: { id: 7, network: 'network', kind: 'username-password', username: 'fixture-user' } };
  const actions = [], replies = [];
  const native = { startNetwork() {}, stopNetwork() {}, refreshNetworks() {}, networkState: () => clone(nativeState),
    networkAction(revision, id, action) {
      check(revision === nativeState.revision && id === 'network', 'Existing network snapshot identity reaches the controlled service');
      actions.push(action);
    },
    replyNetworkAuthentication(id, username, password) {
      check(id === nativeState.authentication.id, 'Authentication dispatch uses the live prompt ID');
      replies.push({ id, cancelled: username === null && password === null,
        usernamePresent: username !== null && username.length > 0, passwordPresent: password !== null && password.length > 0 });
      nativeState.authentication = null;
    },
    cancelNetworkConnection() { nativeState.operation = ''; nativeState.authentication = null; } };
  const root = stage(420, 280), surface = { document, closed: false };
  const network = createNetworkSettings({ native, host: {}, theme: () => theme, report });
  try {
    network.attach(surface, root); await settle();
    const password = document.getElementById('shell-network-password'), username = document.getElementById('shell-network-username');
    const form = document.getElementById('shell-network-settings');
    const first = { viewport: rect(root), form: rect(form), password: rect(password), username: rect(username),
      passwordFits: password.getBoundingClientRect().right <= root.getBoundingClientRect().right };
    if (verify) {
      const card = document.getElementById('shell-network-content');
      root.style.height = '560'; await settle();
      first.cardEdges = edges(card);
      check(card && Number(card.style.borderWidth) === 0 && first.cardEdges.join(':') === '#808080:#FFFFFF:#808080:#FFFFFF',
        'Embedded credential card uses passive inset bevel without wrapping the decorated app in a fake frame');
      check(!form.style.borderWidth && !form.querySelector('.bevel-face-top'),
        'Embedded content does not acquire a second dialog/window frame');
      root.style.height = '280'; await settle();
      check(first.passwordFits && password.offsetWidth <= 420, 'Actual constrained credential input fits the narrow card');
    }
    await reveal(password, form);
    password.focus(); host.text('fixture-only-secret'); await settle();
    host.key('Home', 'keydown', { text: false }); host.key('ArrowRight', 'keydown', { shiftKey: true, text: false }); await settle();
    const caret = password.childNodes[2].style.left;
    const selection = password.firstChild.childNodes.map(node => [node.style.left, node.style.width]);
    const maskedLength = password.childNodes[1].firstChild.textContent.length;
    check(selection.length > 0 && !password.textContent.includes('fixture'), 'Actual secure field paints masked selected text only');
    theme = getDesktopTheme('xp'); network.refresh(); await settle();
    check(document.getElementById(password.id) === password && document.getElementById(username.id) === username &&
      document.activeElement === password && password.childNodes[2].style.left !== undefined &&
      password.firstChild.childNodes.length === selection.length &&
      password.childNodes[1].firstChild.textContent.length === maskedLength,
      'Retheme preserves the actual native fields, selection and owner focus');
    nativeState.operation = 'connect'; nativeState.refreshing = true; native.onNetworkChanged(); await settle();
    if (verify) check(document.getElementById(password.id) === password && document.activeElement === password,
      'Adding live operation/status UI cannot reparent or discard retained credential fields');
    const retiredSubmit = document.getElementById('shell-network-auth-submit').__listeners.click;
    nativeState.authentication = { id: 8, network: 'network', kind: 'private-key' }; native.onNetworkChanged(); await settle();
    const nextPassword = document.getElementById('shell-network-password');
    check(nextPassword !== password && !document.getElementById('shell-network-username') &&
      !password.firstChild.childNodes.length && password.childNodes[1].textContent === '',
      'New prompt ID/kind still clears and replaces credentials through the existing contentMode reset');
    retiredSubmit({ currentTarget: nextPassword, button: 0, stopPropagation() {} });
    check(replies.length === 0, 'Retired authentication callbacks cannot deliver replacement-prompt credentials');
    nextPassword.focus(); host.text('fixture-only-passphrase'); await settle();
    const viewport = document.getElementById('shell-network-settings');
    const cancel = document.getElementById('shell-network-auth-cancel');
    if (verify) {
      const [x, y, w, height] = rect(viewport);
      host.scroll(x + w / 2, y + height / 2, 10000); await settle();
      check(viewport.scrollTop > 0, 'Real wheel reaches existing scrollDesktop on a short credential surface');
      await reveal(cancel, viewport);
      check(inBounds(cancel, root), 'Credential cancellation remains reachable in the short surface');
    }
    cancel.focus(); await key(' ');
    check(replies.length === 1 && replies[0].id === 8 && replies[0].cancelled &&
      nextPassword.childNodes[1].textContent === '', 'One controlled cancellation clears masked secrets without submitting them');
    nativeState.operation = ''; nativeState.refreshing = false; native.onNetworkChanged(); await settle();
    const connect = document.getElementById('shell-network-connect-0-0');
    await reveal(connect, document.getElementById('shell-network-settings')); connect.focus(); await key('Enter');
    const confirm = document.getElementById('shell-network-confirm'), oldConfirm = confirm.__listeners.click;
    nativeState.revision++; native.onNetworkChanged(); await settle();
    check(document.getElementById('shell-network-confirm').getAttribute('aria-disabled') === 'true',
      'Changing revisions still disables the pending network confirmation');
    oldConfirm({ currentTarget: confirm, button: 0, stopPropagation() {} });
    check(actions.length === 0, 'Stale confirmation cannot mutate a newer network snapshot');
    document.getElementById('shell-network-confirm-cancel').focus(); await key('Enter');
    theme = getDesktopTheme('server2003'); network.refresh(); await settle();
    if (verify) {
      const card = document.getElementById('shell-network-entry-0-0');
      root.style.height = '560'; await settle();
      document.getElementById('shell-network-settings').scrollTop = 0; await settle();
      const detail = card.lastChild;
      first.entryDecoration = ['top', 'bottom', 'left', 'right'].map(side => {
        const edge = detail.querySelector('.bevel-' + side), r = edge.getBoundingClientRect();
        return { side, box: rect(edge), pixel: host.pixel(Math.floor(r.x + r.width / 2), Math.floor(r.y + r.height / 2)) };
      });
      check(card.style.borderWidth === '0' && first.entryDecoration.map(edge => edge.pixel).join(':') === '#808080:#FFFFFF:#808080:#FFFFFF',
        'Existing network entry uses actual passive inset-decoration pixels without a generic overlay');
      first.entryCard = rect(card);
      first.entryBottomRoundingDelta = first.entryDecoration[1].box[1] - (card.offsetTop + card.offsetHeight - 1);
      root.style.height = '280'; await settle();
      nativeState.authentication = { id: 9, network: 'network', kind: 'passphrase' };
      native.onNetworkChanged(); await settle();
      const finalPassword = document.getElementById('shell-network-password');
      await reveal(finalPassword, document.getElementById('shell-network-settings')); finalPassword.focus();
      host.text('fixture-secret-not-logged'); await settle();
      const submit = document.getElementById('shell-network-auth-submit');
      await reveal(submit, document.getElementById('shell-network-settings')); submit.focus(); await key('Enter');
      check(replies.length === 2 && replies[1].id === 9 && !replies[1].cancelled && replies[1].passwordPresent &&
        !document.getElementById('shell-network-password') && finalPassword.childNodes[1].textContent === '',
        'One controlled authentication action keeps the prompt contract and clears credentials after the inert service reply');
    }
    check(host.save(directory + '/network-final.png'), 'Save bounded actual network panel');
    summaries.push({ consumer: 'network', first, sameFieldsOnRetheme: true, operationPreservedFields: true,
      prompts: verify ? [7, 8, 9] : [7, 8], cancelledReplies: replies.filter(reply => reply.cancelled).length,
      controlledAuthenticationReplies: replies.filter(reply => !reply.cancelled).length,
      staleActions: actions.length, secureContentPrinted: false,
      retainedCaretBeforeRetheme: caret, selectedRanges: selection.length });
  } finally { network.stop(); render(null, document.body); }

  const displayRoot = stage(260, 130);
  let keeps = 0, reverts = 0;
  render(displayConfirmationView(theme, 14500, () => keeps++, () => reverts++), displayRoot); await settle();
  const confirmation = document.getElementById('shell-output-confirmation');
  const display = { box: rect(confirmation), border: Number(confirmation.style.borderWidth), edges: edges(confirmation),
    textDeadline: confirmation.textContent.includes('15 seconds') };
  if (verify) {
    check(display.border === panelAppearance(theme, 'dialog').borderWidth &&
      display.edges.join(':') === '#D4D0C8:#404040:#D4D0C8:#404040', 'Trusted display confirmation consumes the shared dialog frame');
    const keep = document.getElementById('shell-output-keep'), revert = document.getElementById('shell-output-revert');
    const [x, y, width, height] = rect(confirmation);
    host.scroll(x + width / 2, y + height / 2, 10000); await settle();
    await reveal(revert, confirmation); check(inBounds(revert, displayRoot), 'Revert is wheel/keyboard reachable in a short confirmation');
    keep.focus(); await key('Enter'); revert.focus(); await key(' ');
    check(keeps === 1 && reverts === 1 && display.textDeadline, 'Original Keep/Revert callbacks remain single actions and preserve the countdown text');
  }
  summaries.push({ consumer: 'display-confirmation', ...display, keeps, reverts });
  render(null, document.body);

  let inventory = { version: 1, phase: 'idle', profile: 'installed', pendingWindows: 1, pendingApplications: 1,
    pendingActivations: 0, windows: [{ title: 'Unsaved ordinary document with a long title that must wrap in a narrow surface', appId: 'fixture' }],
    applications: ['fixture-application-with-a-long-display-name'], error: '' };
  const sessionCalls = [], controller = createSessionExitController({ native: {
    sessionExitState: () => clone(inventory),
    beginSessionExit() { sessionCalls.push('request-close'); inventory.phase = 'waiting'; return clone(inventory); },
    cancelSessionExit() { sessionCalls.push('cancel'); inventory.phase = 'idle'; return clone(inventory); },
    sealSessionExit() { sessionCalls.push('seal'); inventory.phase = 'committed'; return clone(inventory); },
  }, report });
  let commit = 0, active = null;
  const logout = createLogoutSurface({ controller, theme: () => theme, commit: () => { commit++; },
    host: { displays: () => [{ id: 1, width: 300, height: 260 }],
      create() {
        const container = stage(300, 260);
        const doc = Object.create(document);
        Object.defineProperty(doc, 'body', { value: container });
        Object.defineProperty(doc, 'activeElement', { get: () => document.activeElement });
        active = { closed: false, document: doc, close() { if (!this.closed) { this.closed = true; this.onclose?.(); } } };
        return active;
      } } });
  try {
    logout.show(1); await settle();
    const panel = document.getElementById('shell-logout');
    const first = { box: rect(panel), border: Number(panel.style.borderWidth), edges: edges(panel) };
    let confirm = document.getElementById('shell-logout-confirm'); confirm.focus();
    if (verify) {
      theme = getDesktopTheme('modern'); logout.paint(); await settle();
      check(document.getElementById('shell-logout-confirm') === confirm && document.activeElement === confirm &&
        Number(panel.style.borderRadius) === theme.window.radius &&
        Number(panel.style.padding) === theme.layout.contentPadding,
        'Ordinary Modern dialog retheme keeps the live confirmation target/focus while consuming the shared metrics');
      theme = getDesktopTheme('server2003'); logout.paint(); await settle();
      const oldConfirm = confirm.__listeners.click, retired = active;
      check(retired.oncloserequest() === false && retired.closed && controller.snapshot().phase === 'idle',
        'Closing logout confirmation still cancels instead of ending the session');
      logout.show(1); await settle();
      oldConfirm({ currentTarget: confirm, button: 0, stopPropagation() {} });
      check(!active.closed && controller.snapshot().phase === 'confirm' && sessionCalls.length === 0,
        'A retired logout button cannot dispatch into the replacement surface');
      document.getElementById('shell-logout-confirm').focus();
      await key('Escape');
      check(controller.snapshot().phase === 'idle' && active.closed, 'Existing Escape remains a cancellation');
      logout.show(1); await settle();
      confirm = document.getElementById('shell-logout-confirm'); confirm.focus();
    }
    await key('Enter', { repeat: true });
    const repeatCloseRequests = sessionCalls.filter(call => call === 'request-close').length;
    if (verify) {
      check(repeatCloseRequests === 0, 'Shared logout activation ignores repeated Enter');
      check(first.border === 0 && first.edges.join(':') === '#D4D0C8:#404040:#D4D0C8:#404040',
        'Undecorated logout layer uses exactly one shared dialog frame');
      await key('Enter');
      check(controller.snapshot().phase === 'waiting' && sessionCalls.filter(call => call === 'request-close').length === 1 &&
        commit === 0 && !document.getElementById('shell-logout-commit'), 'Closing applications never bypasses the explicit final commit');
      const waiting = document.getElementById('shell-logout'), cancel = document.getElementById('shell-logout-cancel');
      const [x, y, width, height] = rect(waiting);
      host.scroll(x + width / 2, y + height / 2, 10000); await settle(); await reveal(cancel, waiting);
      check(inBounds(cancel, active.document.body), 'Long unsaved-window inventory keeps cancellation wheel/keyboard reachable');
      inventory.pendingApplications = 0; inventory.pendingWindows = 0; inventory.windows = []; inventory.applications = [];
      inventory.phase = 'ready'; controller.refresh(); await settle();
      const finish = document.getElementById('shell-logout-commit'); finish.focus();
      inventory.pendingWindows = 1; await key('Enter');
      check(commit === 0 && !sessionCalls.includes('seal'), 'A late window still prevents the actual final action');
      inventory.pendingWindows = 0; inventory.phase = 'ready'; controller.refresh(); await settle();
      const viewport = document.getElementById('shell-logout');
      const final = document.getElementById('shell-logout-commit'); await reveal(final, viewport);
      check(inBounds(final, active.document.body), 'Explicit final action remains reachable in the short logout surface');
      final.focus(); await key(' ');
      check(commit === 1 && sessionCalls.filter(call => call === 'seal').length === 1 &&
        controller.snapshot().phase === 'complete', 'Only the explicit final action seals the controlled inventory and calls the inert fixture commit once');
    }
    summaries.push({ consumer: 'logout', ...first, repeatCloseRequests, sessionCalls, fixtureCommits: commit,
      realLogout: false });
    check(host.save(directory + '/logout-final.png'), 'Save bounded logout view');
  } finally { logout.stop(); controller.stop(); render(null, document.body); }
  check(reports.length === 0, 'All fixture dependencies reported any real error explicitly');
  console.log('TRANSIENT_PANEL_ADOPTION ' + JSON.stringify({ verify, summaries,
    scope: 'Actual GUI consumers with controlled network/display/session dependencies; no credentials transmitted, network connected or session ended' }));
}
