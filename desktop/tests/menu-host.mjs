import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

// Run: node --test .\desktop\tests\menu-host.mjs
register('./menu-host-loader.mjs', import.meta.url);
const { createDesktopShell } = await import('./desktop/shell/shell.mjs');

// Model the existing per-document, bubbling DOM/host callbacks, not compositor input or native focus.
class Node {
  constructor(owner, type = 'view') {
    this.ownerDocument = owner;
    this.type = type;
    this.childNodes = [];
    this.parentNode = null;
    this.style = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.tabIndex = -1;
    this.id = '';
    this.scrollLeft = this.scrollTop = 0;
    this.offsetLeft = this.offsetTop = 0;
    this.offsetWidth = 1280;
    this.offsetHeight = 720;
  }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes.at(-1) || null; }
  appendChild(node) { return this.insertBefore(node, null); }
  insertBefore(node, before) {
    node.parentNode?.removeChild(node);
    const adopt = child => {
      child.ownerDocument = this.ownerDocument;
      child.childNodes.forEach(adopt);
    };
    adopt(node);
    node.parentNode = this;
    const index = before ? this.childNodes.indexOf(before) : this.childNodes.length;
    assert.ok(index >= 0);
    this.childNodes.splice(index, 0, node);
    return node;
  }
  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    assert.ok(index >= 0);
    const focus = this.ownerDocument.activeElement;
    if (descendants(node).includes(focus)) focus.blur();
    this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  removeAttribute(key) { this.attributes.delete(key); }
  querySelector(selector) {
    assert.match(selector, /^\.[a-zA-Z][\w-]*$/);
    const name = selector.slice(1);
    return descendants(this).slice(1).find(node =>
      (node.className || '').split(/\s+/).includes(name)) || null;
  }
  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) || [];
    callbacks.push(callback);
    this.listeners.set(type, callbacks);
  }
  removeEventListener(type, callback) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== callback));
  }
  focus() {
    const owner = this.ownerDocument;
    if (owner.activeElement === this) return;
    owner.activeElement?.blur();
    owner.activeElement = this;
    domEvent(this, 'focus');
  }
  blur() {
    if (this.ownerDocument.activeElement !== this) return;
    this.ownerDocument.activeElement = null;
    domEvent(this, 'blur');
  }
  setInputMethod() {}
  cancelComposition() {}
}

function descendants(node) { return [node, ...node.childNodes.flatMap(descendants)]; }
function focusable(body) {
  const result = [];
  const visit = node => {
    if (node.style.display === 'none') return;
    if (node.tabIndex >= 0) result.push(node);
    node.childNodes.forEach(visit);
  };
  visit(body);
  return result;
}
function document() {
  const owner = {
    activeElement: null,
    createElement: type => new Node(owner, type),
    createTextNode: text => Object.assign(new Node(owner, '#text'), { textContent: text }),
    getElementById: id => descendants(owner.body).find(node => node.id === id) || null,
  };
  owner.body = owner.createElement('view');
  return owner;
}
function event(type, properties = {}) {
  return {
    type, key: '', button: 0, defaultPrevented: false, stopped: false, immediate: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.stopped = true; },
    stopImmediatePropagation() { this.immediate = this.stopped = true; },
    ...properties,
  };
}
function domEvent(node, type, properties = {}) {
  const value = event(type, { target: node, ...properties });
  for (let current = node; current; current = current.parentNode) {
    value.currentTarget = current;
    for (const callback of [...(current.listeners.get(type) || [])]) {
      callback(value);
      if (value.immediate) break;
    }
    if (value.stopped || type === 'blur' || type === 'focus') break;
  }
  return value;
}
function key(window, name, properties = {}) {
  const owner = window.document;
  const value = domEvent(owner.activeElement || owner.body, 'keydown', { key: name, ...properties });
  // src/main.c app_key runs native Tab stepping only after an unprevented keydown.
  if (name === 'Tab' && !value.defaultPrevented && !value.ctrlKey && !value.altKey && !value.metaKey) {
    const nodes = focusable(owner.body), index = nodes.indexOf(owner.activeElement);
    const step = value.shiftKey ? -1 : 1;
    if (nodes.length) nodes[index < 0 ? step > 0 ? 0 : nodes.length - 1 :
      (index + step + nodes.length) % nodes.length].focus();
  }
  return value;
}
function press(node, button = 0) {
  let target = node;
  while (target && target.tabIndex < 0) target = target.parentNode;
  if (target) target.focus();
  else node.ownerDocument.activeElement?.blur();
  domEvent(node, 'mousedown', { button });
}
function click(node, button = 0) {
  press(node, button);
  domEvent(node, 'mouseup', { button });
  domEvent(node, button === 0 ? 'click' : button === 2 ? 'contextmenu' : 'auxclick', { button });
}
function callback(node, type) {
  const result = node.listeners.get(type)?.[0];
  assert.equal(typeof result, 'function');
  return result;
}
function find(window, id) {
  const node = window.document.getElementById(id);
  assert.ok(node, id);
  return node;
}

