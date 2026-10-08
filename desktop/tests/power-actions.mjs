import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

register('./root-loader.mjs', import.meta.url);
const { createPowerSettings } = await import('../shell/power.mjs');
const { getDesktopTheme } = await import('../shell/themes.mjs');
const clone = value => JSON.parse(JSON.stringify(value));
const drain = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

class Node {
  constructor(owner) {
    Object.assign(this, { ownerDocument: owner, childNodes: [], style: {}, listeners: new Map(),
      attributes: new Map(), parentNode: null, id: '', tabIndex: -1 });
  }
  get firstChild() { return this.childNodes[0] || null; }
  appendChild(node) { node.parentNode?.removeChild(node); node.parentNode = this; this.childNodes.push(node); return node; }
  insertBefore(node, before) {
    node.parentNode?.removeChild(node); node.parentNode = this;
    this.childNodes.splice(before ? this.childNodes.indexOf(before) : this.childNodes.length, 0, node); return node;
  }
  removeChild(node) { this.childNodes.splice(this.childNodes.indexOf(node), 1); node.parentNode = null; return node; }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  removeAttribute(key) { this.attributes.delete(key); }
  addEventListener(type, action) { this.listeners.set(type, [...(this.listeners.get(type) || []), action]); }
  removeEventListener(type, action) { this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== action)); }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null; }
}
function nodes(root) { return [root, ...root.childNodes.flatMap(nodes)]; }
export function fixture(coordinator = true, controllerFactory = null) {
  const previousDocument = globalThis.document;
  const document = { activeElement: null, createElement: () => new Node(document),
    createTextNode: text => Object.assign(new Node(document), { textContent: text }),
    getElementById: id => nodes(document.body).find(node => node.id === id) };
  document.body = new Node(document); globalThis.document = document;
  const calls = [], reports = [], subscribers = new Set();
  let commit;
  let status = { phase: 'idle', action: '', windows: [], applications: [], error: '', profile: 'installed', canCancel: false };
  const notify = () => subscribers.forEach(action => action());
  let exit = {
    snapshot: () => clone(status),
    subscribe(action) { subscribers.add(action); return () => subscribers.delete(action); },
    request(value) { commit = value.commit; calls.push(['request', value.action]); status = { ...status, action: value.action, phase: 'confirm', canCancel: true }; notify(); },
    confirm() {
      calls.push(['close-applications']);
      status = { ...status, phase: 'waiting', windows: [{ id: 7, title: 'Unsaved editor' }],
        applications: ['editor'], canCancel: true }; notify();
    },
    retry() { calls.push(['retry-normal-close']); },
    async confirmCommit() {
      assert.equal(status.phase, 'ready');
      calls.push(['seal']);
      status = { ...status, phase: 'committing', canCancel: false }; notify();
      try {
        await commit();
        status = { ...status, phase: 'complete' };
      } catch (error) {
        status = { ...status, phase: error.sent ? 'uncertain' : 'blocked', error: error.message, canCancel: !error.sent };
      }
      notify();
    },
    cancel() {
      assert.equal(status.canCancel, true);
      calls.push(['cancel-session-close']);
      status = { ...status, phase: 'idle', windows: [], applications: [], error: '', canCancel: false }; notify();
    },
  };
  const state = { version: 1, ready: true, active: true, revision: 5, poweroff: 'yes', reboot: 'yes',
    operation: '', outcome: '', sent: false, busy: false, cancellable: false, error: '' };
  const native = {
    startPower() { calls.push(['start-power']); },
    stopPower() { calls.push(['stop-power']); },
    powerState: () => clone(state),
    requestPower(revision, action) {
      assert.equal(revision, state.revision);
      calls.push(['native-power', revision, action]);
      Object.assign(state, { operation: action, outcome: 'checking', cancellable: true });
    },
    cancelPower() {
      assert.equal(state.sent, false);
      calls.push(['cancel-native-preflight']);
      Object.assign(state, { operation: '', outcome: 'cancelled', cancellable: false });
    },
  };
  let inventory = { version: 1, phase: 'idle', pendingWindows: 0, pendingApplications: 0,
    pendingActivations: 0, windows: [], applications: [], error: '', profile: 'installed' };
  if (controllerFactory) {
    native.sessionExitState = () => clone(inventory);
    native.beginSessionExit = () => {
      calls.push(['close-applications']);
      inventory = { ...inventory, phase: 'waiting', pendingWindows: 1, pendingApplications: 1,
        windows: [{ id: 7, title: 'Unsaved editor', appId: 'editor' }], applications: ['editor'] };
      return clone(inventory);
    };
    native.sealSessionExit = () => {
      assert.equal(inventory.phase, 'ready'); calls.push(['seal']);
      inventory = { ...inventory, phase: 'committed' }; return clone(inventory);
    };
    native.cancelSessionExit = () => {
      calls.push(['cancel-session-close']);
      inventory = { ...inventory, phase: 'idle', windows: [], applications: [],
        pendingWindows: 0, pendingApplications: 0, pendingActivations: 0 };
      return clone(inventory);
    };
    exit = controllerFactory({ native, report: value => reports.push(value) });
  }
  let window;
  const host = { displays: () => [{ id: 1, width: 1280, height: 720 }], create() {
    window = { document, closed: false, close() { if (!this.closed) { this.closed = true; this.onclose?.(); } } };
    return window;
  } };
  const power = createPowerSettings({ native, host, theme: () => getDesktopTheme('xp'),
    report: value => reports.push(value), sessionExit: coordinator ? exit : null });
  power.show(1);
  const get = id => { const result = document.getElementById(id); assert.ok(result, id); return result; };
  const click = id => (get(id).listeners.get('click') || []).forEach(action => action({
    stopPropagation() {}, preventDefault() {}, button: 0,
  }));
  return { power, native, state, calls, reports, exit, get, click,
    ready() {
      if (controllerFactory) {
        inventory = { ...inventory, phase: 'ready', windows: [], applications: [], pendingWindows: 0, pendingApplications: 0 };
        exit.refresh();
      } else { status = { ...status, phase: 'ready', windows: [], applications: [], canCancel: true }; notify(); }
    },
    status: () => exit.snapshot(),
    notify() { native.onPowerChanged(); },
    async done() { power.stop(); await drain(); assert.equal(subscribers.size, 0); globalThis.document = previousDocument; },
  };
}

