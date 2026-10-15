import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

// Run: node --test .\desktop\tests\menu-host.mjs
register('./menu-host-loader.mjs', import.meta.url);
const { createDesktopShell } = await import('./desktop/shell/shell.mjs');
const { memoryConfiguration, fixtureShortcuts } = await import('./desktop/tests/configuration-memory.mjs');
const { defaultShellConfiguration } = await import('./desktop/shell/configuration.mjs');
const { getDesktopTheme } = await import('./desktop/shell/themes.mjs');
const { applicationsView } = await import('./desktop/shell/views.mjs');

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
    assert.match(selector, /^[.#][a-zA-Z][\w-]*$/);
    const name = selector.slice(1);
    return descendants(this).slice(1).find(node =>
      selector[0] === '#' ? node.id === name : (node.className || '').split(/\s+/).includes(name)) || null;
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
  getBoundingClientRect() {
    return { x: this.offsetLeft, y: this.offsetTop, width: this.offsetWidth, height: this.offsetHeight,
      right: this.offsetLeft + this.offsetWidth, bottom: this.offsetTop + this.offsetHeight };
  }
  getContext() {
    // Controller-only fixture; Classic pixels are covered by the GUI render fixtures.
    return { fillRect() {}, clearRect() {}, save() {}, restore() {}, translate() {}, scale() {},
      resetTransform() {}, createPattern: () => ({}) };
  }
  setMouseCapture() { this.ownerDocument.captured = this; }
  releaseMouseCapture() { this.ownerDocument.captured = null; domEvent(this, 'lostmousecapture'); }
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
  // gui/src/context/context.c app_key runs native Tab stepping only after an unprevented keydown.
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
    setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval,
    requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame };
  globalThis.document = document();
  globalThis.measureText = value => value.length * 8;
  const timers = new Set();
  globalThis.setInterval = fn => { timers.add(fn); return fn; };
  globalThis.clearInterval = fn => timers.delete(fn);
  const frames = new Map();
  let serial = 0;
  globalThis.requestAnimationFrame = callback => { frames.set(++serial, callback); return serial; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  const flushFrames = () => {
    for (let count = 0; frames.size; count++) {
      assert.ok(count < 10, 'bounded layout frames');
      const ready = [...frames.values()]; frames.clear();
      ready.forEach(callback => callback(0));
    }
  };
  const created = [], warnings = [], expectedWarnings = [], calls = [];
  const saved = memoryConfiguration(defaultShellConfiguration(), () => {
    if (state.configurationFailure) throw state.configurationFailure;
  });
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
    shortcuts: fixtureShortcuts,
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
  configure({ native, state, calls, saved });
  const shell = createDesktopShell({ host, native, configuration: saved, report: value => warnings.push(value),
    settingsFactory(handlers) {
      state.settingsHandlers = handlers;
      return { open(page) { calls.push(['settings-open', page]); return 123; },
        exited(event) { calls.push(['settings-exit', event.pid]); }, close() {},
        getState: () => ({ pid: 123, connected: true, error: '' }) };
    },
  }).start();
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
  return { shell, native, state, calls, created, surface, done, timers, saved, expectedWarnings, flushFrames };
}
function scenario(name, run, configure) {
  test(name, () => {
    const f = fixture(configure);
    try { run(f); } finally { f.done(); }
  });
}

scenario('Classic Programs uses current registered IDs and retains only live menu callbacks', f => {
  f.shell.selectTheme('server2003');
  const menu = f.shell.showApplications(1);
  const trigger = find(menu, 'shell-all-programs');
  trigger.focus(); key(menu, 'ArrowRight'); f.flushFrames();
  assert.equal(menu.document.activeElement, find(menu, 'shell-program-org.pollyui.settings'));
  assert.equal(menu.options.exclusiveZone, -1);
  assert.equal(menu.options.keyboard, 'exclusive');
  const item = find(menu, 'shell-program-fixture.desktop'), oldClick = callback(item, 'click');
  const oldPin = callback(find(menu, 'shell-program-pin-fixture.desktop'), 'click');
  const shortcutCalls = f.calls.filter(call => call[0] === 'shortcuts').length;
  key(menu, 'End');
  assert.equal(menu.document.activeElement, find(menu, 'shell-program-pin-fixture.desktop'));
  key(menu, 'Escape'); f.flushFrames();
  assert.equal(menu.closed, false);
  assert.equal(menu.document.activeElement, trigger);
  oldClick(event('click'));
  oldPin(event('click'));
  assert.equal(f.calls.filter(call => call[0] === 'launch').length, 0, 'closed Programs refuses stale handler');
  assert.equal(f.calls.filter(call => call[0] === 'shortcuts').length, shortcutCalls, 'closed Programs refuses stale Pin');
  key(menu, 'ArrowRight'); f.flushFrames();
  oldClick(event('click'));
  assert.equal(f.calls.filter(call => call[0] === 'launch').length, 0, 'reopened Programs refuses prior open epoch');
  click(find(menu, 'shell-program-fixture.desktop'));
  assert.equal(f.calls.filter(call => call[0] === 'launch').length, 1);
  assert.equal(menu.closed, true);
  oldClick(event('click'));
  assert.equal(f.calls.filter(call => call[0] === 'launch').length, 1, 'closed RootMenu refuses stale handler');
}, ({ state }) => { state.windows = []; });

scenario('Classic Programs rejects stale launch and Pin after live registry removal', f => {
  f.shell.selectTheme('server2003');
  const menu = f.shell.showApplications(1), refresh = callback(find(menu, 'shell-app-refresh'), 'click');
  find(menu, 'shell-all-programs').focus(); key(menu, 'ArrowRight'); f.flushFrames();
  const oldLaunch = callback(find(menu, 'shell-program-fixture.desktop'), 'click');
  const oldPin = callback(find(menu, 'shell-program-pin-fixture.desktop'), 'click');
  f.native.applicationFiles = () => [];
  refresh(event('click')); f.flushFrames();
  assert.equal(menu.document.getElementById('shell-program-fixture.desktop'), null);
  assert.ok(menu.document.getElementById('shell-program-menu'), 'live registry refresh keeps Programs open');
  oldLaunch(event('click')); oldPin(event('click'));
  assert.equal(f.calls.filter(call => call[0] === 'launch' || call[0] === 'shortcuts').length, 0);
  assert.equal(menu.closed, false);
}, ({ state }) => { state.windows = []; });

scenario('Non-Classic applications keeps the existing applications consumer', f => {
  f.shell.selectTheme('bigsur');
  const menu = f.shell.showApplications(1);
  const expected = applicationsView(getDesktopTheme('bigsur'), [], '', () => {}, () => {}, () => {}, () => {});
  assert.deepEqual(find(menu, 'shell-applications').style,
    Object.fromEntries(Object.entries(expected.props.style).map(([name, value]) => [name, String(value)])));
  assert.equal(menu.document.getElementById('shell-all-programs'), null);
}, ({ state }) => { state.windows = []; });

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
  native.sessionServices = () => ({ inputMethod: 'disabled', decorations: 'ready', decorationMessage: '' });
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

settingsScenario('taskbar, desktop and searchable application entry share the narrow independent launcher', f => {
  click(find(f.surface('panel'), 'shell-panel-settings'));
  click(find(f.surface('panel'), 'shell-panel-settings'));
  domEvent(f.surface('wallpaper').document.body, 'contextmenu', { button: 2 });
  const desktopMenu = f.created.findLast(window => window.document.getElementById('shell-desktop-settings'));
  click(find(desktopMenu, 'shell-desktop-settings'));
  const applications = f.shell.showApplications(2);
  domEvent(find(applications, 'shell-app-search'), 'textinput', { data: 'Settings' });
  click(find(applications, 'shell-app-org.pollyui.settings'));
  assert.equal(applications.closed, true);
  assert.deepEqual(f.calls.filter(call => call[0] === 'settings-open'),
    Array.from({ length: 4 }, () => ['settings-open', 'appearance']));
  assert.equal(f.created.some(window => window.options.title === 'Settings'), false,
    'Shell does not create the independent Settings document in its own realm');
});

settingsScenario('every former full-panel entry routes to the same owned Settings app', f => {
  for (const page of ['displays', 'network', 'audio', 'keyboard']) {
    assert.equal(f.shell.showManagedSettings(1, page), 123);
    assert.deepEqual(f.calls.at(-1), ['settings-open', page]);
  }
  assert.equal(f.shell.showDisplays(1), 123);
  assert.equal(f.shell.showShortcuts(1), 123);
  assert.equal(f.shell.showAudio(1), 123);
  assert.equal(f.created.some(window => window.options.title === 'Desktop control panel'), false);
  assert.equal(f.calls.some(call => call[0] === 'capture'), false);
});

settingsScenario('theme publication failures preserve the real committed state and never replay native rollback', f => {
  const appearances = [];
  f.native.configureAppearance = theme => appearances.push(theme.id);
  f.state.configurationFailure = new Error('fixture save denied');
  assert.equal(f.state.settingsHandlers.select('bigsur'), false);
  assert.deepEqual(appearances, ['bigsur', 'modern']);
  assert.equal(f.shell.getState().themeId, 'modern');
  assert.equal(f.saved.snapshot.theme.id, null);
  assert.match(f.state.settingsHandlers.appearance().error, /fixture save denied/);
  f.expectedWarnings.push('[shell] ' + f.shell.getState().error);

  appearances.length = 0;
  f.state.configurationFailure = Object.assign(new Error('fixture directory sync failed'), { committed: true });
  assert.equal(f.state.settingsHandlers.select('bigsur'), false);
  assert.deepEqual(appearances, ['bigsur'], 'a published choice must not revert the native appearance');
  assert.equal(f.shell.getState().themeId, 'bigsur');
  assert.equal(f.saved.snapshot.theme.id, 'bigsur');
  assert.match(f.state.settingsHandlers.appearance().error, /fixture directory sync failed/);
  f.expectedWarnings.push('[shell] ' + f.shell.getState().error);

  appearances.length = 0;
  assert.equal(f.state.settingsHandlers.restore(), false);
  assert.deepEqual(appearances, ['bigsur'], 'published restore must not roll back the new catalog/native theme');
  assert.equal(f.shell.getState().themeFilesEnabled, false);
  assert.deepEqual(f.saved.snapshot.theme, { id: 'bigsur', filesEnabled: false });
  assert.equal(f.state.settingsHandlers.appearance().themeFilesEnabled, false);
  assert.match(f.state.settingsHandlers.appearance().error, /fixture directory sync failed/);
  f.expectedWarnings.push('[shell] ' + f.shell.getState().error);
  f.state.configurationFailure = null;
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

scenario('launcher toggles remain scoped while Settings buttons delegate presentation without Shell documents', f => {
  const panel = f.surface('panel');
  click(find(panel, 'shell-menu'));
  const first = f.created.at(-1);
  assert.ok(find(first, 'shell-applications'));
  click(find(panel, 'shell-menu').firstChild);
  assert.equal(first.closed, true);
  assert.ok(f.created.at(-1) === first, 'same opener must not close on press then reopen on click');
  click(find(panel, 'shell-panel-settings'));
  assert.deepEqual(f.calls.at(-1), ['settings-open', 'appearance']);
  click(find(panel, 'shell-menu'));
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
    assert.equal(f.shell.showSystemSettings(1), 123);
  }
  assert.ok(f.calls.some(call => call[0] === 'settings-open' && call[1] === 'about'));
  assert.equal(f.created.some(window => window.options.title === 'Settings'), false);
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
  assert.match(find(menu, 'shell-app-search').lastChild.firstChild.textContent, /fix/);
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
  assert.equal(find(next, 'shell-app-search').lastChild.firstChild.textContent, 'Search applications');
  assert.equal(f.calls.some(call => call[0] === 'launch'), false);
  assert.ok(first.document.activeElement === null, 'replaced menu releases DOM focus');
  assert.equal(first.document.body.listeners.get('keydown').length, 0);
  const settings = f.shell.showSettings(1);
  const oldTheme = callback(find(settings, 'shell-theme-bigsur'), 'click');
  const oldChild = callback(find(settings, 'shell-keyboard-settings'), 'click');
  const shortcuts = f.shell.showShortcuts(1);
  oldTheme(event('click')); oldChild(event('click'));
  assert.equal(f.shell.getState().themeId, 'modern');
  assert.equal(shortcuts, 123);
});

scenario('current search launch and fixed Settings routes retain their actual launcher callbacks', f => {
  const applications = f.shell.showApplications(1);
  domEvent(find(applications, 'shell-app-search'), 'textinput', { data: 'Fixture' });
  key(applications, 'Enter');
  assert.equal(applications.closed, true);
  assert.deepEqual(f.calls.find(call => call[0] === 'launch'), ['launch', ['fixture'], '', 'fixture.desktop']);
  assert.equal(f.shell.showShortcuts(1), 123); assert.equal(f.shell.showDisplays(1), 123);
  assert.equal(f.calls.some(call => call[0] === 'capture'), false);
  assert.equal(f.calls.some(call => call[0] === 'apply-outputs'), false);
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
  assert.equal(first.closed, true);
  oldKey(event('keydown', { key: 'Escape' }));
  assert.deepEqual(f.calls.at(-1), ['settings-open', 'keyboard']);
  const settings = f.shell.showSettings(1);
  const staleClose = callback(find(settings, 'shell-settings-close'), 'click');
  click(find(settings, 'shell-power-settings-open'));
  const power = f.created.at(-1);
  assert.equal(settings.closed, true);
  click(find(power, 'shell-power-poweroff'));
  assert.equal(find(power, 'shell-power-poweroff').getAttribute('aria-disabled'), 'true',
    'this menu fixture has no application-close coordinator or versioned power backend');
  find(power, 'shell-power-poweroff').focus();
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

scenario('display entry cannot retain a Shell draft or apply callback after routing', f => {
  assert.equal(f.shell.showDisplays(1), 123);
  assert.deepEqual(f.calls.at(-1), ['settings-open', 'displays']);
  assert.equal(f.created.some(window => window.document.getElementById('shell-output-apply')), false);
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

scenario('stop/restart cleans Shell listeners and routes only through the new owned generation', f => {
  const first = f.shell.showApplications(1), oldKey = callback(first.document.body, 'keydown');
  const oldPanel = f.surface('panel'), oldPress = callback(oldPanel.document.body, 'mousedown');
  f.shell.stop(); assert.equal(f.timers.size, 0);
  assert.ok(f.created.every(window => window.closed));
  f.shell.start(); const next = f.shell.showApplications(1);
  oldKey(event('keydown', { key: 'Escape' })); oldPress(event('mousedown', { target: oldPanel.document.body }));
  assert.equal(next.closed, false);
  assert.equal(f.shell.showShortcuts(1), 123);
  assert.equal(f.calls.some(call => call[0] === 'capture'), false);
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

scenario('desktop application menu adds and removes only shortcuts, preserves Settings routing and all configuration domains', f => {
  const before = f.saved.snapshot;
  const menu = f.shell.showApplications(1);
  click(find(menu, 'shell-app-pin-fixture.desktop'));
  assert.equal(f.saved.snapshot.desktop.shortcuts.length, 1);
  assert.equal(f.shell.addDesktopShortcut(1, 'fixture.desktop'), true);
  assert.equal(f.saved.snapshot.desktop.shortcuts.length, 1);
  const background = f.surface('wallpaper');
  assert.equal(find(background, 'shell-desktop-icon-fixture.desktop').getAttribute('aria-label'), 'Fixture');
  f.shell.launchApplication('org.pollyui.settings', 1);
  assert.deepEqual(f.calls.filter(call => call[0] === 'settings-open'), [['settings-open', 'appearance']]);
  assert.equal(f.shell.removeDesktopShortcuts(['fixture.desktop']), true);
  assert.equal(f.saved.snapshot.desktop.shortcuts.length, 0);
  for (const key of ['theme', 'audio', 'display', 'workspace', 'shortcuts'])
    assert.deepEqual(f.saved.snapshot[key], before[key]);
  assert.equal(f.calls.some(call => call[0] === 'launch'), false);
});

scenario('desktop save failure does not pretend persistence; committed durability error preserves the published shortcut', f => {
  f.state.configurationFailure = new Error('fixture disk full');
  assert.equal(f.shell.addDesktopShortcut(1, 'fixture.desktop'), false);
  assert.equal(f.saved.snapshot.desktop.shortcuts.length, 0);
  f.expectedWarnings.push('[shell] Desktop shortcut change did not complete: Error: fixture disk full');
  f.state.configurationFailure = Object.assign(new Error('fixture durability'), { committed: true });
  assert.equal(f.shell.addDesktopShortcut(1, 'fixture.desktop'), false);
  assert.equal(f.saved.snapshot.desktop.shortcuts.length, 1);
  f.expectedWarnings.push('[shell] Desktop shortcuts published, but durability confirmation failed: Error: fixture durability');
  assert.ok(find(f.surface('wallpaper'), 'shell-desktop-status').childNodes.length);
  f.state.configurationFailure = null;
  assert.equal(f.shell.removeDesktopShortcuts(['fixture.desktop']), true);
});

scenario('desktop catalog rename/uninstall stays visible without stale launching; disconnected output pins are retained', f => {
  assert.equal(f.shell.addDesktopShortcut(1, 'fixture.desktop'), true);
  f.native.applicationFiles = () => [{ id: 'fixture.desktop', path: '/fixture.desktop',
    contents: '[Desktop Entry]\nType=Application\nName=Renamed fixture\nExec=fixture\n' }];
  f.shell.showApplications(1);
  assert.equal(find(f.surface('wallpaper'), 'shell-desktop-icon-fixture.desktop').getAttribute('aria-label'), 'Renamed fixture');
  f.native.applicationFiles = () => [];
  f.shell.showApplications(1); // Toggle the already-open menu only after catalog refresh.
  assert.equal(find(f.surface('wallpaper'), 'shell-desktop-icon-fixture.desktop').getAttribute('aria-label'), 'Fixture (unavailable)');
  assert.equal(f.shell.launchApplication('fixture.desktop'), null);
  f.expectedWarnings.push('[shell] Could not launch application: Error: Application is no longer available');
  assert.equal(f.calls.some(call => call[0] === 'launch'), false);
  f.state.outputs = [f.state.outputs[1]];
  f.shell.refresh(true);
  assert.equal(f.saved.snapshot.desktop.shortcuts.length, 1);
  assert.ok(find(f.surface('wallpaper', 2), 'shell-desktop-icon-fixture.desktop'));
});

scenario('moving a selected shortcut never rehomes unselected disconnected-display pins', f => {
  assert.equal(f.shell.addDesktopShortcut(1, 'fixture.desktop'), true);
  const first = f.saved.snapshot.desktop.shortcuts[0];
  const disconnected = { ...first, id: 'missing.desktop', name: 'Disconnected fixture',
    output: { ...first.output, name: 'DP-retired', serialNumber: 'old-display' } };
  f.saved.update({ desktop: { version: 1, shortcuts: [first, disconnected] } });
  f.shell.refresh(true);
  const surface = f.shell.getSurfaces().find(item => item.kind === 'wallpaper' && item.output === 1);
  const controller = surface.desktopController;
  controller.down('fixture.desktop', 0, 0); controller.move(0, 104); controller.up(0, 104);
  assert.equal(f.saved.snapshot.desktop.shortcuts[0].y, first.y + 104);
  assert.deepEqual(f.saved.snapshot.desktop.shortcuts.find(item => item.id === disconnected.id), disconnected);
});