function fixture(configure = () => {}) {
  const previous = { document: globalThis.document, measureText: globalThis.measureText,
    setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval };
  globalThis.document = document();
  globalThis.measureText = value => value.length * 8;
  const timers = new Set();
  globalThis.setInterval = fn => { timers.add(fn); return fn; };
  globalThis.clearInterval = fn => timers.delete(fn);
  const created = [], warnings = [], expectedWarnings = [], saved = new Map(), calls = [];
  const state = {
    failCreate: false,
    outputs: [
      { id: 1, x: 0, y: 0, width: 1280, height: 720 },
      { id: 2, x: 1280, y: 0, width: 800, height: 600 },
    ],
    windows: [{ id: 10, title: 'Application', active: true, minimized: false, workspaceId: 7 }],
    workspaces: [
      { id: 7, order: 0, name: 'First', active: true, canRemove: true },
      { id: 9, order: 1, name: 'Second', active: false, canRemove: true },
    ],
    shortcuts: [{ action: 'minimize-window', label: 'Minimize', modifiers: 4, key: 'F9' }],
    output: { serial: 1, pendingToken: 0, remainingMs: 15000, heads: [{
      id: 1, name: 'DP-1', make: 'Fixture', model: 'Monitor', serialNumber: 'A123',
      enabled: true, width: 1280, height: 720, refresh: 60000,
      scale: 1, transform: 0, x: 0, y: 0, adaptiveSync: false, modes: [],
    }] },
  };
  const clone = value => JSON.parse(JSON.stringify(value));
  const original = () => calls.push(['previous-windows']);
  const native = {
    onWindowsChanged: original,
    windows: () => clone(state.windows),
    workspaces: () => clone(state.workspaces),
    renameWorkspace(id, name) { calls.push(['rename', id, name]); },
    activateWindow(id) { calls.push(['activate', id]); },
    minimizeWindow(id) { calls.push(['minimize', id]); },
    closeWindow(id) { calls.push(['close-window', id]); },
    shortcuts: () => clone(state.shortcuts),
    shortcutDefaults: () => clone(state.shortcuts),
    setShortcuts(value) { state.shortcuts = clone(value); calls.push(['shortcuts']); },
    captureShortcuts(value) { calls.push(['capture', value]); },
    enableWindowSwitcher(value) { calls.push(['switcher', value]); },
    applicationFiles: () => [{
      id: 'fixture.desktop', path: '/fixture.desktop',
      contents: '[Desktop Entry]\nType=Application\nName=Fixture\nExec=fixture\n',
    }],
    canExecute: () => true,
    spawnApplication(...args) { calls.push(['launch', ...args]); return 123; },
    outputConfiguration: () => clone(state.output),
    applyOutputConfiguration(draft) { calls.push(['apply-outputs', draft]); },
    confirmOutputConfiguration(token) {
      assert.equal(token, state.output.pendingToken);
      calls.push(['keep-outputs', token]); state.output.pendingToken = 0;
    },
    revertOutputConfiguration(token) {
      assert.equal(token, state.output.pendingToken);
      calls.push(['revert-outputs', token]); state.output.pendingToken = 0;
    },
    startPower() { calls.push(['start-power']); },
    stopPower() { calls.push(['stop-power']); },
    powerState: () => ({ ready: true, active: true, revision: 1, poweroff: 'yes', reboot: 'yes' }),
    requestPower() { assert.fail('Dismissal/navigation must not request a power action'); },
  };
  const host = {
    close() {},
    displays: () => clone(state.outputs),
    create(options) {
      if (!options.layer)
        for (const key of ['output', 'anchors', 'keyboard', 'exclusiveZone', 'margins'])
          assert.equal(options[key], undefined, key + ' requires a layer surface');
      if (state.failCreate) throw new Error('fixture surface creation failed');
      const window = { options, document: document(), closed: false, closeCount: 0,
        close() {
          if (this.closed) return;
          this.closed = true; this.closeCount++;
          // app_close detaches native document focus before delivering onclose, without a DOM blur event.
          this.document.activeElement = null;
          this.onclose?.();
        } };
      created.push(window);
      return window;
    },
  };
  const storage = {
    getItem: key => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
    removeItem: key => saved.delete(key),
  };
  configure({ native, state, calls, saved });
  const shell = createDesktopShell({ host, native, storage, report: value => warnings.push(value) }).start();
  const surface = (kind, output = 1) => shell.getSurfaces().find(item => item.kind === kind && item.output === output).window;
  const done = () => {
    try {
      shell.stop();
      assert.equal(timers.size, 0);
      assert.ok(created.every(window => window.closed));
      assert.equal(native.onWindowsChanged, original);
      assert.deepEqual(warnings, expectedWarnings);
    } finally { Object.assign(globalThis, previous); }
  };
  return { shell, native, state, calls, created, surface, done, timers, saved, expectedWarnings };
}
function scenario(name, run, configure) {
  test(name, () => {
    const f = fixture(configure);
    try { run(f); } finally { f.done(); }
  });
}

function settingsBackend({ native, state, calls }) {
  const clone = value => JSON.parse(JSON.stringify(value));
  state.network = { ready: true, registered: true, revision: 10, operation: '', refreshing: false,
    networkConfiguration: true, authentication: null, error: '',
    devices: [{ id: '/net/connman/iwd/0', name: 'fixture-wifi', powered: true, station: true,
      state: 'disconnected', mode: 'station', scanning: false }],
    networks: [{ id: '/net/connman/iwd/0/test', device: '/net/connman/iwd/0', name: 'Private fixture',
      type: 'psk', signal: -45, order: 0, known: false, connected: false }] };
  state.audio = { ready: true, generation: 1, error: '', defaultSink: 20, defaultSource: 22,
    preferredSink: '', preferredSource: '', nodes: [
      { id: 20, instance: 100, revision: 1, name: 'fixture-speaker', description: 'Private speaker',
        class: 'Audio/Sink', state: 'idle', volume: 1, muted: false },
      { id: 21, instance: 101, revision: 1, name: 'fixture-headphones', description: 'Private headphones',
        class: 'Audio/Sink', state: 'idle', volume: 1, muted: false },
      { id: 22, instance: 102, revision: 1, name: 'fixture-microphone', description: 'Private microphone',
        class: 'Audio/Source', state: 'idle', volume: 1, muted: false },
    ] };
  native.audioAvailable = true;
  native.sessionServices = () => ({ inputMethod: 'disabled' });
  native.startNetwork = () => calls.push(['start-network']);
  native.stopNetwork = () => calls.push(['stop-network']);
  native.refreshNetworks = () => calls.push(['refresh-network']);
  native.networkState = () => clone(state.network);
  native.onNetworkChanged = () => calls.push(['previous-network']);
  native.networkAction = (revision, target, action) => {
    assert.equal(revision, state.network.revision);
    calls.push(['network-action', revision, target, action]);
    if (action === 'connect') {
      state.network.operation = 'connect';
      state.network.authentication = { id: 77, network: target, kind: 'passphrase' };
    }
  };
  native.replyNetworkAuthentication = (id, username, password) => {
    assert.equal(id, state.network.authentication.id);
    calls.push(['network-auth', id, username, password === null ? null : 'synthetic supplied']);
    state.network.authentication = null;
    state.network.operation = '';
    state.network.networks[0].connected = password !== null;
    state.network.networks[0].known = password !== null;
    state.network.revision++;
  };
  native.cancelNetworkConnection = () => {
    calls.push(['cancel-network']);
    state.network.authentication = null; state.network.operation = '';
  };
  native.startAudio = () => calls.push(['start-audio']);
  native.stopAudio = () => calls.push(['stop-audio']);
  native.audioState = () => clone(state.audio);
  native.onAudioChanged = () => calls.push(['previous-audio']);
  for (const operation of ['setAudioVolume', 'setAudioMute', 'setDefaultAudio'])
    native[operation] = (id, revision, value) => {
      assert.equal(revision, state.audio.nodes.find(node => node.id === id).revision);
      calls.push([operation, id, revision, value]);
    };
  native.applyOutputConfiguration = draft => {
    calls.push(['apply-outputs', clone(draft)]);
    state.output.pendingToken = 5;
    state.output.heads = clone(draft.heads);
  };
}
function settingsScenario(name, run) { scenario('Settings: ' + name, run, settingsBackend); }
function text(node) { return descendants(node).map(item => item.textContent || item.nodeValue || '').join(' '); }
function navigate(window, page) { click(find(window, 'shell-settings-page-' + page)); }

settingsScenario('taskbar, desktop and searchable application entry share one ordinary window', f => {
  click(find(f.surface('panel'), 'shell-panel-settings'));
  const settings = f.created.at(-1);
  assert.equal(settings.options.title, 'Settings');
  assert.equal(settings.options.layer, undefined);
  click(find(f.surface('panel'), 'shell-panel-settings'));
  assert.equal(f.created.at(-1), settings);
  domEvent(f.surface('wallpaper').document.body, 'contextmenu', { button: 2 });
  assert.equal(f.created.at(-1), settings);
  const applications = f.shell.showApplications(2);
  domEvent(find(applications, 'shell-app-search'), 'textinput', { data: 'Settings' });
  click(find(applications, 'shell-app-org.pollyui.shell.Settings'));
  assert.equal(applications.closed, true);
  assert.equal(settings.closed, false);
  assert.equal(f.calls.some(call => call[0] === 'launch'), false, 'Shell action does not launch a privileged public app');
});