test('confirmation, pending Save/Cancel and final commit preserve user control and fresh native revision', async () => {
  const f = fixture();
  try {
    f.click('shell-power-reboot');
    assert.equal(f.calls.some(call => call[0] === 'native-power' || call[0] === 'close-applications'), false);
    f.click('shell-power-cancel');
    assert.equal(f.status().phase, 'idle');
    f.click('shell-power-reboot'); f.click('shell-power-confirm');
    assert.equal(f.status().phase, 'waiting');
    assert.equal(f.get('shell-power-retry-applications').getAttribute('aria-disabled'), 'false');
    assert.equal(f.calls.some(call => call[0] === 'native-power'), false);
    f.click('shell-power-cancel');
    assert.equal(f.status().phase, 'idle', 'an application Save/Cancel wait cannot shut down or kill the session');
    f.click('shell-power-reboot'); f.click('shell-power-confirm'); f.ready();
    f.state.revision = 8; f.notify();
    f.click('shell-power-commit');
    assert.deepEqual(f.calls.find(call => call[0] === 'native-power'), ['native-power', 8, 'reboot']);
    Object.assign(f.state, { operation: '', outcome: 'accepted', sent: true, cancellable: false });
    f.notify(); await drain();
    assert.equal(f.status().phase, 'complete');
    assert.equal(f.calls.filter(call => call[0] === 'native-power').length, 1);
  } finally { await f.done(); }
});

test('fresh denial sends nothing; post-send uncertainty cannot cancel or replay', async () => {
  const f = fixture();
  try {
    f.click('shell-power-poweroff'); f.click('shell-power-confirm'); f.ready();
    const callback = f.get('shell-power-commit').listeners.get('click')[0];
    f.state.active = false;
    callback({ stopPropagation() {} }); await drain();
    assert.equal(f.status().phase, 'blocked');
    assert.equal(f.calls.some(call => call[0] === 'native-power'), false);
    f.click('shell-power-cancel'); f.state.active = true; f.notify();
    f.click('shell-power-poweroff'); f.click('shell-power-confirm'); f.ready(); f.click('shell-power-commit');
    Object.assign(f.state, { operation: '', outcome: 'uncertain', sent: true, cancellable: false,
      error: 'Reply lost after sending; the system may already be shutting down.' });
    f.notify(); await drain();
    assert.equal(f.status().phase, 'uncertain');
    assert.equal(f.get('shell-power-retry').getAttribute('aria-disabled'), 'true');
    assert.equal(f.get('shell-power-settings').childNodes.some(node => node.id === 'shell-power-cancel'), false);
    f.power.show(1);
    assert.equal(f.calls.filter(call => call[0] === 'native-power').length, 1);
    f.native.powerState = () => { throw new Error('Desktop control connection unavailable'); };
    f.notify();
    assert.equal(f.status().phase, 'uncertain');
    assert.equal(f.calls.filter(call => call[0] === 'native-power').length, 1);
  } finally { await f.done(); }
});

test('pre-final cancellation releases the close barrier, and detached callbacks cannot commit later', async () => {
  const f = fixture();
  try {
    f.click('shell-power-reboot'); f.click('shell-power-confirm'); f.ready();
    const stale = f.get('shell-power-commit').listeners.get('click')[0];
    f.click('shell-power-commit');
    assert.equal(f.get('shell-power-cancel').getAttribute('aria-disabled'), 'false');
    f.click('shell-power-cancel'); await drain();
    assert.equal(f.status().phase, 'idle');
    assert.ok(f.calls.some(call => call[0] === 'cancel-native-preflight'));
    const count = f.calls.filter(call => call[0] === 'native-power').length;
    stale({ stopPropagation() {} });
    assert.equal(f.calls.filter(call => call[0] === 'native-power').length, count);
  } finally { await f.done(); }
});

test('no application-close coordinator or challenge permission stays explicitly unavailable', async () => {
  const missing = fixture(false);
  try {
    assert.equal(missing.get('shell-power-poweroff').getAttribute('aria-disabled'), 'true');
    missing.click('shell-power-poweroff');
    assert.equal(missing.calls.some(call => call[0] === 'native-power'), false);
  } finally { await missing.done(); }
  const f = fixture();
  try {
    f.state.reboot = 'challenge'; f.notify();
    assert.equal(f.get('shell-power-reboot').getAttribute('aria-disabled'), 'true');
    f.click('shell-power-reboot');
    assert.equal(f.status().phase, 'idle');
    assert.equal(f.calls.some(call => call[0] === 'native-power'), false);
  } finally { await f.done(); }
});