settingsScenario('theme choices persist and repaint in place across all preset layouts', f => {
  const settings = f.shell.showSystemSettings(1);
  const stale = callback(find(settings, 'shell-theme-bigsur'), 'click');
  for (const id of ['server2003', 'aqua', 'lion', 'bigsur', 'xp']) {
    click(find(settings, 'shell-theme-' + id));
    assert.equal(settings.closed, false);
    assert.equal(f.saved.get('desktop.theme'), id);
    assert.equal(find(settings, 'shell-theme-' + id).getAttribute('aria-pressed'), 'true');
    assert.equal(f.shell.getState().themeId, id);
  }
  stale(event('click'));
  assert.equal(f.shell.getState().themeId, 'xp', 'retired rendered choices cannot apply a theme');
  for (const page of ['displays', 'network', 'audio', 'keyboard', 'about', 'appearance']) {
    navigate(settings, page);
    assert.equal(find(settings, 'shell-settings-page-' + page).getAttribute('aria-current'), 'page');
    const expected = { displays: 'shell-displays', network: 'shell-network-settings', audio: 'shell-audio-settings',
      keyboard: 'shell-shortcuts', about: 'shell-settings-about', appearance: 'shell-settings' };
    assert.ok(find(settings, expected[page]), 'navigation mounts actual page content');
    assert.equal(settings.closed, false);
  }
  assert.equal(f.created.filter(window => window.options.title === 'Settings').length, 1);
});

settingsScenario('Tab, Enter, Space, consumed Escape and close keep ordinary-window semantics', f => {
  const settings = f.shell.showSystemSettings(1);
  key(settings, 'Tab');
  assert.equal(settings.document.activeElement.id, 'shell-system-settings-close');
  find(settings, 'shell-settings-page-about').focus();
  key(settings, ' ');
  assert.ok(find(settings, 'shell-settings-about'));
  find(settings, 'shell-settings-page-appearance').focus();
  key(settings, 'Enter');
  find(settings, 'shell-theme-lion').focus(); key(settings, 'Enter');
  assert.equal(f.shell.getState().themeId, 'lion');
  assert.equal(settings.closed, false);
  const child = settings.document.createElement('view');
  child.tabIndex = 0; child.addEventListener('keydown', value => value.preventDefault());
  find(settings, 'shell-settings-content').appendChild(child); child.focus();
  key(settings, 'Escape'); assert.equal(settings.closed, false);
  settings.document.body.focus(); key(settings, 'Escape');
  assert.equal(settings.closed, true);
  assert.equal(f.shell.getState().running, true);
  assert.equal(f.calls.some(call => call[0] === 'close-window'), false);
});

settingsScenario('display edits use guarded apply, Keep persistence and live replacement drafts', f => {
  const settings = f.shell.showSystemSettings(1, 'displays');
  const field = find(settings, 'shell-output-1-scale');
  field.focus(); key(settings, 'a', { ctrlKey: true });
  domEvent(field, 'textinput', { data: '1.25' });
  click(find(settings, 'shell-output-apply'));
  const request = f.calls.find(call => call[0] === 'apply-outputs')[1];
  assert.equal(request.serial, 1);
  assert.equal(request.heads[0].scale, 1.25);
  assert.equal(settings.closed, false);
  const guard = f.created.at(-1);
  assert.ok(find(guard, 'shell-output-confirmation'));
  assert.match(text(guard.document.body), /15 seconds/);
  assert.equal(guard.options.layer, 'overlay');
  assert.equal(f.saved.has('desktop.outputs.v1'), false);
  click(find(guard, 'shell-output-keep'));
  assert.equal(guard.closed, true);
  assert.ok([...f.saved.keys()].some(key => key.includes('display')));
  assert.ok(find(settings, 'shell-output-1-scale'));
  f.state.output.serial++;
  f.state.output.heads[0].scale = 1.5;
  f.native.onOutputsChanged();
  f.expectedWarnings.push('[shell] Display settings: Outputs changed; the draft was refreshed. Review it before applying.');
  assert.match(text(settings.document.body), /draft was refreshed/);
  click(find(settings, 'shell-output-apply'));
  assert.equal(f.calls.filter(call => call[0] === 'apply-outputs').at(-1)[1].heads[0].scale, 1.5);
});

settingsScenario('closing Settings cannot confirm/revert a pending layout or stop its watchdog', f => {
  const settings = f.shell.showSystemSettings(1, 'displays');
  click(find(settings, 'shell-output-apply'));
  const guard = f.created.at(-1);
  const close = callback(find(settings, 'shell-system-settings-close'), 'click');
  click(find(settings, 'shell-system-settings-close'));
  assert.equal(guard.closed, false);
  assert.equal(f.state.output.pendingToken, 5);
  const next = f.shell.showSystemSettings(1, 'audio');
  close(event('click'));
  assert.equal(next.closed, false);
  key(guard, 'Escape');
  assert.equal(f.state.output.pendingToken, 0);
  assert.equal(next.closed, false);
});

settingsScenario('iwd scan/connect/password/disconnect/forget consume actual revision and target shapes', f => {
  const settings = f.shell.showSystemSettings(1, 'network');
  assert.match(text(settings.document.body), /fixture-wifi/);
  assert.match(text(settings.document.body), /-45 dBm/);
  click(find(settings, 'shell-network-scan-0'));
  assert.deepEqual(f.calls.find(call => call[0] === 'network-action'),
    ['network-action', 10, '/net/connman/iwd/0', 'scan']);
  click(find(settings, 'shell-network-connect-0-0'));
  assert.equal(f.calls.some(call => call[3] === 'connect'), false);
  click(find(settings, 'shell-network-confirm'));
  const password = find(settings, 'shell-network-password');
  password.focus(); domEvent(password, 'textinput', { data: 'fixture-pass' });
  assert.equal(text(password).includes('fixture-pass'), false);
  click(find(settings, 'shell-network-auth-submit'));
  assert.equal(f.state.network.authentication, null);
  assert.equal(f.state.network.networks[0].known, true);
  click(find(settings, 'shell-network-disconnect-0'));
  click(find(settings, 'shell-network-forget-0-0'));
  assert.equal(f.calls.some(call => call[3] === 'forget'), false);
  click(find(settings, 'shell-network-confirm'));
  assert.ok(f.calls.some(call => call[0] === 'network-action' && call[3] === 'forget'));
});

settingsScenario('Wi-Fi page teardown clears/cancels credentials and retires snapshot callbacks', f => {
  const settings = f.shell.showSystemSettings(1, 'network');
  const oldScan = callback(find(settings, 'shell-network-scan-0'), 'click');
  f.state.network.revision++; f.native.onNetworkChanged();
  oldScan(event('click'));
  assert.equal(f.calls.some(call => call[0] === 'network-action'), false);
  click(find(settings, 'shell-network-connect-0-0')); click(find(settings, 'shell-network-confirm'));
  const password = find(settings, 'shell-network-password');
  password.focus(); domEvent(password, 'textinput', { data: 'fixture-secret' });
  const oldSubmit = callback(find(settings, 'shell-network-auth-submit'), 'click');
  navigate(settings, 'appearance');
  assert.equal(f.state.network.authentication, null);
  assert.ok(f.calls.some(call => call[0] === 'network-auth' && call[3] === null));
  assert.equal(text(password).includes('fixture-secret'), false);
  assert.equal(text(password).includes('\u2022'), false, 'retired field is wiped');
  navigate(settings, 'network'); oldSubmit(event('click'));
  assert.equal(f.state.network.networks[0].connected, false);
  assert.equal(f.calls.some(call => call[0] === 'stop-network'), false);
});

settingsScenario('iwd service loss and changed confirmation disable requests without invented readiness', f => {
  const settings = f.shell.showSystemSettings(1, 'network');
  click(find(settings, 'shell-network-connect-0-0'));
  f.state.network.revision++; f.native.onNetworkChanged();
  assert.equal(find(settings, 'shell-network-confirm').getAttribute('aria-disabled'), 'true');
  click(find(settings, 'shell-network-confirm'));
  assert.equal(f.calls.some(call => call[0] === 'network-action'), false);
  click(find(settings, 'shell-network-confirm-cancel'));
  f.state.network.ready = false; f.state.network.error = 'Private fixture iwd unavailable';
  f.native.onNetworkChanged();
  assert.match(text(settings.document.body), /iwd unavailable/);
  assert.equal(find(settings, 'shell-network-scan-0').getAttribute('aria-disabled'), 'true');
  click(find(settings, 'shell-network-scan-0'));
  assert.equal(f.calls.some(call => call[0] === 'network-action'), false);
});

settingsScenario('PipeWire volume, mute and default devices show progress and save only acknowledgments', f => {
  const settings = f.shell.showSystemSettings(1, 'audio');
  assert.match(text(settings.document.body), /Private speaker/);
  click(find(settings, 'shell-audio-lower-20'));
  assert.deepEqual(f.calls.find(call => call[0] === 'setAudioVolume'), ['setAudioVolume', 20, 1, 0.9]);
  assert.match(text(settings.document.body), /acknowledge and save/);
  assert.equal(f.saved.has('desktop.audio.v1'), false);
  assert.equal(find(settings, 'shell-audio-mute-20').getAttribute('aria-disabled'), 'true');
  f.state.audio.nodes[0].volume = 0.9; f.state.audio.nodes[0].revision++; f.native.onAudioChanged();
  assert.equal(JSON.parse(f.saved.get('desktop.audio.v1')).devices[0].volume, 0.9);
  click(find(settings, 'shell-audio-mute-22'));
  f.state.audio.nodes[2].muted = true; f.state.audio.nodes[2].revision++; f.native.onAudioChanged();
  assert.equal(JSON.parse(f.saved.get('desktop.audio.v1')).devices.find(node => node.name === 'fixture-microphone').muted, true);
  click(find(settings, 'shell-audio-default-21'));
  f.state.audio.defaultSink = 21; f.state.audio.preferredSink = 'fixture-headphones'; f.native.onAudioChanged();
  assert.equal(JSON.parse(f.saved.get('desktop.audio.v1')).preferredSink, 'fixture-headphones');
  assert.equal(settings.closed, false);
});

settingsScenario('audio policy outlives Settings and persists an acknowledgment after page detach', f => {
  const settings = f.shell.showSystemSettings(1, 'audio');
  const oldMute = callback(find(settings, 'shell-audio-mute-20'), 'click');
  click(find(settings, 'shell-audio-lower-20'));
  settings.close();
  assert.equal(f.calls.some(call => call[0] === 'stop-audio'), false);
  f.state.audio.nodes[0].volume = 0.9; f.state.audio.nodes[0].revision++; f.native.onAudioChanged();
  assert.equal(JSON.parse(f.saved.get('desktop.audio.v1')).devices[0].volume, 0.9);
  const next = f.shell.showSystemSettings(1, 'audio');
  assert.match(text(next.document.body), /90%/);
  oldMute(event('click'));
  assert.equal(f.calls.some(call => call[0] === 'setAudioMute'), false);
  assert.equal(f.calls.filter(call => call[0] === 'start-audio').length, 1);
});

settingsScenario('keyboard changes retain the trusted-layer capture boundary and existing persistence', f => {
  const settings = f.shell.showSystemSettings(1, 'keyboard');
  click(find(settings, 'shell-shortcut-minimize-window'));
  const capture = f.created.at(-1);
  assert.equal(capture.options.layer, 'overlay');
  assert.equal(settings.closed, false);
  key(capture, 'm', { ctrlKey: true });
  assert.equal(f.state.shortcuts[0].key, 'm');
  assert.ok(f.saved.has('desktop.shortcuts.v1'));
  key(capture, 'Escape');
  assert.equal(capture.closed, true);
  assert.match(text(settings.document.body), /Ctrl\+M/);
  click(find(settings, 'shell-shortcut-disable-minimize-window'));
  assert.equal(f.state.shortcuts[0].key, '');
});

settingsScenario('unsupported capabilities stay visible and About makes no login/version claims', f => {
  const settings = f.shell.showSystemSettings(1);
  delete f.native.startNetwork; delete f.native.startAudio; delete f.native.outputConfiguration; delete f.native.shortcuts;
  for (const page of ['network', 'audio', 'displays', 'keyboard']) {
    navigate(settings, page);
    assert.match(text(settings.document.body), /unavailable|requires/i);
    assert.ok(descendants(settings.document.body).some(node => node.getAttribute('aria-disabled') === 'true'));
  }
  navigate(settings, 'about');
  assert.match(text(settings.document.body), /version is not exposed/);
  assert.match(text(settings.document.body), /Input method: disabled/);
  assert.equal(text(settings.document.body).includes('No login'), false);
});

settingsScenario('close/reopen and Shell restart restore listeners and reject old generations', f => {
  const previousNetwork = f.native.onNetworkChanged;
  const settings = f.shell.showSystemSettings(1, 'network');
  const oldNav = callback(find(settings, 'shell-settings-page-appearance'), 'click');
  const oldClose = settings.onclose;
  settings.close();
  assert.equal(settings.document.body.listeners.get('keydown').length, 0);
  f.shell.stop();
  assert.equal(f.native.onNetworkChanged, previousNetwork);
  assert.equal(f.timers.size, 0);
  f.shell.start();
  const next = f.shell.showSystemSettings(1, 'about');
  oldNav(event('click')); oldClose();
  assert.ok(find(next, 'shell-settings-about'));
  assert.equal(next.closed, false);
});

settingsScenario('late device notifications and detached controls cannot replace a later page', f => {
  const settings = f.shell.showSystemSettings(1, 'network');
  const oldScan = callback(find(settings, 'shell-network-scan-0'), 'click');
  navigate(settings, 'audio');
  const audioRoot = find(settings, 'shell-audio-settings');
  f.state.network.devices[0].name = 'Changed after detach'; f.native.onNetworkChanged();
  oldScan(event('click'));
  assert.equal(find(settings, 'shell-audio-settings'), audioRoot);
  assert.equal(settings.document.getElementById('shell-network-settings'), null);
  assert.equal(f.calls.some(call => call[0] === 'network-action'), false);
  const oldMute = callback(find(settings, 'shell-audio-mute-20'), 'click');
  navigate(settings, 'appearance');
  const appearance = find(settings, 'shell-settings');
  f.state.audio.generation++;
  f.state.audio.nodes[0].instance++; f.native.onAudioChanged();
  oldMute(event('click'));
  assert.equal(find(settings, 'shell-settings'), appearance);
  assert.equal(settings.document.getElementById('shell-audio-settings'), null);
  assert.equal(f.calls.some(call => call[0] === 'setAudioMute'), false);
  assert.ok(f.calls.some(call => call[0] === 'previous-network'));
  assert.ok(f.calls.some(call => call[0] === 'previous-audio'));
});

settingsScenario('theme repaint preserves current credential value/focus and unavailable-state retry reports errors', f => {
  const settings = f.shell.showSystemSettings(1, 'network');
  click(find(settings, 'shell-network-connect-0-0')); click(find(settings, 'shell-network-confirm'));
  const input = find(settings, 'shell-network-password');
  input.focus(); domEvent(input, 'textinput', { data: 'fixture-secret' });
  f.shell.selectTheme('bigsur');
  assert.equal(find(settings, 'shell-network-password'), input);
  assert.equal(settings.document.activeElement, input);
  assert.match(text(input), /\u2022{14}/);
  click(find(settings, 'shell-network-auth-cancel'));
  f.native.networkState = () => { throw new Error('fixture state read failed'); };
  f.native.onNetworkChanged();
  f.expectedWarnings.push('[shell] Network: Error: fixture state read failed');
  assert.match(text(settings.document.body), /fixture state read failed/);
  assert.equal(settings.document.getElementById('shell-network-scan-0'), null);
  assert.ok(find(settings, 'shell-network-retry'));
});

for (const kind of ['passphrase', 'username-password'])
settingsScenario('a long multi-network list mounts ' + kind + ' fields and preserves the same prompt on repaint', f => {
  const prototype = f.state.network.networks[0];
  f.state.network.networks.push(...Array.from({ length: 12 }, (_, index) => ({
    ...prototype, id: prototype.id + '-' + index, name: 'Private fixture ' + index, order: index + 1,
  })));
  let authentication = null;
  const originalAction = f.native.networkAction;
  f.native.networkAction = (...args) => {
    originalAction(...args);
    if (args[2] === 'connect') {
      authentication = f.state.network.authentication;
      authentication.kind = kind;
      authentication.username = 'fixture-user';
      f.state.network.authentication = null;
    }
  };
  const settings = f.shell.showSystemSettings(1, 'network');
  assert.ok(find(settings, 'shell-network-connect-0-12'));
  click(find(settings, 'shell-network-connect-0-0')); click(find(settings, 'shell-network-confirm'));
  assert.equal(settings.document.getElementById('shell-network-password'), null);
  f.state.network.authentication = authentication; f.native.onNetworkChanged();
  const field = find(settings, 'shell-network-password');
  const user = kind === 'username-password' ? find(settings, 'shell-network-username') : null;
  assert.equal(settings.document.activeElement, user || field);
  field.focus();
  domEvent(field, 'textinput', { data: 'fixture-secret' });
  f.native.onNetworkChanged();
  f.shell.selectTheme('bigsur');
  assert.equal(find(settings, 'shell-network-password'), field);
  if (user) assert.equal(find(settings, 'shell-network-username'), user);
  assert.equal(settings.document.activeElement, field);
  assert.match(text(field), /\u2022{14}/);
  if (kind === 'passphrase') {
    f.state.network.authentication.kind = 'username-password';
    f.native.onNetworkChanged();
    assert.ok(find(settings, 'shell-network-username'));
    const replacement = find(settings, 'shell-network-password');
    assert.notEqual(replacement, field);
    assert.equal(text(field).includes('\u2022'), false, 'changed prompt kind wipes the old field');
    replacement.focus(); domEvent(replacement, 'textinput', { data: 'fixture-secret' });
  }
  click(find(settings, 'shell-network-auth-submit'));
  assert.equal(f.state.network.networks[0].connected, true);
});

function blockedActivation(f) {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  f.native.applicationFiles = () => [{
    id: 'org.pollyui.MenuFixture.desktop', path: '/synthetic/org.pollyui.MenuFixture.desktop',
    contents: '[Desktop Entry]\nType=Application\nName=Fixture\nDBusActivatable=true\n',
  }];
  f.native.canActivateApplication = () => true;
  f.native.activateApplication = id => { f.calls.push(['activate', id]); return promise; };
  return { resolve, reject };
}

test('blocked activation keeps its menu until acknowledged and returns no invented PID', async () => {
  const f = fixture();
  try {
    const blocked = blockedActivation(f), menu = f.shell.showApplications(1);
    const pending = f.shell.launchApplication('org.pollyui.MenuFixture.desktop');
    assert.equal(menu.closed, false);
    assert.deepEqual(f.calls.filter(call => call[0] === 'activate'), [['activate', 'org.pollyui.MenuFixture.desktop']]);
    const acknowledgement = { kind: 'dbus', id: 'org.pollyui.MenuFixture.desktop', acknowledged: true };
    blocked.resolve(acknowledgement);
    assert.equal(await pending, acknowledgement);
    assert.equal(menu.closed, true);
    assert.equal(menu.closeCount, 1);
    assert.equal(f.calls.some(call => call[0] === 'launch'), false);
  } finally { f.done(); }
});

test('blocked activation rejection remains visible in the originating menu', async () => {
  const f = fixture();
  try {
    const blocked = blockedActivation(f), menu = f.shell.showApplications(1);
    const pending = f.shell.launchApplication('org.pollyui.MenuFixture.desktop');
    blocked.reject(new Error('synthetic method failure'));
    assert.equal(await pending, null);
    assert.equal(menu.closed, false);
    assert.match(f.shell.getState().error, /synthetic method failure/);
    f.expectedWarnings.push('[shell] Could not launch application: Error: synthetic method failure');
    assert.equal(f.calls.some(call => call[0] === 'launch'), false);
  } finally { f.done(); }
});

for (const result of ['acknowledgement', 'rejection']) {
  test('menu-less activation ' + result + ' from a stopped generation cannot mutate a restarted Shell', async () => {
    const f = fixture();
    try {
      const blocked = blockedActivation(f);
      const pending = f.shell.launchApplication('org.pollyui.MenuFixture.desktop');
      f.shell.stop();
      f.shell.start();
      assert.equal(f.shell.launchApplication('missing.desktop'), null);
      f.expectedWarnings.push('[shell] Could not launch application: Error: Application is no longer available');
      const before = f.shell.getState().error;
      if (result === 'acknowledgement') blocked.resolve({ kind: 'dbus', acknowledged: true });
      else {
        blocked.reject(new Error('old generation activation failed'));
        f.expectedWarnings.push('[shell] Could not launch application: Error: old generation activation failed');
      }
      await pending;
      assert.equal(f.shell.getState().error, before);
      assert.equal(f.shell.getState().running, true);
    } finally { f.done(); }
  });

  test('late activation ' + result + ' cannot affect a new applications instance of the same menu', async () => {
    const f = fixture();
    try {
      const blocked = blockedActivation(f), first = f.shell.showApplications(1);
      const pending = f.shell.launchApplication('org.pollyui.MenuFixture.desktop');
      key(first, 'Escape');
      const reopened = f.shell.showApplications(1);
      const root = reopened.document.body.firstChild, before = f.shell.getState().error;
      if (result === 'acknowledgement') blocked.resolve({ kind: 'dbus', acknowledged: true });
      else {
        blocked.reject(new Error('late reopened-menu failure'));
        f.expectedWarnings.push('[shell] Could not launch application: Error: late reopened-menu failure');
      }
      await pending;
      assert.equal(reopened.closed, false);
      assert.equal(reopened.document.body.firstChild, root);
      assert.equal(f.shell.getState().error, before);
    } finally { f.done(); }
  });

  test('late activation ' + result + ' cannot close or repaint a reopened/replaced menu', async () => {
    const f = fixture();
    try {
      const blocked = blockedActivation(f), first = f.shell.showApplications(1);
      const pending = f.shell.launchApplication('org.pollyui.MenuFixture.desktop');
      key(first, 'Escape');
      assert.equal(first.closed, true);
      const reopened = f.shell.showApplications(1);
      const replacement = f.shell.showSettings(2);
      assert.equal(reopened.closed, true);
      const root = replacement.document.body.firstChild, before = f.shell.getState().error;
      if (result === 'acknowledgement') blocked.resolve({ kind: 'dbus', acknowledged: true });
      else {
        blocked.reject(new Error('late synthetic failure'));
        f.expectedWarnings.push('[shell] Could not launch application: Error: late synthetic failure');
      }
      await pending;
      assert.equal(replacement.closed, false);
      assert.equal(replacement.document.body.firstChild, root);
      assert.equal(f.shell.getState().error, before);
      assert.equal(first.closeCount, 1);
      assert.equal(f.calls.some(call => call[0] === 'launch'), false);
    } finally { f.done(); }
  });

  test('late activation ' + result + ' after stop logs failure without Shell UI mutation', async () => {
    const f = fixture();
    try {
      const blocked = blockedActivation(f), menu = f.shell.showApplications(1);
      const pending = f.shell.launchApplication('org.pollyui.MenuFixture.desktop');
      f.shell.stop();
      const before = f.shell.getState().error, created = f.created.length;
      if (result === 'acknowledgement') blocked.resolve({ kind: 'dbus', acknowledged: true });
      else {
        blocked.reject(new Error('shutdown cancelled activation'));
        f.expectedWarnings.push('[shell] Could not launch application: Error: shutdown cancelled activation');
      }
      await pending;
      assert.equal(menu.closeCount, 1);
      assert.equal(f.created.length, created);
      assert.equal(f.shell.getState().error, before);
      assert.equal(f.shell.getState().running, false);
    } finally { f.done(); }
  });
}

scenario('owned wallpaper/panel/dock presses dismiss across outputs without suppressing the action', f => {
  for (const button of [0, 1, 2]) {
    const menu = f.shell.showSettings(1);
    press(f.surface('wallpaper', 2).document.body, button);
    assert.equal(menu.closed, true);
    assert.equal(menu.closeCount, 1);
  }
  let menu = f.shell.showSettings(1);
  click(find(f.surface('panel'), 'shell-window-10'));
  assert.equal(menu.closed, true);
  assert.ok(f.calls.some(call => call[0] === 'minimize'));
  assert.equal(f.shell.selectTheme('bigsur'), true);
  menu = f.shell.showSettings(1);
  press(f.surface('dock', 2).document.body);
  assert.equal(menu.closed, true);
});

scenario('launcher toggles remain scoped while Settings buttons reuse a persistent ordinary window', f => {
  const panel = f.surface('panel');
  click(find(panel, 'shell-menu'));
  const first = f.created.at(-1);
  assert.ok(find(first, 'shell-applications'));
  click(find(panel, 'shell-menu').firstChild);
  assert.equal(first.closed, true);
  assert.ok(f.created.at(-1) === first, 'same opener must not close on press then reopen on click');
  click(find(panel, 'shell-panel-settings'));
  const appearance = f.created.at(-1);
  assert.ok(find(appearance, 'shell-system-settings'));
  assert.equal(appearance.options.layer, undefined);
  click(find(panel, 'shell-menu'));
  assert.equal(appearance.closed, false, 'ordinary Settings is not dismissed by opening a menu');
  assert.ok(find(f.created.at(-1), 'shell-applications'));
  const applications = f.created.at(-1);
  click(find(f.surface('panel', 2), 'shell-menu'));
  assert.equal(applications.closed, true);
  assert.equal(f.created.at(-1).options.output, 2);
  assert.equal(f.shell.selectTheme('bigsur'), true);
  const dock = f.surface('dock');
  click(find(dock, 'shell-dock-applications'));
  const current = f.created.at(-1);
  click(find(dock, 'shell-dock-applications'));
  assert.equal(current.closed, true);
  assert.ok(f.created.at(-1) === current);
  for (const id of ['shell-dock-settings', 'shell-dock-about']) {
    click(find(dock, id)); click(find(dock, id));
    assert.equal(appearance.closed, false);
    assert.equal(f.shell.showSystemSettings(1), appearance);
  }
  assert.ok(find(appearance, 'shell-settings-about'));
});

scenario('right-click window and workspace menu triggers still toggle rather than reopen', f => {
  const panel = f.surface('panel');
  click(find(panel, 'shell-window-10'), 2);
  const current = f.created.at(-1);
  click(find(panel, 'shell-window-10').firstChild, 2);
  assert.equal(current.closed, true);
  assert.ok(f.created.at(-1) === current);
  click(find(panel, 'shell-workspaces'));
  const workspace = f.created.at(-1);
  click(find(panel, 'shell-workspaces'));
  assert.equal(workspace.closed, true);
  assert.ok(f.created.at(-1) === workspace);
});

scenario('internal pointer/focus/scroll and a consumed child Escape do not dismiss', f => {
  const menu = f.shell.showApplications(1);
  const search = find(menu, 'shell-app-search');
  press(search);
  domEvent(search, 'textinput', { data: 'fix' });
  assert.match(find(menu, 'shell-app-search').firstChild.firstChild.textContent, /fix/);
  press(find(menu, 'shell-applications'));
  domEvent(find(menu, 'shell-applications'), 'wheel', { deltaY: 40 });
  key(menu, 'Tab');
  assert.equal(menu.closed, false);
  const child = menu.document.createElement('view');
  child.tabIndex = 0;
  child.addEventListener('keydown', value => { if (value.key === 'Escape') value.preventDefault(); });
  find(menu, 'shell-applications').appendChild(child);
  child.focus();
  assert.equal(key(menu, 'Escape').defaultPrevented, true);
  assert.equal(menu.closed, false);
  child.removeEventListener('keydown', callback(child, 'keydown'));
  key(menu, 'Escape');
  assert.equal(menu.closed, true);
  assert.ok(menu.document.activeElement === null, 'closed menu releases DOM focus');
});

scenario('Tab/Shift+Tab retain host navigation and Enter/Space/Escape act on the current menu', f => {
  const menu = f.shell.showSettings(1);
  assert.ok(menu.document.activeElement === menu.document.body);
  key(menu, 'Tab');
  assert.equal(menu.document.activeElement.id, 'shell-settings-close');
  key(menu, 'Tab', { shiftKey: true });
  assert.ok(menu.document.activeElement === menu.document.body);
  find(menu, 'shell-theme-bigsur').focus();
  key(menu, 'Enter');
  assert.equal(menu.closed, true);
  assert.equal(f.shell.getState().themeId, 'bigsur');
  const next = f.shell.showSettings(1);
  find(next, 'shell-settings-close').focus();
  key(next, ' ');
  assert.equal(next.closed, true);
  const last = f.shell.showApplications(1);
  assert.equal(last.document.activeElement.id, 'shell-app-search');
  key(last, 'Escape');
  assert.equal(last.closed, true);
});

scenario('retained callbacks from closed/replaced menus cannot close, mutate, launch or capture', f => {
  const first = f.shell.showApplications(1);
  const oldSearch = callback(find(first, 'shell-app-search'), 'textinput');
  const oldLaunch = callback(find(first, 'shell-app-fixture.desktop'), 'click');
  const oldClose = callback(find(first, 'shell-app-close'), 'click');
  const oldKey = callback(first.document.body, 'keydown');
  const oldOnclose = first.onclose;
  const next = f.shell.showApplications(2);
  oldSearch(event('textinput', { data: 'stale' }));
  oldLaunch(event('click'));
  oldClose(event('click'));
  oldKey(event('keydown', { key: 'Escape' }));
  oldOnclose();
  assert.equal(next.closed, false);
  assert.equal(next.document.activeElement.id, 'shell-app-search');
  assert.equal(find(next, 'shell-app-search').firstChild.firstChild.textContent, 'Type to search...');
  assert.equal(f.calls.some(call => call[0] === 'launch'), false);
  assert.ok(first.document.activeElement === null, 'replaced menu releases DOM focus');
  assert.equal(first.document.body.listeners.get('keydown').length, 0);
  const settings = f.shell.showSettings(1);
  const oldTheme = callback(find(settings, 'shell-theme-bigsur'), 'click');
  const oldChild = callback(find(settings, 'shell-keyboard-settings'), 'click');
  const shortcuts = f.shell.showShortcuts(1);
  oldTheme(event('click')); oldChild(event('click'));
  assert.equal(f.shell.getState().themeId, 'xp');
  assert.equal(shortcuts.closed, false);
});

scenario('shortcut recording cancels once on Escape/close and stale keys do not affect reopened capture', f => {
  const first = f.shell.showShortcuts(1);
  click(find(first, 'shell-shortcut-minimize-window'));
  assert.deepEqual(f.calls.filter(call => call[0] === 'capture'), [['capture', true]]);
  const oldKey = callback(first.document.body, 'keydown');
  key(first, 'Escape');
  assert.equal(first.closed, false, 'first Escape only cancels recording');
  assert.deepEqual(f.calls.filter(call => call[0] === 'capture'), [['capture', true], ['capture', false]]);
  key(first, 'Escape');
  assert.equal(first.closed, true);
  const next = f.shell.showShortcuts(1);
  click(find(next, 'shell-shortcut-minimize-window'));
  oldKey(event('keydown', { key: 'Escape' }));
  oldKey(event('keydown', { key: 'm', ctrlKey: true }));
  assert.equal(next.closed, false);
  assert.equal(f.state.shortcuts[0].key, 'F9');
  next.close();
  assert.deepEqual(f.calls.filter(call => call[0] === 'capture'),
    [['capture', true], ['capture', false], ['capture', true], ['capture', false]]);
  assert.ok(next.document.activeElement === null, 'externally closed menu releases DOM focus');
  assert.equal(next.document.body.listeners.get('keydown').length, 0);
});

scenario('failed replacement retires capture/listeners/focus and a subsequent menu can recover', f => {
  const first = f.shell.showShortcuts(1);
  click(find(first, 'shell-shortcut-minimize-window'));
  f.state.failCreate = true;
  f.expectedWarnings.push('[shell] Could not open settings: Error: fixture surface creation failed');
  assert.equal(f.shell.showSettings(1), null);
  assert.equal(first.closed, true);
  assert.ok(first.document.activeElement === null, 'failed replacement releases DOM focus');
  assert.equal(first.document.body.listeners.get('keydown').length, 0);
  assert.deepEqual(f.calls.filter(call => call[0] === 'capture'), [['capture', true], ['capture', false]]);
  f.state.failCreate = false;
  const next = f.shell.showSettings(1);
  assert.equal(next.closed, false);
  key(next, 'Escape');
  assert.equal(next.closed, true);
});

scenario('current search launch, shortcut save and display apply still use their actual callbacks', f => {
  const applications = f.shell.showApplications(1);
  domEvent(find(applications, 'shell-app-search'), 'textinput', { data: 'Fixture' });
  key(applications, 'Enter');
  assert.equal(applications.closed, true);
  assert.deepEqual(f.calls.find(call => call[0] === 'launch'), ['launch', ['fixture'], '', 'fixture.desktop']);
  const shortcuts = f.shell.showShortcuts(1);
  click(find(shortcuts, 'shell-shortcut-minimize-window'));
  key(shortcuts, 'm', { ctrlKey: true });
  assert.equal(shortcuts.closed, false);
  assert.equal(f.state.shortcuts[0].key, 'm');
  assert.equal(f.state.shortcuts[0].modifiers, 2);
  const display = f.shell.showDisplays(1);
  const width = find(display, 'shell-output-1-width');
  width.focus();
  key(display, 'ArrowLeft');
  assert.equal(display.closed, false, 'field cursor navigation remains local');
  click(find(display, 'shell-output-apply'));
  assert.equal(display.closed, true);
  assert.ok(display.document.activeElement === null, 'applied display menu releases its input focus');
  assert.equal(f.calls.find(call => call[0] === 'apply-outputs')[1].heads[0].width, 1280);
});

scenario('workspace editor focus is internal and retired Enter cannot save a replacement editor', f => {
  const first = f.shell.showWorkspaces(1);
  click(find(first, 'shell-workspace-rename-7'));
  const oldInput = find(first, 'shell-workspace-name');
  const oldEnter = oldInput.listeners.get('keydown').at(-1);
  assert.ok(first.document.activeElement === oldInput);
  press(find(first, 'shell-workspace-menu'));
  oldInput.focus();
  assert.equal(first.closed, false);
  first.close();
  assert.ok(first.document.activeElement === null, 'closed workspace menu releases editor focus');
  const next = f.shell.showWorkspaces(1);
  click(find(next, 'shell-workspace-rename-9'));
  oldEnter(event('keydown', { key: 'Enter' }));
  assert.equal(f.calls.some(call => call[0] === 'rename'), false);
  assert.ok(next.document.activeElement === find(next, 'shell-workspace-name'));
  key(next, 'Enter');
  assert.ok(f.calls.some(call => call[0] === 'rename' && call[1] === 9));
});

scenario('settings replacement and transfer to a power child do not misclose the new panel', f => {
  const first = f.shell.showSettings(1);
  const oldKey = callback(first.document.body, 'keydown');
  click(find(first, 'shell-keyboard-settings'));
  const shortcuts = f.created.at(-1);
  assert.equal(first.closed, true);
  oldKey(event('keydown', { key: 'Escape' }));
  assert.equal(shortcuts.closed, false);
  const settings = f.shell.showSettings(1);
  const staleClose = callback(find(settings, 'shell-settings-close'), 'click');
  click(find(settings, 'shell-power-settings-open'));
  const power = f.created.at(-1);
  assert.equal(settings.closed, true);
  click(find(power, 'shell-power-poweroff'));
  press(find(power, 'shell-power-confirm'));
  find(power, 'shell-power-cancel').focus();
  staleClose(event('click'));
  assert.equal(power.closed, false);
  key(power, 'Enter');
  assert.equal(power.closed, false);
  assert.equal(power.document.getElementById('shell-power-confirm'), null);
  key(power, 'Escape');
  assert.equal(power.closed, true);
});

scenario('target removal/workspace change close menus; ordinary metadata/active changes do not fake focus loss', f => {
  const current = f.shell.showWindowActions(1, 10);
  f.state.windows[0].title = 'Renamed';
  f.state.windows[0].active = false;
  f.native.onWindowsChanged();
  assert.equal(current.closed, false);
  const staleAction = callback(find(current, 'shell-window-activate'), 'click');
  f.state.windows = [];
  f.native.onWindowsChanged();
  assert.equal(current.closed, true);
  const replacement = f.shell.showSettings(1);
  staleAction(event('click'));
  assert.equal(replacement.closed, false);
  assert.equal(f.calls.some(call => call[0] === 'activate'), false);
  f.state.workspaces.forEach(workspace => { workspace.active = workspace.id === 9; });
  f.native.onWorkspacesChanged();
  assert.equal(replacement.closed, true);
});

scenario('display removal and retired/recreated Shell surface callbacks are isolated', f => {
  const menu = f.shell.showSettings(2);
  const retired = f.surface('wallpaper', 2);
  const oldPress = callback(retired.document.body, 'mousedown');
  f.state.outputs = [f.state.outputs[0]];
  f.shell.refresh(true);
  assert.equal(menu.closed, true);
  assert.equal(retired.closed, true);
  assert.equal(retired.document.body.listeners.get('mousedown').length, 0);
  const next = f.shell.showSettings(1);
  oldPress(event('mousedown', { target: retired.document.body }));
  assert.equal(next.closed, false);
  const oldPanel = f.surface('panel');
  const oldPanelPress = callback(oldPanel.document.body, 'mousedown');
  assert.equal(f.shell.selectTheme('bigsur'), true);
  const dockMenu = f.shell.showSettings(1);
  oldPanelPress(event('mousedown', { target: oldPanel.document.body }));
  assert.equal(dockMenu.closed, false);
});

scenario('retired display menu callbacks cannot apply to a replacement', f => {
  const settings = f.shell.showDisplays(1);
  const apply = callback(find(settings, 'shell-output-apply'), 'click');
  const input = find(settings, 'shell-output-1-width');
  input.focus();
  settings.close();
  assert.ok(settings.document.activeElement === null, 'closed display menu releases input focus');
  const next = f.shell.showSettings(1);
  apply(event('click'));
  assert.equal(f.calls.some(call => call[0] === 'apply-outputs'), false);
  assert.equal(next.closed, false);
});

scenario('retired display confirmation callbacks cannot finish a replacement transaction', f => {
  f.state.output.pendingToken = 1;
  f.native.onOutputsChanged();
  const first = f.created.at(-1);
  const oldKey = callback(first.document.body, 'keydown');
  const oldKeep = callback(find(first, 'shell-output-keep'), 'click');
  const oldClose = first.onclose;
  f.state.output.pendingToken = 2;
  f.native.onOutputsChanged();
  const replacement = f.created.at(-1);
  oldKey(event('keydown', { key: 'Escape' }));
  oldKeep(event('click')); oldClose();
  assert.equal(f.state.output.pendingToken, 2);
  assert.equal(replacement.closed, false);
  assert.equal(first.document.body.listeners.get('keydown').length, 0);
  key(replacement, 'Enter');
  assert.equal(replacement.closed, true);
  assert.equal(f.state.output.pendingToken, 0);
  assert.deepEqual(f.calls.filter(call => call[0].endsWith('-outputs')), [['keep-outputs', 2]]);
});

scenario('stop/restart cleans owned listeners, focus and capture and rejects old generations', f => {
  const first = f.shell.showShortcuts(1);
  click(find(first, 'shell-shortcut-minimize-window'));
  const oldKey = callback(first.document.body, 'keydown');
  const oldChange = callback(find(first, 'shell-shortcut-minimize-window'), 'click');
  const oldPanel = f.surface('panel');
  const oldPress = callback(oldPanel.document.body, 'mousedown');
  f.shell.stop();
  assert.equal(f.timers.size, 0);
  assert.ok(f.created.every(window => window.closed));
  assert.ok(first.document.activeElement === null, 'stopping Shell releases menu focus');
  assert.equal(oldPanel.document.body.listeners.get('mousedown').length, 0);
  f.shell.start();
  const next = f.shell.showShortcuts(1);
  oldKey(event('keydown', { key: 'Escape' }));
  oldChange(event('click'));
  oldPress(event('mousedown', { target: oldPanel.document.body }));
  assert.equal(next.closed, false);
  assert.deepEqual(f.calls.filter(call => call[0] === 'capture'), [['capture', true], ['capture', false]]);
  find(next, 'shell-shortcuts-close').focus();
  key(next, 'Enter');
  assert.equal(next.closed, true);
});

scenario('repeated explicit/external closes release each menu only once without accumulating listeners', f => {
  for (let index = 0; index < 24; index++) {
    const menu = f.shell.showApplications(1);
    const oldKey = callback(menu.document.body, 'keydown');
    if (index % 2) menu.close();
    else key(menu, 'Escape');
    menu.close();
    assert.equal(menu.closeCount, 1);
    assert.ok(menu.document.activeElement === null, 'every close releases menu focus');
    assert.equal(menu.document.body.listeners.get('keydown').length, 0);
    const next = f.shell.showSettings(1);
    oldKey(event('keydown', { key: 'Escape' }));
    assert.equal(next.closed, false);
    key(next, 'Escape');
    assert.equal(f.created.filter(window => !window.closed).length, f.shell.getSurfaces().length);
    assert.equal(f.timers.size, 1);
  }
});
