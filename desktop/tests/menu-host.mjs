import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

// Run: node --test .\desktop\tests\menu-host.mjs
register('./menu-host-loader.mjs', import.meta.url);
const { createDesktopShell } = await import('./desktop/shell/shell.mjs');
const { memoryConfiguration, fixtureShortcuts } = await import('./desktop/tests/configuration-memory.mjs');
const { defaultShellConfiguration } = await import('./desktop/shell/configuration.mjs');
const { getDesktopTheme, BUILTIN_THEME_CATALOG, installThemeCatalog } = await import('./desktop/shell/themes.mjs');
const { applicationsView } = await import('./desktop/shell/views.mjs');
const { windowGroupMenu } = await import('./desktop/shell/window-group-menu.mjs');
const { windowTasks } = await import('./desktop/shell/window-groups.mjs');
const { panelAppearance, panelDetail } = await import('./desktop/shared/ui/panel-appearance.mjs');
const { programCategories, categoryEntries, programCategoryId, programSourcePath,
  programFolderContents, programFolderId } = await import('./desktop/shell/programs-menu.mjs');
const { applicationCatalog } = await import('./desktop/shell/applications.mjs');
const { render } = await import('./gui/sdk/js/reconciler.mjs');
const { startMenuView } = await import('./desktop/shell/start-menu.mjs');
const { parseLocalUserProfile } = await import('./desktop/shared/user-profile.mjs');
const { layoutPickerPlacement } = await import('./desktop/shared/ui/theme-layout.mjs');
const { validateTheme } = await import('./desktop/shared/ui/theme-schema.mjs');

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
  cancelComposition() { domEvent(this, 'compositionend'); }
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
    backdropCapability: () => true,
    shellBackdropCapability: () => true,
    configureAppearance(theme, words, targets = []) {
      assert.equal(words[0], 7);
      const paired = !!theme.panel.taskbarBackdrop;
      const start = targets.filter(([, material]) => material[1] === 3);
      assert.equal(targets.length, theme.panel.kind === 'dock' && theme.panel.regionalBackdrop || paired ?
        state.outputs.length + start.length : 0);
      for (const [window, material, peer] of targets) {
        assert.equal(window.options.layer, material[1] === 3 ? 'overlay' : 'top');
        assert.equal(material[0], paired ? 3 : 2);
        if (paired) assert.ok(peer && !peer.closed);
      }
    },
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
      const window = { options, document: document(), closed: false, closeCount: 0, setCursor() {},
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
  configure({ native, state, calls, saved, expectedWarnings });
  const shell = createDesktopShell({ host, native, configuration: saved, displayProfile: state.displayProfile,
    report: value => warnings.push(value),
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
  return { shell, native, state, calls, created, surface, done, timers, saved, warnings, expectedWarnings, flushFrames };
}
function scenario(name, run, configure) {
  test(name, async () => {
    const f = fixture(configure);
    try { await run(f); } finally { f.done(); }
  });
}

scenario('paired Start publication stays solid on failure and retains taskbars on close without polling', f => {
  const optional = JSON.parse(JSON.stringify(BUILTIN_THEME_CATALOG));
  optional.themes.find(theme => theme.id === 'modern').panel.startBackdrop =
    { sigma: 12, tint: '#f3f3f3', opacityPercent: 72 };
  installThemeCatalog(optional);
  assert.equal(f.shell.selectTheme('modern'), true);
  const original = f.native.configureAppearance;
  const attempts = [];
  let reject = true;
  f.native.configureAppearance = (theme, words, targets) => {
    attempts.push(targets);
    if (reject) throw new Error('peak budget rejected');
    return original(theme, words, targets);
  };
  const panels = [f.surface('panel', 1), f.surface('panel', 2)];
  const solid = f.shell.showApplications(1);
  f.flushFrames();
  assert.equal(find(solid, 'shell-applications').style.backgroundColor, '#f3f3f3');
  assert.match(f.shell.getState().materialError, /solid retained/);
  assert.equal(f.shell.getState().error, '');
  f.expectedWarnings.push('[shell] ' + f.shell.getState().materialError);
  solid.close();
  reject = false;
  const menu = f.shell.showApplications(1);
  f.flushFrames();
  const targets = attempts.at(-1);
  assert.deepEqual(targets.slice(0, 2).map(([window, , peer]) => [window, peer]),
    panels.map(panel => [panel, panel]));
  assert.equal(targets.length, 3);
  assert.equal(targets[2][0], menu);
  assert.equal(targets[2][2], panels[0]);
  assert.deepEqual(targets[2][1], [3, 3, 8000, 12, 0xf3f3f3, 72]);
  assert.equal(find(menu, 'shell-applications').style.backgroundColor, 'transparent');
  menu.close();
  assert.equal(attempts.at(-1).length, 2);
  assert.ok(panels.every(panel => !panel.closed));
  const reopened = f.shell.showApplications(2);
  f.flushFrames();
  assert.notEqual(reopened, menu);
  assert.equal(attempts.at(-1)[2][2], panels[1]);
  installThemeCatalog(BUILTIN_THEME_CATALOG);
});

scenario('cumulative retirement repaints each target without repeating the same material diagnostic', f => {
  const optional = JSON.parse(JSON.stringify(BUILTIN_THEME_CATALOG));
  optional.themes.find(theme => theme.id === 'modern').panel.startBackdrop =
    { sigma: 12, tint: '#f3f3f3', opacityPercent: 72 };
  installThemeCatalog(optional);
  try {
    assert.equal(f.shell.selectTheme('modern'), true);
    const menu = f.shell.showApplications(1);
    f.flushFrames();
    const panels = [f.surface('panel', 1), f.surface('panel', 2)];
    const views = [...panels.map(panel => find(panel, 'shell-panel')), find(menu, 'shell-applications')];
    const owners = [...panels, menu];
    assert.deepEqual(views.map(view => view.style.backgroundColor), ['transparent', 'transparent', 'transparent']);
    const callback = f.native.onBackdropStatusChanged, calls = f.calls.length, created = f.created.length;
    const preferences = JSON.parse(JSON.stringify(f.saved.snapshot));
    const focus = menu.document.activeElement;
    const message = 'Shell taskbar backdrop retired; solid material required';
    f.state.materialMessage = message;
    f.expectedWarnings.push('[shell] ' + message);
    for (const [mask, colors] of [
      [1, ['#f3f3f3', 'transparent', 'transparent']],
      [3, ['#f3f3f3', '#f3f3f3', 'transparent']],
      [7, ['#f3f3f3', '#f3f3f3', '#f3f3f3']],
    ]) {
      f.state.retiredMask = mask;
      callback();
      assert.deepEqual(views.map(view => view.style.backgroundColor), colors,
        'newly retired ordinal immediately repaints despite the unchanged diagnostic: mask ' + mask);
      const rendered = owners.map(owner => owner.document.body.__vnode);
      callback();
      assert.ok(owners.every((owner, index) => owner.document.body.__vnode === rendered[index]),
        'an identical retirement notification does not repaint again');
      assert.deepEqual(f.warnings, f.expectedWarnings, 'same message is reported only once');
      assert.deepEqual(f.calls.slice(calls), [['previous-backdrop']],
        'recipient-only changes preserve the previous callback message-change contract and admit no actions');
      assert.equal(f.created.length, created);
      assert.equal(menu.closed, false);
      assert.equal(menu.document.activeElement, focus);
      assert.deepEqual(f.saved.snapshot, preferences);
    }
  } finally { installThemeCatalog(BUILTIN_THEME_CATALOG); }
}, ({ native, state, calls }) => {
  const publish = native.configureAppearance;
  native.configureAppearance = (...args) => { calls.push(['appearance']); return publish(...args); };
  state.materialMessage = '';
  state.retiredMask = 0;
  native.backdropError = () => state.materialMessage;
  native.shellBackdropRetired = () => state.retiredMask;
  native.onBackdropStatusChanged = () => calls.push(['previous-backdrop']);
});

function placementFixture({ native, state, calls }) {
  Object.assign(state.windows[0], { placement: 'floating', placementPending: false,
    placementCapabilities: 3, placementMessage: '' });
  native.openWindowMenu = (id, menu) => { calls.push(['open-window-menu', id, menu]); return 41; };
  native.closeWindowMenu = epoch => calls.push(['close-window-menu', epoch]);
  native.tileWindow = (id, side, epoch) => { calls.push(['place', id, side, epoch]); return { admitted: true }; };
  native.restoreFloatingWindow = (id, epoch) => { calls.push(['place', id, 'floating', epoch]); return { admitted: true }; };
}

function pickerFixture(options) {
  placementFixture(options);
  const { native, state, calls } = options;
  native.layoutPickerCapability = () => state.pickerSupported !== false;
  native.enableLayoutPicker = enabled => { calls.push(['picker-enabled', enabled]); state.offer = null; };
  native.layoutPickerOffer = () => state.offer;
  native.openLayoutPicker = (token, menu) => { calls.push(['picker-open', token, menu]); return 42; };
  native.dismissLayoutPicker = token => { calls.push(['picker-dismiss', token]); if (state.offer?.token === token) state.offer = null; };
  state.previousPickerObserver = () => {
    calls.push(['previous-picker']);
    if (state.previousPickerThrows) throw new Error('fixture picker observer failure');
  };
  native.onLayoutPickerChanged = state.previousPickerObserver;
}
function offerPicker(f, token = 1, extra = {}) {
  f.state.offer = { token, windowId: 10, x: 1200, y: 0, width: 46, height: 33,
    outputX: 0, outputY: 0, outputWidth: 1280, outputHeight: 720, outputName: 'HEADLESS-1', ...extra };
  f.native.onLayoutPickerChanged();
  return f.created.findLast(window => !window.closed && window.document.getElementById('shell-layout-picker'));
}
scenario('caption picker uses explicit theme opt-in and a native grant, admits once and retires held callbacks', f => {
  assert.equal(f.shell.selectTheme('xp'), true);
  assert.deepEqual(f.calls.filter(call => call[0] === 'picker-enabled').at(-1), ['picker-enabled', false]);
  assert.equal(f.shell.selectTheme('modern'), true);
  const menu = offerPicker(f);
  assert.ok(menu);
  const registered = f.calls.length;
  f.shell.refresh(true);
  f.shell.refresh();
  f.native.onWindowsChanged();
  assert.equal(menu.closed, false, 'ordinary refresh cannot retire the active picker');
  assert.equal(f.calls.slice(registered).some(call => call[0] === 'picker-enabled'), false);
  assert.deepEqual(menu.options.anchors, ['top', 'left']);
  assert.deepEqual(menu.options.margins, { left: 966, top: 33 });
  assert.equal(menu.document.getElementById('shell-window-maximize'), null);
  const left = find(menu, 'shell-window-tile-left'), held = callback(left, 'click');
  click(left);
  held(event('click', { currentTarget: left }));
  assert.deepEqual(f.calls.filter(call => call[0] === 'place'), [['place', 10, 'left', 42]]);
  assert.equal(menu.closed, true);
  assert.ok(f.calls.some(call => call[0] === 'picker-dismiss' && call[1] === 1));
  assert.equal(f.calls.some(call => call[0] === 'activate'), false);
}, pickerFixture);

scenario('caption picker old-provider capability hides entry without issuing v4 requests', f => {
  f.shell.selectTheme('modern');
  assert.equal(f.calls.some(call => call[0] === 'picker-enabled'), false);
  assert.equal(offerPicker(f), undefined);
  const menu = f.shell.showWindowActions(1, 10);
  click(find(menu, 'shell-window-tile-left'));
  assert.deepEqual(f.calls.filter(call => call[0] === 'place'), [['place', 10, 'left', 41]]);
}, options => { pickerFixture(options); options.state.pickerSupported = false; });

scenario('caption picker revocation, replacement, Escape, disabled Restore and retheme preserve scopes', f => {
  f.shell.selectTheme('modern');
  let menu = offerPicker(f);
  const held = callback(find(menu, 'shell-window-tile-left'), 'click');
  assert.equal(find(menu, 'shell-window-restore-floating').tabIndex, -1);
  key(menu, 'Tab');
  assert.equal(menu.document.activeElement.id, 'shell-window-tile-left');
  key(menu, 'Tab', { shiftKey: true });
  key(menu, 'Escape');
  assert.equal(menu.closed, true);
  menu = offerPicker(f, 2);
  held(event('click'));
  assert.equal(menu.closed, false);
  f.state.offer = null; f.native.onLayoutPickerChanged();
  assert.equal(menu.closed, true);
  menu = offerPicker(f, 3);
  f.shell.selectTheme('xp');
  assert.equal(menu.closed, true);
  assert.ok(!f.calls.some(call => call[0] === 'place'));
  f.native.onLayoutPickerChanged();
  assert.ok(f.created.every(window => window.closed || !window.document.getElementById('shell-layout-picker')));
}, pickerFixture);

scenario('caption picker failed or unknown admission is visible, closes and never retries', f => {
  f.shell.selectTheme('modern');
  const menu = offerPicker(f);
  f.native.tileWindow = () => { f.calls.push(['unknown']); throw new Error('Transport outcome is unknown'); };
  const left = find(menu, 'shell-window-tile-left'), held = callback(left, 'click');
  click(left); held(event('click', { currentTarget: left }));
  assert.equal(menu.closed, true);
  assert.equal(f.calls.filter(call => call[0] === 'unknown').length, 1);
  assert.match(f.shell.getState().error, /Transport outcome is unknown/);
  f.expectedWarnings.push('[shell] ' + f.shell.getState().error);
}, pickerFixture);

scenario('caption picker retained callbacks from a stopped owner cannot process a restarted Shell offer', f => {
  const retired = f.native.onLayoutPickerChanged;
  f.shell.stop();
  f.shell.start();
  f.shell.selectTheme('modern');
  f.state.offer = { token: 42, windowId: 10, x: 1200, y: 0, width: 46, height: 33,
    outputX: 0, outputY: 0, outputWidth: 1280, outputHeight: 720, outputName: 'HEADLESS-1' };
  const count = f.calls.length;
  retired();
  assert.equal(f.calls.length, count);
  assert.ok(!f.created.some(window => !window.closed && window.document.getElementById('shell-layout-picker')));
  f.native.onLayoutPickerChanged();
  assert.ok(f.created.some(window => !window.closed && window.document.getElementById('shell-layout-picker')));
}, pickerFixture);

scenario('caption picker chains current prior observers for null, open and disabled notifications without consuming business errors', f => {
  f.state.offer = null; f.native.onLayoutPickerChanged();
  assert.equal(f.calls.filter(call => call[0] === 'previous-picker').length, 1);
  f.shell.selectTheme('modern');
  const menu = offerPicker(f);
  f.native.onLayoutPickerChanged();
  assert.equal(f.calls.filter(call => call[0] === 'previous-picker').length, 3);
  const error = f.shell.getState().error;
  f.state.previousPickerThrows = true;
  f.native.onLayoutPickerChanged();
  f.expectedWarnings.push('[shell] Previous caption picker observer failed: Error: fixture picker observer failure');
  assert.equal(menu.closed, false);
  assert.equal(f.shell.getState().error, error);
  f.state.previousPickerThrows = false;
  f.shell.selectTheme('xp');
  f.native.onLayoutPickerChanged();
  assert.equal(f.calls.filter(call => call[0] === 'previous-picker').length, 5);
  f.shell.stop();
  assert.equal(f.native.onLayoutPickerChanged, f.state.previousPickerObserver);
}, pickerFixture);

test('caption picker projection clamps output-local logical anchors including negative origins and tiny outputs', () => {
  const theme = getDesktopTheme('modern');
  for (const [width, height, x, y] of [[1280, 720, 1260, 0], [200, 140, 190, 130], [1, 1, -8, -8]]) {
    const result = layoutPickerPlacement(theme, { x, y, width: 46, height: 33,
      outputX: -2000, outputY: -400, outputWidth: width, outputHeight: height });
    assert.ok(result.width <= width && result.height <= height);
    assert.ok(result.margins.left >= 0 && result.margins.left + result.width <= width);
    assert.ok(result.margins.top >= 0 && result.margins.top + result.height <= height);
  }
  const legacy = JSON.parse(JSON.stringify(theme));
  delete legacy.window.layoutPicker;
  assert.doesNotThrow(() => validateTheme(legacy));
  for (const value of [0, 1, 'true', null]) {
    const invalid = JSON.parse(JSON.stringify(legacy));
    invalid.window.layoutPicker = value;
    assert.throws(() => validateTheme(invalid));
  }
});

scenario('window placement commands use an acknowledged live menu and never activate before admission', f => {
  const configuration = JSON.stringify(f.saved.snapshot);
  const menu = f.shell.showWindowActions(1, 10);
  for (const id of ['tile-left', 'tile-right', 'restore-floating'])
    assert.ok(menu.document.getElementById('shell-window-' + id), id);
  click(find(menu, 'shell-window-tile-left'));
  assert.deepEqual(f.calls.filter(call => ['place', 'activate'].includes(call[0])), [['place', 10, 'left', 41]]);
  assert.equal(menu.closed, true);
  assert.equal(JSON.stringify(f.saved.snapshot), configuration);
}, placementFixture);

scenario('window placement capability is actual provider state, not function presence', f => {
  const menu = f.shell.showWindowActions(1, 10);
  assert.equal(menu.document.getElementById('shell-window-tile-left'), null);
  assert.equal(f.calls.some(call => call[0] === 'open-window-menu'), false);
  click(find(menu, 'shell-window-close'));
  assert.deepEqual(f.calls.filter(call => call[0] === 'close-window'), [['close-window', 10]]);
}, options => {
  placementFixture(options);
  for (const key of ['placement', 'placementPending', 'placementCapabilities', 'placementMessage'])
    delete options.state.windows[0][key];
});

scenario('denied or transport-unknown placement retains the menu and reports no rollback', f => {
  for (const failure of [new Error('Input is grabbed'), null]) {
    const menu = f.shell.showWindowActions(1, 10);
    f.native.tileWindow = () => { if (failure) throw failure; };
    click(find(menu, 'shell-window-tile-left'));
    assert.equal(menu.closed, false);
    assert.equal(f.calls.some(call => call[0] === 'activate'), false);
    assert.match(f.shell.getState().error, failure ? /Input is grabbed/ : /outcome is unknown/);
    f.expectedWarnings.push('[shell] ' + f.shell.getState().error);
    key(menu, 'Escape');
  }
}, placementFixture);

scenario('window placement rechecks workspace and retired callbacks do not admit requests', f => {
  const menu = f.shell.showWindowActions(1, 10);
  const node = find(menu, 'shell-window-tile-left'), retired = callback(node, 'click');
  f.state.workspaces[0].active = false; f.state.workspaces[1].active = true;
  click(node);
  assert.match(f.shell.getState().error, /workspace is no longer current/);
  f.expectedWarnings.push('[shell] ' + f.shell.getState().error);
  assert.equal(menu.closed, false);
  key(menu, 'Escape');
  f.state.workspaces[0].active = true; f.state.workspaces[1].active = false;
  f.native.onWindowsChanged();
  const replacement = f.shell.showWindowActions(1, 10);
  retired(event('click', { currentTarget: node }));
  assert.equal(replacement.closed, false);
  assert.equal(f.calls.some(call => call[0] === 'place'), false);
}, placementFixture);

scenario('held window rows retain identity when capability arrives, state changes, or the menu rethemes', f => {
  const menu = f.shell.showWindowActions(1, 10);
  const close = find(menu, 'shell-window-close');
  press(close);
  Object.assign(f.state.windows[0], { placement: 'floating', placementPending: false, placementCapabilities: 3 });
  f.native.onWindowsChanged();
  assert.equal(find(menu, 'shell-window-close'), close);
  domEvent(close, 'click');
  assert.deepEqual(f.calls.filter(call => call[0] === 'close-window'), [['close-window', 10]]);
  const next = f.shell.showWindowActions(1, 10), left = find(next, 'shell-window-tile-left');
  press(left);
  f.state.windows[0].placementPending = true;
  f.native.onWindowsChanged();
  assert.equal(find(next, 'shell-window-tile-left'), left);
  domEvent(left, 'click');
  assert.equal(f.calls.some(call => call[0] === 'place'), false);
  assert.equal(next.closed, false);
  f.state.windows[0].placementPending = false;
  f.native.onWindowsChanged();
  press(left);
  f.shell.selectTheme('xp');
  domEvent(left, 'click');
  assert.equal(f.calls.filter(call => call[0] === 'place').length, 0);
  assert.equal(next.closed, true, 'existing theme changes retire rather than repurpose a held menu');
  const replacement = f.shell.showWindowActions(1, 10);
  find(replacement, 'shell-window-tile-left').focus(); key(replacement, 'Enter');
  assert.equal(f.calls.filter(call => call[0] === 'place').length, 1);
}, options => {
  placementFixture(options);
  delete options.state.windows[0].placement;
});

scenario('fullscreen and pending layout disable placement while preserving old commands and Close menu', f => {
  f.state.windows[0].fullscreen = true;
  f.native.onWindowsChanged();
  const menu = f.shell.showWindowActions(1, 10);
  for (const id of ['tile-left', 'tile-right', 'restore-floating']) {
    const node = find(menu, 'shell-window-' + id);
    assert.equal(node.getAttribute('aria-disabled'), 'true');
    assert.equal(node.tabIndex, -1);
    click(node); node.focus(); key(menu, 'Enter');
  }
  assert.equal(f.calls.some(call => call[0] === 'place'), false);
  assert.equal(menu.closed, false);
  find(menu, 'shell-window-menu-close').focus(); key(menu, 'Enter');
  assert.equal(menu.closed, true);
}, placementFixture);

test('Start display profile: real metadata or explicit unavailable labels do not replace brand defaults, search or menu authority', async () => {
  const name = '\u7231\u4e3d\u4e1d \ud83d\udc30 ' + '\u957f\u540d'.repeat(20);
  const available = parseLocalUserProfile('alice:x:1000:1000:' + name + ',Unused:/not-returned:/not-returned\n', 1000);
  for (const displayProfile of [undefined, available, parseLocalUserProfile('', 1000), parseLocalUserProfile('', undefined)]) {
    const f = fixture(context => {
      sourcePrograms(context);
      context.state.displayProfile = displayProfile;
      if (displayProfile?.error)
        context.expectedWarnings.push('[shell] Local display profile unavailable: ' + displayProfile.error);
    });
    try {
      for (const theme of ['xp', 'server2003']) {
        f.shell.selectTheme(theme);
        const menu = f.shell.showApplications(1), header = find(menu, 'shell-start-profile');
        const search = find(menu, 'shell-app-search');
        const expectedName = !displayProfile ? 'PollyDesktop' : !displayProfile.error ? name :
          displayProfile.uid === null ? 'User unavailable' : 'User ' + displayProfile.uid;
        if (displayProfile) {
          assert.equal(find(menu, 'shell-start-user-name').getAttribute('aria-label'), expectedName);
          assert.equal(text(find(menu, 'shell-start-user-detail')).trim(), displayProfile.error ?
            'Local name unavailable' : 'alice | UID 1000');
          assert.equal(find(menu, 'shell-start-user').tabIndex, -1, 'profile is not an account management command');
        } else {
          assert.equal(text(header).trim(), expectedName, 'legacy Shell caller retains original brand');
          assert.equal(menu.document.getElementById('shell-start-user'), null);
        }
        search.focus(); domEvent(search, 'textinput', { data: 'Editor' });
        assert.ok(find(menu, 'shell-app-a-b-editor.desktop'));
        click(find(menu, 'shell-app-pin-a-b-editor.desktop'));
        assert.deepEqual(f.saved.snapshot.desktop.shortcuts.map(item => item.id), ['a-b-editor.desktop']);
        if (theme === 'xp') {
          click(find(menu, 'shell-app-launcher-a-b-editor.desktop'));
          assert.deepEqual(f.saved.snapshot.launchers.applications, ['a-b-editor.desktop']);
        }
        for (const timer of [...f.timers]) timer();
        assert.ok(find(menu, 'shell-start-profile') === header && find(menu, 'shell-app-search') === search,
          'clock and pin repaint retain the original header and root input');
        search.focus(); key(menu, 'a', { ctrlKey: true }); key(menu, 'Backspace');
        find(menu, 'shell-all-programs').focus(); key(menu, 'ArrowRight'); f.flushFrames();
        click(find(menu, 'shell-program-categories')); f.flushFrames();
        click(find(menu, 'shell-program-source-folders')); f.flushFrames();
        click(find(menu, programFolderId('a'))); f.flushFrames();
        const launches = f.calls.filter(call => call[0] === 'launch').length;
        click(find(menu, 'shell-program-a-b-editor.desktop'));
        assert.equal(f.calls.filter(call => call[0] === 'launch').length, launches + 1);
        assert.equal(menu.closed, true, 'original launch policy closes only the live menu');
        assert.equal(f.shell.getState().error, '', 'display diagnostics do not overwrite service/action status');
        f.saved.update({ desktop: { version: 1, shortcuts: [] }, launchers: { version: 1, applications: [] } });
      }
      const menu = f.shell.showApplications(1), reader = f.native.applicationFiles;
      f.native.applicationFiles = () => { throw new Error('fixture independent catalog failure'); };
      click(find(menu, 'shell-app-refresh'));
      assert.match(f.shell.getState().error, /independent catalog failure/);
      f.expectedWarnings.push('[shell] ' + f.shell.getState().error);
      f.native.applicationFiles = reader;
      click(find(menu, 'shell-app-refresh'));
      assert.equal(f.warnings.filter(value => value.startsWith('[shell] Local display profile unavailable:')).length,
        displayProfile?.error ? 1 : 0, 'open/clock/retheme never repeats profile diagnostics');
      await Promise.resolve();
    } finally { f.done(); }
  }
  const theme = getDesktopTheme('xp'), noop = () => {};
  const tree = startMenuView({ ...theme, layout: { ...theme.layout, menuHeaderHeight: 0 } },
    [], '', noop, noop, noop, noop, '', null, null, null, null, null, null, available);
  const flatten = node => [node, ...(node.children ?? []).flatMap(flatten)];
  assert.equal(flatten(tree).some(node => node.props?.id === 'shell-start-profile'), false,
    'explicit header-height zero does not manufacture a profile area');
});

test('menu-bar alpha uses existing transparent surface creation and retires replaced callbacks', () => {
  const f = fixture(({ native, state }) => {
    state.menuBarPercent = undefined;
    native.readThemeFiles = () => ({ files: [], overrides: JSON.stringify({ schemaVersion: 1,
      themes: { modern: { panel: { menuBarOpacityPercent: 0 } },
        bigsur: { panel: state.menuBarPercent === undefined ? {} :
          { menuBarOpacityPercent: state.menuBarPercent } } } }) });
  });
  try {
    const select = id => { assert.equal(f.state.settingsHandlers.select(id), true); return f.surface('panel'); };
    assert.equal(f.surface('panel').options.transparent, true,
      'Modern regional material, not unrelated menu-bar opacity, opts this taskbar into an alpha buffer');
    for (const id of ['aqua', 'lion']) {
      assert.equal(select(id).options.transparent, undefined, 'Unchanged menu bar does not add a surface option');
      assert.equal(f.surface('dock').options.transparent, true, 'Existing transparent Dock is unchanged');
    }
    const alpha = select('bigsur'), oldBody = callback(alpha.document.body, 'mousedown');
    const oldMenu = callback(find(alpha, 'shell-menu'), 'click');
    const oldSettings = callback(find(alpha, 'shell-panel-settings'), 'click');
    assert.equal(alpha.options.transparent, true);
    assert.equal(alpha.options.height, 24);
    assert.deepEqual(alpha.options.anchors, ['top', 'left', 'right']);
    assert.equal(alpha.options.exclusiveZone, 24);
    f.state.menuBarPercent = 100;
    assert.equal(f.state.settingsHandlers.reload(), true);
    const solid = f.surface('panel');
    assert.equal(alpha.closed, true);
    const { transparent, ...alphaOptions } = alpha.options;
    assert.equal(transparent, true);
    assert.deepEqual(solid.options, alphaOptions, 'Solid restores the same spec without the transparent option');
    const count = f.created.length;
    const calls = f.calls.length;
    assert.equal(oldMenu(event('click')), false, 'Retired child menu opener cannot acquire a new surface');
    assert.equal(oldSettings(event('click')), false);
    oldBody(event('mousedown', { target: alpha.document.body }));
    assert.equal(alpha.document.body.listeners.get('mousedown').length, 0);
    assert.equal(f.created.length, count, 'Retired body handler gains no authority');
    assert.equal(f.calls.length, calls);
    click(find(solid, 'shell-menu'));
    assert.equal(f.created.length, count + 1, 'Live opener still creates one menu');
    key(f.created.at(-1), 'Escape');
    f.state.menuBarPercent = 0;
    assert.equal(f.state.settingsHandlers.reload(), true);
    assert.equal(solid.closed, true);
    const clear = f.surface('panel');
    assert.equal(clear.options.transparent, true);
    assert.deepEqual(clear.options, alpha.options);
    assert.equal(f.calls.some(call => ['launch', 'capture', 'apply-outputs'].includes(call[0])), false);
  } finally {
    f.done();
    installThemeCatalog(BUILTIN_THEME_CATALOG);
  }
});

function groupedWindows({ state, native, calls }) {
  state.windows = [
    { id: 10, appId: 'fixture.desktop', title: 'First document', active: true, minimized: false, workspaceId: 7 },
    { id: 11, appId: 'fixture.desktop', title: 'Second document', minimized: true, workspaceId: 7 },
    { id: 12, appId: 'other.application', title: 'Other application', workspaceId: 7 },
    { id: 13, appId: '', title: 'Unknown one', workspaceId: 7 },
    { id: 14, title: 'Unknown two', workspaceId: 7 },
    { id: 15, appId: 'fixture.desktop', title: 'Other workspace', workspaceId: 9 },
  ];
  native.restoreWindow = id => calls.push(['restore', id]);
}
const groupId = 'shell-window-app-fixture.desktop';
const latestGroup = f => f.created.findLast(window => !window.closed && window.document.getElementById('shell-window-group'));

scenario('Menu scrollbar: shared overlay follows wheel/focus, retains capture on retheme and stops on leave', f => {
  const owner = f.surface('wallpaper').document, container = owner.createElement('view');
  owner.body.appendChild(container);
  const group = windowTasks(Array.from({ length: 8 }, (_, i) => ({
    id: i + 1, appId: 'fixture.desktop', title: 'Window ' + (i + 1), workspaceId: 7,
  })), 'applications')[0], state = { slots: [], action() {}, close() {} };
  const paint = theme => render(windowGroupMenu(theme, group, state), container);
  paint(getDesktopTheme('modern'));
  const root = owner.getElementById('shell-window-group'), list = owner.getElementById('shell-group-list');
  const track = owner.getElementById('shell-group-list-scrollbar');
  const thumb = owner.getElementById('shell-group-list-scroll-thumb');
  list.offsetTop = 0; list.offsetHeight = 100;
  track.offsetTop = 0; track.offsetWidth = 10; track.offsetHeight = 100;
  list.childNodes.forEach((node, i) => { node.offsetTop = i * 60; node.offsetHeight = i < 8 ? 56 : 0; });
  for (const node of descendants(list).filter(node => node.tabIndex >= 0)) {
    node.offsetTop = node.parentNode.offsetTop; node.offsetHeight = 24;
  }
  f.flushFrames();
  assert.equal(track.tabIndex, 0);
  track.focus();
  const composingEnd = domEvent(track, 'keydown', { key: 'End', isComposing: true });
  assert.equal(composingEnd.defaultPrevented, false);
  assert.ok(owner.activeElement === track, 'Menu navigation must not reinterpret a composing scrollbar key');
  domEvent(list, 'wheel', { deltaY: 100000 });
  assert.equal(Number(track.getAttribute('aria-valuenow')), Number(list.scrollTop));
  assert.ok(Number(thumb.style.top) > 0);
  const last = owner.getElementById('shell-group-activate-8');
  last.offsetTop = 420; last.focus(); f.flushFrames();
  assert.equal(Number(track.getAttribute('aria-valuenow')), Number(list.scrollTop));
  domEvent(list, 'wheel', { deltaY: -100000 });
  paint(getDesktopTheme('modern')); f.flushFrames();
  assert.equal(Number(list.scrollTop), 0, 'unchanged focused content does not undo manual wheel scrolling');
  const down = { button: 0, clientX: 5, clientY: Number(thumb.style.top) + 3 };
  domEvent(track, 'mousedown', down);
  assert.ok(owner.captured === track);
  paint(getDesktopTheme('aqua')); f.flushFrames();
  assert.ok(owner.getElementById('shell-group-list-scrollbar') === track);
  assert.ok(owner.getElementById('shell-group-list-scroll-thumb') === thumb);
  assert.ok(owner.captured === track, 'same controller keeps the original drag across appearance changes');
  domEvent(track, 'mousemove', { clientX: 5, clientY: 65 });
  assert.ok(Number(list.scrollTop) > 0);
  render(null, container);
  assert.equal(owner.captured, null);
  assert.equal([...track.listeners.values()].flat().length, 0, 'stopping the overlay removes all input listeners');
  const scroll = Number(list.scrollTop);
  domEvent(track, 'mousemove', { clientX: 5, clientY: 99 });
  f.flushFrames();
  assert.equal(Number(list.scrollTop), scroll, 'retired drag cannot change the detached list');
  assert.ok(!root.parentNode);
});

const pinnedNodeId = id => 'shell-window-pin-' + encodeURIComponent(id);
function pinnedFixture(f) {
  groupedWindows(f);
  f.saved.update({ launchers: { version: 1, applications: ['fixture.desktop', 'missing.desktop'] } });
}

scenario('Launcher pins: Apps pin control persists independently and leaves real search and desktop shortcuts untouched', f => {
  f.shell.addDesktopShortcut(1, 'fixture.desktop');
  const before = f.saved.snapshot.desktop;
  assert.equal(before.shortcuts.length, 1);
  const menu = f.shell.showApplications(1), search = find(menu, 'shell-app-search');
  search.focus();
  const pin = find(menu, 'shell-app-launcher-fixture.desktop');
  assert.equal(pin.getAttribute('aria-label'), 'Pin Fixture to taskbar');
  click(pin);
  assert.deepEqual(f.saved.snapshot.launchers.applications, ['fixture.desktop']);
  assert.deepEqual(f.saved.snapshot.desktop, before);
  assert.equal(find(menu, 'shell-app-search'), search);
  assert.equal(menu.closed, false);
  assert.ok(find(f.surface('panel'), pinnedNodeId('fixture.desktop')));
  assert.equal(f.surface('panel').document.getElementById(groupId), null, 'running group is not duplicated');
  assert.ok(find(menu, 'shell-app-pin-fixture.desktop'), 'existing desktop pin remains independent');
  click(find(menu, 'shell-app-launcher-fixture.desktop'));
  assert.deepEqual(f.saved.snapshot.launchers.applications, []);
  assert.deepEqual(f.saved.snapshot.desktop, before);
  f.shell.selectTheme('server2003');
  const legacy = f.shell.showApplications(1);
  assert.equal(legacy.document.getElementById('shell-app-launcher-fixture.desktop'), null);
}, groupedWindows);

scenario('XP Quick Launch: pinned running apps launch independently while real Window.id tasks keep activate/minimize', f => {
  f.shell.selectTheme('xp');
  const panel = f.surface('panel');
  assert.ok(find(panel, pinnedNodeId('fixture.desktop')));
  assert.ok(find(panel, 'shell-window-10'));
  assert.ok(find(panel, 'shell-window-11'));
  assert.ok(find(panel, 'shell-window-13'));
  assert.equal(find(panel, 'shell-window-list').childNodes.length, 7, 'two launchers plus five original windows, no grouping');
  assert.match(find(panel, pinnedNodeId('fixture.desktop')).getAttribute('aria-label'), /pinned launcher/);
  assert.doesNotMatch(find(panel, pinnedNodeId('fixture.desktop')).getAttribute('aria-label'), /not running/);
  click(find(panel, pinnedNodeId('fixture.desktop')));
  assert.equal(f.calls.filter(call => call[0] === 'launch').length, 1, 'a running app does not turn Quick Launch into activate');
  assert.equal(f.calls.some(call => ['activate', 'minimize'].includes(call[0])), false);
  click(find(panel, 'shell-window-10'));
  assert.deepEqual(f.calls.at(-1), ['minimize', 10]);
  click(find(panel, 'shell-window-11'));
  assert.deepEqual(f.calls.at(-1), ['activate', 11]);
  const old = callback(find(panel, pinnedNodeId('fixture.desktop')), 'click');
  f.shell.selectTheme('modern');
  assert.equal(old(event('click')), false, 'retired XP mode callback cannot run under application grouping');
  assert.equal(f.calls.filter(call => call[0] === 'launch').length, 1);
}, pinnedFixture);

scenario('XP Quick Launch: Apps controls use the same persistent pins and manage missing entries through the existing menu', f => {
  f.shell.selectTheme('xp');
  const desktop = f.saved.snapshot.desktop;
  const apps = f.shell.showApplications(1);
  assert.match(find(apps, 'shell-app-launcher-fixture.desktop').getAttribute('aria-label'), /Quick Launch/);
  click(find(apps, 'shell-app-launcher-fixture.desktop'));
  assert.deepEqual(f.saved.snapshot.launchers.applications, ['fixture.desktop']);
  assert.deepEqual(f.saved.snapshot.desktop, desktop);
  const panel = f.surface('panel'), pin = find(panel, pinnedNodeId('fixture.desktop'));
  pin.focus(); key(panel, 'Enter', { repeat: true }); key(panel, 'Enter', { isComposing: true });
  assert.equal(f.calls.some(call => call[0] === 'launch'), false);
  key(panel, 'Enter');
  assert.equal(f.calls.filter(call => call[0] === 'launch').length, 1);
  f.saved.update({ launchers: { version: 1, applications: ['fixture.desktop', 'missing.desktop'] } });
  f.native.onWindowsChanged();
  const missing = find(f.surface('panel'), pinnedNodeId('missing.desktop'));
  assert.equal(missing.tabIndex, 0);
  missing.focus(); key(f.surface('panel'), 'F10', { shiftKey: true });
  const menu = latestGroup(f);
  assert.match(text(find(menu, 'shell-window-group')), /no longer in the catalog/);
  assert.match(find(menu, 'shell-group-pin').getAttribute('aria-label'), /Unpin from Quick Launch/);
  click(find(menu, 'shell-group-pin-earlier'));
  assert.deepEqual(f.saved.snapshot.launchers.applications, ['missing.desktop', 'fixture.desktop']);
  click(find(menu, 'shell-group-pin'));
  assert.deepEqual(f.saved.snapshot.launchers.applications, ['fixture.desktop']);
  f.shell.stop(); f.shell.start();
  assert.ok(find(f.surface('panel'), pinnedNodeId('fixture.desktop')), 'XP reopens the same saved launcher');
  f.shell.selectTheme('server2003');
  assert.equal(f.surface('panel').document.getElementById(pinnedNodeId('fixture.desktop')), null,
    'Classic windows mode does not grow a launcher strip');
  assert.deepEqual(f.saved.snapshot.launchers.applications, ['fixture.desktop']);
  assert.deepEqual(f.saved.snapshot.desktop, desktop);
}, groupedWindows);

scenario('XP Quick Launch: fresh catalog failure and unavailable entries cannot execute a stored launcher command', f => {
  f.shell.selectTheme('xp');
  f.native.applicationFiles = () => [];
  click(find(f.surface('panel'), pinnedNodeId('fixture.desktop')));
  assert.equal(f.calls.some(call => call[0] === 'launch'), false);
  assert.match(f.shell.getState().error, /no longer available/);
  f.expectedWarnings.push('[shell] ' + f.shell.getState().error);
  f.shell.showApplications(1);
  const missing = find(f.surface('panel'), pinnedNodeId('fixture.desktop'));
  click(missing);
  assert.ok(latestGroup(f), 'uninstalled launcher remains manageable rather than using stale argv');
  assert.deepEqual(f.saved.snapshot.launchers.applications, ['fixture.desktop', 'missing.desktop']);
}, pinnedFixture);

scenario('Launcher pins: pinned order, real group counts, unavailable retention and Dock width use the same model on two outputs', f => {
  for (const theme of ['modern', 'bigsur']) {
    f.shell.selectTheme(theme);
    for (const output of [1, 2]) {
      const surface = f.surface(theme === 'modern' ? 'panel' : 'dock', output);
      const list = find(surface, theme === 'modern' ? 'shell-window-list' : 'shell-dock-windows');
      assert.deepEqual(list.childNodes.slice(0, 2).map(node => node.id),
        ['fixture.desktop', 'missing.desktop'].map(pinnedNodeId));
      assert.match(find(surface, pinnedNodeId('fixture.desktop')).getAttribute('aria-label'), /2 windows/);
      assert.match(find(surface, pinnedNodeId('missing.desktop')).getAttribute('aria-label'), /unavailable/);
      assert.equal(list.childNodes.length, 5, 'two pins including one real group plus three unpinned windows');
      if (theme === 'bigsur') {
        const l = getDesktopTheme(theme).layout;
        assert.equal(surface.options.width, Math.min(2 * l.dockPadding + 3 * l.dockTileWidth + 13 +
          5 * l.dockWindowWidth + 8 * l.dockGap, f.state.outputs[output - 1].width - 2 * l.screenInset));
      }
    }
  }
  assert.deepEqual(f.saved.snapshot.launchers.applications, ['fixture.desktop', 'missing.desktop']);
}, pinnedFixture);

scenario('Launcher pins: idle pin launches once; its context can unpin a missing app without inventing a window', f => {
  f.state.windows = [];
  f.native.onWindowsChanged();
  const surface = f.surface('panel');
  const idle = find(surface, pinnedNodeId('fixture.desktop'));
  idle.focus(); key(surface, 'Enter');
  assert.equal(f.calls.filter(call => call[0] === 'launch').length, 1);
  assert.equal(f.calls.some(call => ['activate', 'minimize'].includes(call[0])), false);
  const missing = find(f.surface('panel'), pinnedNodeId('missing.desktop'));
  assert.equal(missing.tabIndex, 0, 'uninstalled pins remain keyboard manageable');
  missing.focus(); key(f.surface('panel'), 'ContextMenu');
  const menu = latestGroup(f);
  assert.ok(menu);
  assert.equal(menu.document.getElementById('shell-group-activate-10'), null);
  assert.match(find(menu, 'shell-group-pin').getAttribute('aria-label'), /Unpin from taskbar/);
  assert.match(text(find(menu, 'shell-window-group')), /no longer in the catalog/);
  key(menu, 'Escape');
  click(missing);
  assert.equal(f.calls.filter(call => call[0] === 'launch').length, 1, 'missing primary opens management, not stale launch');
  click(find(latestGroup(f), 'shell-group-pin'));
  assert.deepEqual(f.saved.snapshot.launchers.applications, ['fixture.desktop']);
  assert.equal(f.calls.some(call => call[0] === 'close-window'), false);
}, pinnedFixture);

scenario('Launcher pins: old launch gesture cannot become window activation when a pinned app starts', f => {
  f.state.windows = [];
  f.native.onWindowsChanged();
  const surface = f.surface('panel'), idle = find(surface, pinnedNodeId('fixture.desktop'));
  const old = callback(idle, 'click');
  press(idle);
  f.state.windows = [{ id: 30, appId: 'fixture.desktop', title: 'Running now', workspaceId: 7, active: true }];
  f.native.onWindowsChanged();
  assert.equal(find(surface, pinnedNodeId('fixture.desktop')) === idle, true);
  domEvent(idle, 'mouseup'); domEvent(idle, 'click');
  assert.equal(old(event('click', { currentTarget: idle })), false);
  assert.equal(f.calls.some(call => ['activate', 'minimize', 'launch'].includes(call[0])), false);
  click(idle);
  assert.deepEqual(f.calls.at(-1), ['minimize', 30]);
}, pinnedFixture);

scenario('Launcher pins: Dock repeated or composing Enter/Space cannot launch, while a discrete Enter launches once', f => {
  f.state.windows = [];
  f.native.onWindowsChanged();
  f.shell.selectTheme('bigsur');
  const dock = f.surface('dock'), idle = find(dock, pinnedNodeId('fixture.desktop'));
  idle.focus();
  for (const name of ['Enter', ' ']) {
    key(dock, name, { repeat: true });
    key(dock, name, { isComposing: true });
  }
  assert.equal(f.calls.some(call => call[0] === 'launch'), false);
  key(dock, 'Enter');
  assert.equal(f.calls.filter(call => call[0] === 'launch').length, 1);
  key(dock, 'F10', { shiftKey: true });
  assert.ok(latestGroup(f), 'the same slot retains keyboard management');
}, pinnedFixture);

scenario('Launcher pins: launch rechecks the live catalog instead of executing removed or unavailable argv', f => {
  f.state.windows = [];
  f.native.onWindowsChanged();
  f.native.applicationFiles = () => [];
  click(find(f.surface('panel'), pinnedNodeId('fixture.desktop')));
  assert.equal(f.calls.some(call => call[0] === 'launch'), false);
  assert.match(f.shell.getState().error, /no longer available/);
  f.expectedWarnings.push('[shell] ' + f.shell.getState().error);
  const menu = f.shell.showApplications(1);
  assert.equal(menu.document.getElementById('shell-app-fixture.desktop'), null);
  assert.ok(find(f.surface('panel'), pinnedNodeId('fixture.desktop')), 'uninstall does not erase the pin');
}, pinnedFixture);

scenario('Launcher pins: unavailable registered launchers stay focusable and Shift+F10 can unpin without launch', f => {
  const surface = f.surface('panel'), task = find(surface, pinnedNodeId('fixture.desktop'));
  assert.equal(task.tabIndex, 0);
  task.focus(); key(surface, 'F10', { shiftKey: true });
  const menu = latestGroup(f);
  assert.match(text(find(menu, 'shell-window-group')), /Executable is unavailable/);
  click(find(menu, 'shell-group-pin'));
  assert.deepEqual(f.saved.snapshot.launchers.applications, []);
  assert.equal(f.calls.some(call => ['launch', 'activate', 'minimize'].includes(call[0])), false);
}, f => {
  pinnedFixture(f);
  f.state.windows = [];
  f.native.canExecute = () => false;
  f.saved.update({ launchers: { version: 1, applications: ['fixture.desktop'] } });
});

scenario('Launcher pins: current running chooser can pin and unpin without modifying desktop shortcuts', f => {
  const original = f.saved.snapshot.desktop;
  click(find(f.surface('panel'), groupId), 2);
  const menu = latestGroup(f), pin = find(menu, 'shell-group-pin'), old = callback(pin, 'click');
  click(pin);
  assert.deepEqual(f.saved.snapshot.launchers.applications, ['fixture.desktop']);
  assert.equal(menu.closed, true);
  old(event('click', { currentTarget: pin }));
  assert.deepEqual(f.saved.snapshot.launchers.applications, ['fixture.desktop']);
  click(find(f.surface('panel'), pinnedNodeId('fixture.desktop')), 2);
  click(find(latestGroup(f), 'shell-group-pin'));
  assert.deepEqual(f.saved.snapshot.launchers.applications, []);
  assert.deepEqual(f.saved.snapshot.desktop, original);
}, groupedWindows);

scenario('Launcher pins: save failures repaint the actual committed snapshot and old menu callbacks cannot mutate replacements', f => {
  const menu = f.shell.showApplications(1), pin = find(menu, 'shell-app-launcher-fixture.desktop');
  const old = callback(pin, 'click');
  f.state.configurationFailure = new Error('fixture pin write refused');
  click(pin);
  assert.deepEqual(f.saved.snapshot.launchers.applications, []);
  assert.match(f.shell.getState().error, /were not changed.*fixture pin write refused/);
  f.expectedWarnings.push('[shell] ' + f.shell.getState().error);
  f.state.configurationFailure = Object.assign(new Error('fixture pin durability uncertain'), { committed: true });
  click(find(menu, 'shell-app-launcher-fixture.desktop'));
  assert.deepEqual(f.saved.snapshot.launchers.applications, ['fixture.desktop']);
  assert.ok(find(f.surface('panel'), pinnedNodeId('fixture.desktop')));
  assert.match(f.shell.getState().error, /saved.*durability/);
  f.expectedWarnings.push('[shell] ' + f.shell.getState().error);
  f.state.configurationFailure = null;
  f.shell.showApplications(2);
  old(event('click', { currentTarget: pin }));
  assert.deepEqual(f.saved.snapshot.launchers.applications, ['fixture.desktop']);
}, groupedWindows);

function orderedPinFixture(f) {
  pinnedFixture(f);
  f.saved.update({ launchers: { version: 1,
    applications: ['fixture.desktop', 'missing.desktop', 'last.desktop'] } });
}

scenario('Launcher order: unavailable pins move through keyboard Earlier/Later, persist and preserve desktop shortcuts', f => {
  f.shell.addDesktopShortcut(1, 'fixture.desktop');
  const desktop = f.saved.snapshot.desktop;
  const task = find(f.surface('panel'), pinnedNodeId('missing.desktop'));
  task.focus(); key(f.surface('panel'), 'ContextMenu');
  const menu = latestGroup(f);
  assert.ok(find(menu, 'shell-group-pin-earlier'));
  assert.ok(find(menu, 'shell-group-pin-later'));
  key(menu, 'Home'); key(menu, 'ArrowDown');
  assert.ok(menu.document.activeElement === find(menu, 'shell-group-pin-earlier'));
  key(menu, 'Enter'); f.flushFrames();
  assert.deepEqual(f.saved.snapshot.launchers.applications, ['missing.desktop', 'fixture.desktop', 'last.desktop']);
  assert.equal(menu.document.getElementById('shell-group-pin-earlier'), null, 'first item has no Earlier command');
  assert.equal(menu.closed, false);
  key(menu, 'Home'); key(menu, 'Tab');
  assert.ok(menu.document.activeElement === find(menu, 'shell-group-pin-later'), 'existing Tab traversal reaches order controls');
  key(menu, 'Enter'); f.flushFrames();
  click(find(menu, 'shell-group-pin-later'));
  assert.deepEqual(f.saved.snapshot.launchers.applications, ['fixture.desktop', 'last.desktop', 'missing.desktop']);
  assert.equal(menu.document.getElementById('shell-group-pin-later'), null, 'last item has no Later command');
  assert.deepEqual(f.saved.snapshot.desktop, desktop);
  assert.deepEqual(find(f.surface('panel'), 'shell-window-list').childNodes.slice(0, 3).map(node => node.id),
    f.saved.snapshot.launchers.applications.map(pinnedNodeId));
  f.shell.stop(); f.shell.start();
  assert.deepEqual(f.saved.snapshot.launchers.applications, ['fixture.desktop', 'last.desktop', 'missing.desktop']);
  assert.deepEqual(find(f.surface('panel'), 'shell-window-list').childNodes.slice(0, 3).map(node => node.id),
    f.saved.snapshot.launchers.applications.map(pinnedNodeId));
  assert.deepEqual(f.saved.snapshot.desktop, desktop);
  assert.equal(f.calls.some(call => ['launch', 'activate', 'close-window'].includes(call[0])), false,
    'launcher order is not a window or process operation');
}, orderedPinFixture);

scenario('Launcher order: stale position and held direction cannot overwrite concurrent pin ordering', f => {
  click(find(f.surface('panel'), pinnedNodeId('missing.desktop')), 2);
  const menu = latestGroup(f), earlier = find(menu, 'shell-group-pin-earlier');
  const old = callback(earlier, 'click');
  press(earlier);
  f.saved.update({ launchers: { version: 1,
    applications: ['missing.desktop', 'last.desktop', 'fixture.desktop'] } });
  f.native.onWindowsChanged(); f.flushFrames();
  const saved = f.saved.snapshot;
  assert.ok(find(menu, 'shell-group-pin-later') === earlier, 'existing positional DOM changed from Earlier to Later');
  domEvent(earlier, 'mouseup'); domEvent(earlier, 'click');
  assert.equal(old(event('click', { currentTarget: earlier })), false);
  assert.ok(f.saved.snapshot === saved, 'old position/direction cannot republish a stale array');
  click(find(menu, 'shell-group-pin-later'));
  assert.deepEqual(f.saved.snapshot.launchers.applications, ['last.desktop', 'missing.desktop', 'fixture.desktop'],
    'a new deliberate gesture swaps only its current adjacent entries');
  const retired = callback(find(menu, 'shell-group-pin-later'), 'click');
  f.shell.showApplications(2);
  const replaced = f.saved.snapshot;
  assert.equal(retired(event('click')), false);
  assert.ok(f.saved.snapshot === replaced, 'a replaced menu cannot reorder pins');
}, orderedPinFixture);

scenario('Launcher order: removed output or pin and unpinned groups have no stale sorting authority', f => {
  click(find(f.surface('panel', 2), pinnedNodeId('missing.desktop')), 2);
  const menu = latestGroup(f), later = callback(find(menu, 'shell-group-pin-later'), 'click');
  f.state.outputs = f.state.outputs.filter(output => output.id !== 2);
  const previous = f.saved.snapshot;
  assert.equal(later(event('click')), false, 'removed output is checked before the next repaint');
  assert.ok(f.saved.snapshot === previous);
  f.shell.refresh(true);
  click(find(f.surface('panel'), pinnedNodeId('missing.desktop')), 2);
  const current = latestGroup(f), move = callback(find(current, 'shell-group-pin-earlier'), 'click');
  f.saved.update({ launchers: { version: 1, applications: ['fixture.desktop', 'last.desktop'] } });
  const removed = f.saved.snapshot;
  assert.equal(move(event('click')), false);
  assert.ok(f.saved.snapshot === removed, 'a removed pin cannot be reintroduced through an order callback');
  f.native.onWindowsChanged();
  f.saved.update({ launchers: { version: 1, applications: [] } });
  f.native.onWindowsChanged();
  click(find(f.surface('panel'), groupId), 2);
  const unpinned = latestGroup(f);
  assert.equal(unpinned.document.getElementById('shell-group-pin-earlier'), null);
  assert.equal(unpinned.document.getElementById('shell-group-pin-later'), null);
}, orderedPinFixture);

scenario('Launcher order: prepublication failure retains order and committed failure publishes order without rollback', f => {
  click(find(f.surface('panel'), pinnedNodeId('missing.desktop')), 2);
  const menu = latestGroup(f), before = f.saved.snapshot, desktop = before.desktop;
  f.state.configurationFailure = new Error('fixture order write refused');
  click(find(menu, 'shell-group-pin-earlier'));
  assert.ok(f.saved.snapshot === before);
  assert.match(f.shell.getState().error, /were not changed.*fixture order write refused/);
  f.expectedWarnings.push('[shell] ' + f.shell.getState().error);
  f.state.configurationFailure = Object.assign(new Error('fixture order durability uncertain'), { committed: true });
  click(find(menu, 'shell-group-pin-earlier'));
  assert.deepEqual(f.saved.snapshot.launchers.applications, ['missing.desktop', 'fixture.desktop', 'last.desktop']);
  assert.equal(menu.document.getElementById('shell-group-pin-earlier'), null);
  assert.match(f.shell.getState().error, /saved.*durability/);
  f.expectedWarnings.push('[shell] ' + f.shell.getState().error);
  assert.deepEqual(f.saved.snapshot.desktop, desktop);
  f.state.configurationFailure = null;
  click(find(menu, 'shell-group-pin-later'));
  assert.deepEqual(f.saved.snapshot.launchers.applications, ['fixture.desktop', 'missing.desktop', 'last.desktop']);
  assert.equal(f.shell.getState().error, '', 'a later successful order change uses the shared pin error recovery');
}, orderedPinFixture);

scenario('Launcher pins: limit errors keep the stored order and stale held Apps controls cannot pin a different entry', f => {
  f.saved.update({ launchers: { version: 1, applications: Array.from({ length: 32 }, (_, i) => 'missing-' + i + '.desktop') } });
  const menu = f.shell.showApplications(1), previous = f.saved.snapshot.launchers;
  click(find(menu, 'shell-app-launcher-fixture.desktop'));
  assert.deepEqual(f.saved.snapshot.launchers, previous);
  assert.match(f.shell.getState().error, /At most 32/);
  f.expectedWarnings.push('[shell] ' + f.shell.getState().error);
  f.saved.update({ launchers: { version: 1, applications: [] } });
  f.shell.refresh();
  const pin = find(menu, 'shell-app-launcher-fixture.desktop');
  press(pin);
  f.native.applicationFiles = () => [{ id: 'replacement.desktop', path: '/replacement.desktop',
    contents: '[Desktop Entry]\nType=Application\nName=Replacement\nExec=replacement\n' }];
  click(find(menu, 'shell-app-refresh'));
  domEvent(pin, 'mouseup'); domEvent(pin, 'click');
  assert.deepEqual(f.saved.snapshot.launchers.applications, []);
}, groupedWindows);

scenario('Launcher pins: registered Settings pin merges its runtime windows and both Apps entries share one pin identity', f => {
  const menu = f.shell.showApplications(1);
  click(find(menu, 'shell-app-launcher-org.pollyui.settings'));
  assert.deepEqual(f.saved.snapshot.launchers.applications, ['polly-settings.desktop']);
  assert.match(find(menu, 'shell-app-launcher-polly-settings.desktop').getAttribute('aria-label'), /Unpin/);
  const list = find(f.surface('panel'), 'shell-window-list');
  assert.equal(list.childNodes.length, 1);
  assert.match(list.firstChild.getAttribute('aria-label'), /2 windows/);
  click(find(f.surface('panel'), pinnedNodeId('polly-settings.desktop')), 2);
  const single = latestGroup(f);
  assert.equal(single.document.getElementById('shell-group-pin-earlier'), null);
  assert.equal(single.document.getElementById('shell-group-pin-later'), null, 'a single pin has no direction commands');
  f.saved.update({ launchers: { version: 1, applications: ['missing.desktop', 'polly-settings.desktop'] } });
  f.native.onWindowsChanged();
  click(find(single, 'shell-group-pin-earlier'));
  assert.deepEqual(f.saved.snapshot.launchers.applications, ['polly-settings.desktop', 'missing.desktop'],
    'ordering uses the same canonical registered Settings ID as pinning');
  f.state.windows = [];
  f.native.onWindowsChanged();
  click(find(f.surface('panel'), pinnedNodeId('polly-settings.desktop')));
  assert.deepEqual(f.calls.filter(call => call[0] === 'settings-open'), [['settings-open', 'appearance']]);
  assert.equal(f.calls.some(call => call[0] === 'launch'), false);
  f.shell.selectTheme('xp');
  click(find(f.surface('panel'), pinnedNodeId('polly-settings.desktop')));
  assert.equal(f.calls.filter(call => call[0] === 'settings-open').length, 2,
    'XP Settings Quick Launch uses the same single Settings bridge');
  assert.equal(f.calls.some(call => call[0] === 'launch'), false);
  assert.deepEqual(f.saved.snapshot.desktop.shortcuts, []);
}, ({ state, native }) => {
  state.windows = [10, 11].map(id => ({ id, appId: 'org.pollyui.settings', title: 'Settings ' + id, workspaceId: 7 }));
  native.applicationFiles = () => [{ id: 'polly-settings.desktop', path: '/polly-settings.desktop',
    contents: '[Desktop Entry]\nType=Application\nName=Settings\nX-Polly-AppId=org.pollyui.settings\nExec=polly-settings\n' }];
});

test('Application tasks: group-menu chrome uses the shared menu policy without masking custom tokens', () => {
  const group = windowTasks([{ id: 10, appId: 'fixture.desktop', title: 'Document', workspaceId: 7 }],
    'applications')[0];
  for (const id of ['modern', 'server2003']) {
    const base = getDesktopTheme(id);
    const theme = { ...base, id: 'custom-group-menu', colors: { ...base.colors, surface: '#112233', border: '#334455' },
      button: { ...base.button, radius: 9 }, window: { ...base.window, radius: 17 },
      layout: { ...base.layout, compactPadding: 7, controlGap: 5, contentPadding: 19, borderWidth: 2 } };
    const menu = windowGroupMenu(theme, group, { slots: [], action() {}, close() {} });
    assert.deepEqual(menu.props.style, { ...panelAppearance(theme, 'menu'),
      width: '100%', height: '100%', minHeight: 0, minWidth: 0, overflow: 'hidden' });
    assert.equal(menu.children[1].props.id, 'shell-group-list-scroll-area', 'list area keeps its positional slot across themes');
    assert.equal(menu.children[1].children[0].props.id, 'shell-group-list', 'original list ID and direct command rows are retained');
    assert.equal(menu.children[2].props.id, 'shell-group-menu-close', 'close keeps its positional slot across themes');
    const detail = panelDetail(theme, 'menu');
    if (detail) assert.deepEqual(menu.children.at(-1), detail,
      'Classic passive detail is mounted after stable interactive slots');
    assert.equal(menu.props.role, 'menu');
  }
});

scenario('Application tasks: Modern and Big Sur use one model and both outputs size Dock by display tasks', f => {
  for (const theme of ['modern', 'bigsur']) {
    f.shell.selectTheme(theme);
    for (const output of [1, 2]) {
      const surface = f.surface(theme === 'modern' ? 'panel' : 'dock', output);
      const group = find(surface, groupId);
      assert.equal(group.getAttribute('aria-label'), 'Fixture (2 windows), some minimized');
      assert.equal(group.getAttribute('aria-pressed'), 'true');
      const list = find(surface, theme === 'modern' ? 'shell-window-list' : 'shell-dock-windows');
      assert.equal(list.childNodes.length, 4);
      assert.ok(find(surface, 'shell-window-13'));
      assert.ok(find(surface, 'shell-window-14'));
      assert.equal(surface.document.getElementById('shell-window-15'), null);
      if (theme === 'bigsur') {
        const current = getDesktopTheme(theme), l = current.layout;
        const natural = 2 * l.dockPadding + 3 * l.dockTileWidth + 13 + 4 * l.dockWindowWidth + 7 * l.dockGap;
        assert.equal(surface.options.width, Math.min(natural, f.state.outputs[output - 1].width - 2 * l.screenInset));
      }
      click(group);
      const menu = latestGroup(f);
      assert.ok(menu);
      assert.ok(find(menu, 'shell-group-activate-10'));
      assert.ok(find(menu, 'shell-group-activate-11'));
      assert.equal(menu.document.getElementById('shell-group-activate-15'), null);
      assert.equal(menu.options.keyboard, 'exclusive');
      assert.equal(menu.options.exclusiveZone, -1);
      key(menu, 'Escape');
      assert.equal(menu.closed, true);
      assert.equal(surface.document.activeElement, group);
    }
  }
  assert.deepEqual(f.calls.filter(call => ['activate', 'minimize', 'restore', 'close-window'].includes(call[0])), []);
}, groupedWindows);

scenario('Application tasks: live single-window Modern minimizes, Mac activates; XP remains per window', f => {
  f.state.windows = [f.state.windows[0]];
  f.native.onWindowsChanged();
  click(find(f.surface('panel'), groupId));
  assert.deepEqual(f.calls.at(-1), ['minimize', 10]);
  f.shell.selectTheme('bigsur');
  const dock = f.surface('dock');
  click(find(dock, groupId));
  assert.deepEqual(f.calls.at(-1), ['activate', 10], 'active Mac application is not minimized');
  f.state.windows[0].minimized = true;
  f.native.onWindowsChanged();
  click(find(dock, groupId));
  assert.deepEqual(f.calls.at(-1), ['activate', 10], 'minimized Mac application uses actual activate/restore API');
  f.state.windows[0].minimized = false;
  f.native.onWindowsChanged();
  click(find(dock, groupId), 2);
  const menu = latestGroup(f);
  assert.ok(menu);
  click(find(menu, 'shell-group-minimize-10'));
  assert.deepEqual(f.calls.at(-1), ['minimize', 10]);
  f.shell.selectTheme('xp');
  assert.equal(f.surface('panel').document.getElementById(groupId), null);
  click(find(f.surface('panel'), 'shell-window-10'));
  assert.deepEqual(f.calls.at(-1), ['minimize', 10]);
}, groupedWindows);

scenario('Application tasks: unchanged clock paints do not reread catalog or window backends', f => {
  const group = find(f.surface('panel'), groupId);
  let catalogReads = 0, windowReads = 0;
  const files = f.native.applicationFiles, windows = f.native.windows;
  f.native.applicationFiles = () => { catalogReads++; return files(); };
  f.native.windows = () => { windowReads++; return windows(); };
  for (let count = 0; count < 3; count++) f.shell.refresh();
  assert.equal(catalogReads, 0);
  assert.equal(windowReads, 0);
  assert.equal(find(f.surface('panel'), groupId), group);
}, groupedWindows);

scenario('Application tasks: operation failures retain the live chooser and surface the actual error', f => {
  click(find(f.surface('panel'), groupId));
  const menu = latestGroup(f);
  f.native.activateWindow = () => { throw new Error('fixture window service refused activation'); };
  const first = find(menu, 'shell-group-activate-10');
  assert.equal(callback(first, 'click')(event('click', { currentTarget: first })), false);
  assert.equal(menu.closed, false);
  assert.match(text(find(menu, 'shell-window-group')), /fixture window service refused activation/);
  f.expectedWarnings.push('[shell] ' + f.shell.getState().error);
}, groupedWindows);

scenario('Application tasks: chooser commands target real windows; keyboard wraps and stale closed/replaced handlers reject', f => {
  const panel = f.surface('panel'), group = find(panel, groupId);
  group.focus(); key(panel, 'Enter');
  const menu = latestGroup(f);
  const first = find(menu, 'shell-group-activate-10');
  assert.equal(menu.document.activeElement, first);
  key(menu, 'End');
  assert.equal(menu.document.activeElement, find(menu, 'shell-group-menu-close'));
  key(menu, 'Tab');
  assert.equal(menu.document.activeElement, first);
  key(menu, 'Tab', { shiftKey: true });
  assert.equal(menu.document.activeElement, find(menu, 'shell-group-menu-close'));
  key(menu, 'Home'); key(menu, 'ArrowDown'); key(menu, 'ArrowRight'); key(menu, 'ArrowDown');
  assert.equal(menu.document.activeElement, find(menu, 'shell-group-activate-11'));
  const old = callback(menu.document.activeElement, 'click');
  key(menu, 'Enter');
  assert.deepEqual(f.calls.at(-1), ['activate', 11]);
  assert.equal(menu.closed, true);
  const count = f.calls.length;
  assert.equal(old(event('click')), false);
  assert.equal(f.calls.length, count);
  click(group);
  const next = latestGroup(f);
  assert.notEqual(next, menu);
  assert.equal(old(event('click')), false);
  click(find(next, 'shell-group-minimize-11'));
  assert.deepEqual(f.calls.slice(-2), [['restore', 11], ['activate', 11]]);
  click(group);
  click(find(latestGroup(f), 'shell-group-close-10'));
  assert.deepEqual(f.calls.at(-1), ['close-window', 10], 'no process-wide close');
}, groupedWindows);

scenario('Application tasks: held row removal/reordering cannot retarget a release; metadata and clock retain live nodes', f => {
  const panel = f.surface('panel'), group = find(panel, groupId);
  click(group);
  const menu = latestGroup(f), first = find(menu, 'shell-group-activate-10');
  const old = callback(first, 'click');
  press(first);
  f.state.windows = f.state.windows.filter(window => window.id !== 10).reverse();
  f.state.windows.push({ id: 16, appId: 'fixture.desktop', title: 'New document', workspaceId: 7 });
  f.native.onWindowsChanged();
  assert.equal(menu.closed, false);
  assert.equal(menu.document.getElementById('shell-group-activate-10'), null);
  assert.equal(find(menu, 'shell-group-activate-11').parentNode,
    find(menu, 'shell-group-list').childNodes[1], 'removed stable slot is not assigned to another window');
  assert.equal(old(event('click')), false);
  domEvent(first, 'mouseup'); domEvent(first, 'click');
  assert.equal(f.calls.some(call => call[0] === 'activate'), false);
  const remaining = find(menu, 'shell-group-activate-11');
  f.state.windows.find(window => window.id === 11).title = 'Renamed actual document';
  f.state.windows.reverse();
  f.native.onWindowsChanged();
  f.shell.refresh();
  assert.equal(find(menu, 'shell-group-activate-11'), remaining);
  assert.match(remaining.getAttribute('aria-label'), /Renamed actual document/);
  assert.equal(find(panel, groupId), group);
  click(remaining);
  assert.deepEqual(f.calls.at(-1), ['activate', 11]);
}, groupedWindows);

scenario('Application tasks: held task identity and command meaning survive no retargeting across live changes', f => {
  const panel = f.surface('panel'), group = find(panel, groupId);
  const oldOpen = callback(group, 'click');
  press(group);
  f.state.windows = f.state.windows.filter(window => ![10, 11].includes(window.id));
  f.native.onWindowsChanged();
  assert.equal(group.id, 'shell-window-app-other.application', 'positional node is now a different application');
  domEvent(group, 'mouseup'); domEvent(group, 'click');
  assert.equal(latestGroup(f), undefined, 'held old application must not open the replacement');
  assert.equal(f.calls.some(call => call[0] === 'activate'), false);
  assert.equal(oldOpen(event('click')), false, 'task click returns no success after old group disappears');

  f.state.windows.push({ id: 20, appId: 'other.application', title: 'Other two', workspaceId: 7 });
  f.native.onWindowsChanged();
  click(find(panel, 'shell-window-app-other.application'));
  const menu = latestGroup(f), minimize = find(menu, 'shell-group-minimize-12');
  press(minimize);
  f.state.windows.find(window => window.id === 12).minimized = true;
  f.native.onWindowsChanged();
  domEvent(minimize, 'mouseup'); domEvent(minimize, 'click');
  assert.equal(f.calls.some(call => ['restore', 'minimize'].includes(call[0])), false,
    'held Minimize must not turn into Restore');
  assert.equal(menu.closed, false);
}, groupedWindows);

scenario('Application tasks: callbacks recheck native membership and workspace even before change notification', f => {
  const group = find(f.surface('panel'), groupId);
  const open = () => { click(group); return latestGroup(f); };
  let menu = open(), old = callback(find(menu, 'shell-group-activate-11'), 'click');
  f.state.windows.find(window => window.id === 11).appId = 'different.application';
  assert.equal(old(event('click')), false);
  assert.equal(menu.closed, false);
  f.state.windows.find(window => window.id === 11).appId = 'fixture.desktop';
  f.state.windows.find(window => window.id === 11).workspaceId = 9;
  assert.equal(old(event('click')), false);
  f.state.windows.find(window => window.id === 11).workspaceId = 7;
  f.state.workspaces.forEach(workspace => { workspace.active = workspace.id === 9; });
  assert.equal(old(event('click')), false);
  f.native.onWorkspacesChanged();
  assert.equal(menu.closed, true);
  assert.equal(f.calls.some(call => call[0] === 'activate'), false);
  f.state.workspaces.forEach(workspace => { workspace.active = workspace.id === 7; });
  f.native.onWorkspacesChanged();
  menu = open();
  old = callback(find(menu, 'shell-group-close-10'), 'click');
  f.state.windows = f.state.windows.filter(window => window.appId !== 'fixture.desktop');
  f.native.onWindowsChanged();
  assert.equal(menu.closed, true);
  assert.equal(old(event('click')), false);
  assert.equal(f.calls.some(call => call[0] === 'close-window'), false);
}, groupedWindows);

scenario('Application tasks: held application cannot follow the same app ID into a different workspace after repaint', f => {
  const panel = f.surface('panel'), group = find(panel, groupId);
  const original = callback(group, 'click');
  press(group);
  f.state.workspaces.forEach(workspace => { workspace.active = workspace.id === 9; });
  assert.equal(original(event('click')), false, 'old closure checks native workspace before notification');
  f.native.onWorkspacesChanged();
  assert.equal(find(panel, groupId), group, 'same app still occupies the same positional node in new workspace');
  domEvent(group, 'mouseup'); domEvent(group, 'click');
  assert.equal(latestGroup(f), undefined);
  assert.equal(f.calls.some(call => ['activate', 'minimize'].includes(call[0])), false,
    'new DOM handler does not inherit the previous workspace pointer gesture');
  click(group);
  assert.deepEqual(f.calls.at(-1), ['activate', 15], 'a new deliberate gesture can select the current workspace');
}, groupedWindows);

scenario('Application tasks: output/menu replacement and theme changes retire old chooser callbacks', f => {
  click(find(f.surface('panel'), groupId));
  const first = latestGroup(f), old = callback(find(first, 'shell-group-close-10'), 'click');
  click(find(f.surface('panel', 2), groupId));
  const second = latestGroup(f);
  assert.equal(first.closed, true);
  assert.equal(old(event('click')), false);
  assert.equal(second.options.output, 2);
  const close = callback(find(second, 'shell-group-close-10'), 'click');
  f.state.outputs = f.state.outputs.filter(output => output.id !== 2);
  assert.equal(close(event('click')), false, 'removed output is checked even before Shell refresh');
  f.shell.refresh(true);
  assert.equal(second.closed, true);
  assert.equal(close(event('click')), false);
  click(find(f.surface('panel'), groupId));
  const third = latestGroup(f), previous = callback(find(third, 'shell-group-activate-10'), 'click');
  f.shell.selectTheme('xp');
  assert.equal(third.closed, true);
  assert.equal(previous(event('click')), false);
  assert.equal(f.calls.some(call => ['activate', 'close-window'].includes(call[0])), false);
}, groupedWindows);

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

function categorizedPrograms({ native, state }) {
  state.windows = [];
  state.categoryFiles = [
    { id: 'editor.desktop', name: 'Editor', tags: ['Utility', '\u6587\u6863'] },
    { id: 'viewer.desktop', name: 'Viewer', tags: ['\u6587\u6863'] },
    { id: 'plain.desktop', name: 'No tags', tags: [] },
    { id: 'literal.desktop', name: 'Literal tag', tags: ['Uncategorized'] },
  ];
  native.applicationFiles = () => state.categoryFiles.map(entry => ({ id: entry.id, path: '/' + entry.id,
    contents: '[Desktop Entry]\nType=Application\nName=' + entry.name + '\nExec=fixture\nCategories=' +
      entry.tags.join(';') + ';\n' }));
}
function categoryMenu(f) {
  f.shell.selectTheme('server2003');
  const menu = f.shell.showApplications(1);
  find(menu, 'shell-all-programs').focus(); key(menu, 'ArrowRight'); f.flushFrames();
  return menu;
}
function browseCategory(f, menu, tag) {
  click(find(menu, 'shell-program-categories')); f.flushFrames();
  click(find(menu, programCategoryId(tag))); f.flushFrames();
}

test('Classic Programs category metadata is exact, non-exclusive, Unicode and separate from untagged applications', () => {
  const entries = Object.freeze([
    Object.freeze({ id: 'one', categories: Object.freeze(['Utility', '\u6587\u6863', 'Utility']) }),
    Object.freeze({ id: 'two', categories: Object.freeze(['\u6587\u6863']) }),
    Object.freeze({ id: 'three', categories: Object.freeze([]) }),
    Object.freeze({ id: 'four', categories: Object.freeze(['Uncategorized', 'utility']) }),
  ]);
  const categories = programCategories(entries);
  assert.equal(categories.find(item => item.tag === 'Utility').count, 1, 'duplicate tag counts an application only once');
  assert.equal(categories.find(item => item.tag === '\u6587\u6863').count, 2);
  assert.equal(categories.find(item => item.tag === 'utility').count, 1, 'tags match with exact case');
  assert.deepEqual(categoryEntries(entries, '\u6587\u6863').map(entry => entry.id), ['one', 'two']);
  assert.deepEqual(categoryEntries(entries, null).map(entry => entry.id), ['three']);
  assert.notEqual(programCategoryId(null), programCategoryId('Uncategorized'));
  assert.deepEqual(programCategories([...entries].reverse()), categories, 'tag browsing order is independent of catalog order');
  assert.deepEqual(programCategories([]), []);
});

scenario('Classic Programs categories keep the default flat view and layer Back/Escape while Tab includes the header', f => {
  const menu = categoryMenu(f), search = find(menu, 'shell-app-search');
  assert.ok(find(menu, 'shell-program-editor.desktop'));
  assert.ok(find(menu, 'shell-program-viewer.desktop'));
  key(menu, 'End'); key(menu, 'Tab');
  assert.equal(menu.document.activeElement, find(menu, 'shell-program-back'));
  key(menu, 'Tab');
  assert.equal(menu.document.activeElement, find(menu, 'shell-program-categories'));
  key(menu, 'Enter'); f.flushFrames();
  assert.equal(menu.document.getElementById('shell-program-editor.desktop'), null);
  const category = find(menu, programCategoryId('\u6587\u6863'));
  assert.match(category.getAttribute('aria-label'), /\(2\)/);
  category.focus(); key(menu, 'ArrowRight'); f.flushFrames();
  assert.ok(find(menu, 'shell-program-editor.desktop'));
  assert.ok(find(menu, 'shell-program-viewer.desktop'));
  assert.equal(menu.document.getElementById('shell-program-plain.desktop'), null);
  key(menu, 'Home'); key(menu, 'ArrowDown'); key(menu, 'Enter'); f.flushFrames();
  assert.equal(f.saved.snapshot.desktop.shortcuts[0].id, 'editor.desktop', 'leaf Pin invokes only the original desktop service');
  assert.equal(f.calls.some(call => call[0] === 'launch'), false);
  key(menu, 'Escape'); f.flushFrames();
  assert.equal(menu.document.activeElement, find(menu, programCategoryId('\u6587\u6863')));
  key(menu, 'ArrowLeft'); f.flushFrames();
  assert.equal(menu.document.activeElement, find(menu, 'shell-program-categories'));
  assert.ok(find(menu, 'shell-program-plain.desktop'), 'category index Back returns to flat All applications');
  key(menu, 'Escape'); f.flushFrames();
  assert.equal(menu.closed, false);
  assert.equal(menu.document.activeElement, find(menu, 'shell-all-programs'));
  assert.equal(find(menu, 'shell-app-search'), search, 'category navigation never replaces real root search');
}, categorizedPrograms);

scenario('Classic Programs categories provide nonexclusive leaves, direct All applications and a real Uncategorized view', f => {
  const menu = categoryMenu(f);
  browseCategory(f, menu, 'Utility');
  assert.ok(find(menu, 'shell-program-editor.desktop'));
  assert.equal(menu.document.getElementById('shell-program-viewer.desktop'), null);
  click(find(menu, 'shell-program-all')); f.flushFrames();
  assert.ok(find(menu, 'shell-program-viewer.desktop'));
  browseCategory(f, menu, '\u6587\u6863');
  assert.ok(find(menu, 'shell-program-editor.desktop'), 'the same app participates in multiple exact category tags');
  click(find(menu, 'shell-program-all')); f.flushFrames();
  browseCategory(f, menu, null);
  assert.ok(find(menu, 'shell-program-plain.desktop'));
  assert.equal(menu.document.getElementById('shell-program-literal.desktop'), null, 'literal Uncategorized is a different real tag');
  click(find(menu, 'shell-program-all')); f.flushFrames();
  browseCategory(f, menu, 'Uncategorized');
  assert.ok(find(menu, 'shell-program-literal.desktop'));
  click(find(menu, 'shell-program-literal.desktop'));
  assert.equal(f.calls.filter(call => call[0] === 'launch').length, 1);
  assert.equal(menu.closed, true);
}, categorizedPrograms);

scenario('Classic Programs category epochs reject old callbacks and held rows after navigation changes', f => {
  const menu = categoryMenu(f);
  const first = find(menu, 'shell-program-editor.desktop'), oldFlat = callback(first, 'click');
  press(first);
  browseCategory(f, menu, '\u6587\u6863');
  domEvent(first, 'mouseup'); domEvent(first, 'click');
  oldFlat(event('click', { currentTarget: first }));
  assert.equal(f.calls.some(call => call[0] === 'launch'), false, 'held flat command cannot become a leaf command');
  const row = find(menu, 'shell-program-editor.desktop');
  const oldLeaf = callback(row, 'click'), oldPin = callback(find(menu, 'shell-program-pin-editor.desktop'), 'click');
  key(menu, 'Escape'); f.flushFrames();
  const oldCategory = callback(find(menu, programCategoryId('\u6587\u6863')), 'click');
  click(find(menu, 'shell-program-all')); f.flushFrames();
  oldLeaf(event('click', { currentTarget: row }));
  oldPin(event('click'));
  oldCategory(event('click'));
  assert.equal(f.calls.some(call => call[0] === 'launch'), false);
  assert.deepEqual(f.saved.snapshot.desktop.shortcuts, []);
  assert.ok(find(menu, 'shell-program-plain.desktop'), 'obsolete category callback cannot switch the current view');
  browseCategory(f, menu, '\u6587\u6863');
  oldLeaf(event('click', { currentTarget: row }));
  assert.equal(f.calls.some(call => call[0] === 'launch'), false, 'returning to the same tag has a new navigation epoch');
}, categorizedPrograms);

scenario('Classic Programs category membership is rechecked live for both launch and Pin, including an empty removed tag', f => {
  const menu = categoryMenu(f);
  browseCategory(f, menu, '\u6587\u6863');
  const row = find(menu, 'shell-program-editor.desktop'), pin = find(menu, 'shell-program-pin-editor.desktop');
  const oldLaunch = callback(row, 'click'), oldPin = callback(pin, 'click');
  press(row);
  f.state.categoryFiles[0].tags = ['Utility'];
  oldLaunch(event('click', { currentTarget: row }));
  assert.equal(f.calls.some(call => call[0] === 'launch'), false, 'native catalog change is checked before stale leaf activation');
  oldPin(event('click', { currentTarget: pin }));
  assert.deepEqual(f.saved.snapshot.desktop.shortcuts, [], 'removed membership cannot pin through an old leaf');
  assert.equal(menu.document.getElementById('shell-program-editor.desktop'), null);
  assert.ok(find(menu, 'shell-program-viewer.desktop').parentNode === find(menu, 'shell-program-list'),
    'remaining member stays in the actual list');
  assert.equal(find(menu, 'shell-program-list').childNodes.indexOf(find(menu, 'shell-program-viewer.desktop')), 2,
    'removed membership leaves stable vacant rows');
  f.state.categoryFiles[1].tags = [];
  click(find(menu, 'shell-app-refresh')); f.flushFrames();
  assert.match(text(find(menu, 'shell-program-list')), /No applications in this category/);
  assert.ok(find(menu, 'shell-program-all'));
  key(menu, 'Home'); key(menu, 'Tab');
  key(menu, 'Escape'); f.flushFrames();
  assert.equal(menu.document.getElementById(programCategoryId('\u6587\u6863')), null);
  assert.ok(menu.document.activeElement === find(menu, 'shell-program-back'), 'removed category has a bounded focus fallback');
  click(find(menu, 'shell-program-all')); f.flushFrames();
  assert.ok(find(menu, 'shell-program-editor.desktop'), 'global application stays available outside the removed category');
}, categorizedPrograms);

scenario('Classic Programs category actions reject failed catalog refresh without discarding retained entries, then recover', f => {
  const menu = categoryMenu(f), read = f.native.applicationFiles;
  click(find(menu, 'shell-program-categories')); f.flushFrames();
  const category = find(menu, programCategoryId('\u6587\u6863'));
  const snapshot = f.saved.snapshot;
  const fail = () => { throw new Error('fixture catalog read failed'); };
  const acknowledgeFailure = () => {
    assert.match(f.shell.getState().error, /Application discovery failed.*fixture catalog read failed/);
    f.expectedWarnings.push('[shell] ' + f.shell.getState().error);
    assert.ok(f.saved.snapshot === snapshot, 'failed catalog actions do not publish preferences');
    assert.equal(f.calls.some(call => call[0] === 'launch'), false);
  };
  f.native.applicationFiles = fail;
  assert.equal(callback(category, 'click')(event('click', { currentTarget: category })), false);
  f.flushFrames(); acknowledgeFailure();
  assert.ok(find(menu, programCategoryId('\u6587\u6863')), 'retained category remains visible, not accepted as fresh');
  assert.equal(menu.document.getElementById('shell-program-editor.desktop'), null, 'failed entry did not navigate');
  f.native.applicationFiles = read;
  click(find(menu, programCategoryId('\u6587\u6863'))); f.flushFrames();
  const row = find(menu, 'shell-program-editor.desktop'), pin = find(menu, 'shell-program-pin-editor.desktop');
  assert.equal(f.shell.getState().error, '', 'successful refresh clears discovery failure');
  f.native.applicationFiles = fail;
  assert.equal(callback(row, 'click')(event('click', { currentTarget: row })), false);
  f.flushFrames(); acknowledgeFailure();
  assert.ok(find(menu, 'shell-program-editor.desktop'), 'retained application stays visible in its current leaf');
  assert.equal(callback(pin, 'click')(event('click', { currentTarget: pin })), false);
  f.flushFrames(); acknowledgeFailure();
  assert.match(text(find(menu, 'shell-program-error')), /fixture catalog read failed/);
  f.native.applicationFiles = read;
  click(find(menu, 'shell-program-pin-editor.desktop')); f.flushFrames();
  assert.deepEqual(f.saved.snapshot.desktop.shortcuts.map(item => item.id), ['editor.desktop']);
  assert.equal(f.shell.getState().error, '');
  click(find(menu, 'shell-program-editor.desktop'));
  assert.equal(f.calls.filter(call => call[0] === 'launch').length, 1);
  assert.equal(menu.closed, true);
}, categorizedPrograms);

scenario('Classic Programs category selection rejects a removed tag before refresh and navigation resets on reopen', f => {
  const menu = categoryMenu(f);
  click(find(menu, 'shell-program-categories')); f.flushFrames();
  const category = find(menu, programCategoryId('\u6587\u6863')), old = callback(category, 'click');
  f.state.categoryFiles.forEach(entry => { entry.tags = []; });
  assert.equal(old(event('click', { currentTarget: category })), false);
  assert.equal(menu.document.getElementById(programCategoryId('\u6587\u6863')), null);
  assert.equal(menu.document.getElementById('shell-program-editor.desktop'), null, 'rejected category leaves the category index open');
  click(find(menu, programCategoryId(null))); f.flushFrames();
  assert.ok(find(menu, 'shell-program-editor.desktop'));
  f.shell.showApplications(2);
  old(event('click', { currentTarget: category }));
  const next = f.created.findLast(window => !window.closed && window.document.getElementById('shell-all-programs'));
  assert.ok(next !== menu && menu.closed);
  find(next, 'shell-all-programs').focus(); key(next, 'ArrowRight'); f.flushFrames();
  assert.ok(find(next, 'shell-program-editor.desktop'));
  assert.ok(find(next, 'shell-program-categories'), 'a replacement RootMenu starts with flat All Programs');
}, categorizedPrograms);

test('Programs source folders qualify exact native suffix mappings without inferring directories from IDs', () => {
  const source = (id, path) => Object.freeze({ id, path });
  const first = source('a-b-editor.desktop', '/arbitrary/root/a/b-editor.desktop');
  const moved = source(first.id, '/another-root/a-b/editor.desktop');
  const unicode = source('\u5de5\u5177-\u6587\u6863-my-editor.desktop', '/user-selected/applications/\u5de5\u5177/\u6587\u6863/my-editor.desktop');
  const sibling = source('a-tools-helper.desktop', '/independent-root/a/tools/helper.desktop');
  const flat = source('flat-tool.desktop', '/root-with-hyphen/flat-tool.desktop');
  const entries = Object.freeze([first, unicode, sibling, flat]);
  assert.equal(programSourcePath(first), 'a/b-editor.desktop');
  assert.equal(programSourcePath(moved), 'a-b/editor.desktop', 'slash-to-dash preserves identity when a source changes folders');
  assert.equal(programSourcePath(unicode), '\u5de5\u5177/\u6587\u6863/my-editor.desktop');
  assert.equal(programSourcePath(flat), 'flat-tool.desktop');
  assert.deepEqual(programFolderContents(entries).folders.map(item => item.folder), ['a', '\u5de5\u5177']);
  assert.deepEqual(programFolderContents(entries).entries, [flat], 'a hyphenated filename is not a directory');
  assert.deepEqual(programFolderContents(entries, 'a').folders.map(item => item.folder), ['a/tools']);
  assert.deepEqual(programFolderContents(entries, 'a').entries, [first]);
  assert.deepEqual(programFolderContents(entries, 'a/tools').entries, [sibling]);
  assert.equal(programFolderContents([flat]).exists, false, 'flat qualified records alone do not create a folders entry');
  assert.equal(programFolderContents(entries, 'absent').exists, false);
  assert.deepEqual(programFolderContents([...entries].reverse()).folders, programFolderContents(entries).folders);
  assert.notEqual(programFolderId('a-b'), programFolderId('a/b'));
  assert.notEqual(programFolderId('Source folders'), programCategoryId('Source folders'));
  assert.notEqual(programFolderId('x.desktop'), 'shell-program-source-folder-x.desktop',
    'folder command IDs contain a slash that qualified desktop application IDs cannot contain');
  for (const entry of [
    source(first.id, '/apps/not/a/b-editor.desktop.extra'), source(first.id, '/apps/xa/b-editor.desktop'),
    source(first.id, 'apps/a/b-editor.desktop'), source(first.id, '/apps/../a/b-editor.desktop'),
    source(first.id, '/apps/./a/b-editor.desktop'), source(first.id, '/apps//a/b-editor.desktop'),
    source(first.id, '/apps/a\\b-editor.desktop'), source(first.id, '/apps/\0/a/b-editor.desktop'),
    source(first.id, '/apps/\ud800/a/b-editor.desktop'), source('a-.desktop', '/apps/a/.desktop'),
    source('bundle:a-b-editor.desktop', '/apps/bundle:a/b-editor.desktop'),
    { id: 'org.pollyui.settings' }, source('unqualified.desktop', '/apps/other.desktop'),
  ]) assert.equal(programSourcePath(entry), null, 'unqualified paths are excluded instead of guessed');
  const file = entry => ({ ...entry, contents: '[Desktop Entry]\nType=Application\nName=Editor\nExec=editor\n' });
  const final = applicationCatalog([file(moved), file(first)]);
  assert.equal(final.length, 1);
  assert.deepEqual(programFolderContents(final).folders.map(item => item.folder), ['a-b'],
    'only the winning override registration supplies the folder source');
});

function sourcePrograms({ native, state }) {
  state.windows = [];
  state.sourceFiles = [
    { id: 'a-b-editor.desktop', path: '/apps/a/b-editor.desktop', name: 'Editor', tags: ['Source folders'] },
    { id: 'a-sub-view.desktop', path: '/other-root/a/sub/view.desktop', name: 'Viewer', tags: ['Utility'] },
    { id: 'a-one.desktop', path: '/another-root/a/one.desktop', name: 'Another', tags: [] },
    { id: 'top.desktop', path: '/custom-root/top.desktop', name: 'Top-level', tags: [] },
    { id: 'orphan.desktop', path: '/unqualified/something-else.desktop', name: 'Unqualified source', tags: [] },
  ];
  native.applicationFiles = () => {
    if (state.sourceReadFailed) throw new Error('fixture source catalog read failed');
    return state.sourceFiles.map(entry => ({ id: entry.id, path: entry.path,
      contents: '[Desktop Entry]\nType=Application\nName=' + entry.name + '\nExec=fixture\nCategories=' +
        entry.tags.join(';') + ';\n' }));
  };
}
function openSources(f, theme = 'server2003') {
  f.shell.selectTheme(theme);
  const menu = f.shell.showApplications(1);
  find(menu, 'shell-all-programs').focus(); key(menu, 'ArrowRight'); f.flushFrames();
  click(find(menu, 'shell-program-categories')); f.flushFrames();
  click(find(menu, 'shell-program-source-folders')); f.flushFrames();
  return menu;
}

scenario('Programs sources: Classic and XP browse direct folders and apps, retain All apps, and return through every parent', f => {
  f.state.sourceFiles.push(
    { id: 'x.desktop-child.desktop', path: '/apps/x.desktop/child.desktop', name: 'Nested child', tags: [] },
    { id: 'source-folder-x.desktop', path: '/apps/source-folder-x.desktop', name: 'Root application', tags: [] });
  assert.equal(programSourcePath(f.state.sourceFiles.at(-2)), 'x.desktop/child.desktop');
  assert.equal(programSourcePath(f.state.sourceFiles.at(-1)), 'source-folder-x.desktop');
  for (const theme of ['server2003', 'xp']) {
    const menu = openSources(f, theme), search = find(menu, 'shell-app-search');
    assert.ok(find(menu, programFolderId('a')));
    assert.ok(find(menu, 'shell-program-top.desktop'));
    assert.equal(menu.document.getElementById('shell-program-a-b-editor.desktop'), null, 'root does not flatten nested sources');
    assert.equal(menu.document.getElementById('shell-program-orphan.desktop'), null, 'unqualified source is not invented in this tree');
    find(menu, programFolderId('a')).focus(); key(menu, 'ArrowRight'); f.flushFrames();
    assert.ok(find(menu, 'shell-program-a-b-editor.desktop'));
    assert.ok(find(menu, 'shell-program-a-one.desktop'), 'different real roots merge the same relative source folder');
    assert.ok(find(menu, programFolderId('a/sub')));
    assert.equal(menu.document.getElementById('shell-program-a-sub-view.desktop'), null);
    click(find(menu, programFolderId('a/sub'))); f.flushFrames();
    assert.ok(find(menu, 'shell-program-a-sub-view.desktop'));
    click(find(menu, 'shell-program-pin-a-sub-view.desktop')); f.flushFrames();
    assert.deepEqual(f.saved.snapshot.desktop.shortcuts.map(item => item.id), ['a-sub-view.desktop']);
    assert.deepEqual(f.saved.snapshot.launchers.applications, [], 'source-tree Pin is still desktop-only');
    key(menu, 'Escape'); f.flushFrames();
    assert.ok(menu.document.activeElement === find(menu, programFolderId('a/sub')));
    key(menu, 'ArrowLeft'); f.flushFrames();
    assert.ok(menu.document.activeElement === find(menu, programFolderId('a')));
    click(find(menu, 'shell-program-back')); f.flushFrames();
    assert.ok(find(menu, 'shell-program-source-folders'));
    assert.ok(find(menu, programCategoryId('Source folders')), 'same-named tag has a separate exact metadata command');
    key(menu, 'Escape'); f.flushFrames();
    assert.ok(find(menu, 'shell-program-orphan.desktop'), 'All apps retains unqualified registrations');
    key(menu, 'Escape'); f.flushFrames();
    assert.ok(menu.document.activeElement === find(menu, 'shell-all-programs'));
    assert.ok(find(menu, 'shell-app-search') === search);
    find(menu, 'shell-all-programs').focus(); key(menu, 'ArrowRight'); f.flushFrames();
    click(find(menu, 'shell-program-categories')); f.flushFrames();
    click(find(menu, programCategoryId('Source folders'))); f.flushFrames();
    assert.ok(find(menu, 'shell-program-a-b-editor.desktop'), 'literal tag remains a normal category, not the directory tree');
    click(find(menu, 'shell-program-all')); f.flushFrames();
    assert.ok(find(menu, 'shell-program-orphan.desktop'));
    click(find(menu, 'shell-program-categories')); f.flushFrames();
    click(find(menu, 'shell-program-source-folders')); f.flushFrames();
    const folder = find(menu, programFolderId('x.desktop'));
    const rootApp = find(menu, 'shell-program-source-folder-x.desktop');
    assert.ok(folder !== rootApp && folder.parentNode === rootApp.parentNode,
      'qualified source folder and previously colliding root application coexist');
    const beforeLaunch = f.calls.filter(call => call[0] === 'launch').length;
    press(folder);
    click(find(menu, 'shell-app-refresh')); f.flushFrames();
    assert.ok(find(menu, programFolderId('x.desktop')) === folder, 'refresh retains the held directory command');
    domEvent(folder, 'mouseup'); domEvent(folder, 'click'); f.flushFrames();
    assert.ok(find(menu, 'shell-program-x.desktop-child.desktop'));
    assert.equal(menu.document.getElementById(rootApp.id), null, 'directory activation enters only its direct child view');
    assert.equal(f.calls.filter(call => call[0] === 'launch').length, beforeLaunch);
    key(menu, 'ArrowLeft'); f.flushFrames();
    click(find(menu, 'shell-program-source-folder-x.desktop'));
    assert.equal(f.calls.filter(call => call[0] === 'launch').length, beforeLaunch + 1,
      'root application activation launches once instead of entering the same-named folder');
    assert.equal(f.calls.filter(call => call[0] === 'launch').at(-1)[3], 'source-folder-x.desktop');
    assert.equal(menu.closed, true);
    f.saved.update({ desktop: { version: 1, shortcuts: [] } });
  }
}, sourcePrograms);

scenario('Programs sources: fresh path moves, navigation epochs and catalog read failures reject stale direct-source actions', f => {
  const menu = openSources(f), snapshots = [];
  click(find(menu, programFolderId('a'))); f.flushFrames();
  const row = find(menu, 'shell-program-a-b-editor.desktop'), pin = find(menu, 'shell-program-pin-a-b-editor.desktop');
  const oldLaunch = callback(row, 'click'), oldPin = callback(pin, 'click');
  press(row);
  f.state.sourceFiles[0].path = '/apps/a-b/editor.desktop';
  assert.equal(oldLaunch(event('click', { currentTarget: row })), false, 'same native ID has moved to another qualified folder');
  assert.equal(oldPin(event('click', { currentTarget: pin })), false);
  assert.equal(programSourcePath(f.state.sourceFiles[0]), 'a-b/editor.desktop');
  assert.equal(menu.document.getElementById('shell-program-a-b-editor.desktop'), null);
  assert.ok(find(menu, 'shell-program-a-one.desktop'));
  assert.deepEqual(f.saved.snapshot.desktop.shortcuts, []);
  assert.equal(f.calls.some(call => call[0] === 'launch'), false);
  key(menu, 'ArrowLeft'); f.flushFrames();
  const folder = find(menu, programFolderId('a-b')), oldFolder = callback(folder, 'click');
  f.state.sourceReadFailed = true;
  assert.equal(oldFolder(event('click', { currentTarget: folder })), false);
  f.expectedWarnings.push('[shell] ' + f.shell.getState().error);
  assert.match(f.shell.getState().error, /source catalog read failed/);
  assert.ok(find(menu, programFolderId('a-b')), 'read failure retains the current source index without entering it');
  f.state.sourceReadFailed = false;
  click(find(menu, programFolderId('a-b'))); f.flushFrames();
  const moved = find(menu, 'shell-program-a-b-editor.desktop'), movedLaunch = callback(moved, 'click'),
    movedPin = callback(find(menu, 'shell-program-pin-a-b-editor.desktop'), 'click');
  f.state.sourceReadFailed = true;
  snapshots.push(f.saved.snapshot);
  press(moved);
  assert.equal(movedLaunch(event('click', { currentTarget: moved })), false);
  f.expectedWarnings.push('[shell] ' + f.shell.getState().error);
  assert.equal(movedPin(event('click')), false);
  f.expectedWarnings.push('[shell] ' + f.shell.getState().error);
  assert.ok(f.saved.snapshot === snapshots[0], 'no preferences publish while fresh membership is unavailable');
  assert.equal(f.calls.some(call => call[0] === 'launch'), false);
  const retainedError = f.shell.getState().error;
  key(menu, 'Escape'); f.flushFrames();
  assert.ok(find(menu, programFolderId('a-b')), 'Escape returns to the known source root while reads still fail');
  oldFolder(event('click'));
  assert.equal(menu.document.getElementById('shell-program-a-b-editor.desktop'), null, 'old directory epoch cannot reenter a leaf');
  key(menu, 'ArrowLeft'); f.flushFrames();
  assert.ok(find(menu, 'shell-program-source-folders'), 'Back reaches the category index without reading the failed catalog');
  key(menu, 'Escape'); f.flushFrames();
  assert.ok(find(menu, 'shell-program-orphan.desktop'), 'another Back reaches retained All apps');
  assert.equal(f.shell.getState().error, retainedError, 'retreat does not clear or suppress the catalog failure');
  assert.ok(f.saved.snapshot === snapshots[0]);
  assert.equal(f.calls.some(call => call[0] === 'launch'), false);
  f.state.sourceReadFailed = false;
  click(find(menu, 'shell-program-categories')); f.flushFrames();
  click(find(menu, 'shell-program-source-folders')); f.flushFrames();
  click(find(menu, programFolderId('a-b'))); f.flushFrames();
  oldLaunch(event('click', { currentTarget: row }));
  movedLaunch(event('click', { currentTarget: moved }));
  assert.equal(f.calls.some(call => call[0] === 'launch'), false, 'returning to the same leaf does not revive callbacks');
  click(find(menu, 'shell-program-a-b-editor.desktop'));
  assert.equal(f.calls.filter(call => call[0] === 'launch').length, 1);
  assert.equal(menu.closed, true);
}, sourcePrograms);

scenario('Programs sources: removed folders keep a safe empty view and stale folder gestures never become app commands', f => {
  const menu = openSources(f), branch = find(menu, programFolderId('a')), oldBranch = callback(branch, 'click');
  press(branch);
  click(find(menu, 'shell-program-all')); f.flushFrames();
  domEvent(branch, 'mouseup'); domEvent(branch, 'click');
  assert.equal(f.calls.some(call => call[0] === 'launch'), false);
  oldBranch(event('click'));
  assert.ok(find(menu, 'shell-program-orphan.desktop'));
  click(find(menu, 'shell-program-categories')); f.flushFrames();
  click(find(menu, 'shell-program-source-folders')); f.flushFrames();
  click(find(menu, programFolderId('a'))); f.flushFrames();
  click(find(menu, programFolderId('a/sub'))); f.flushFrames();
  f.state.sourceFiles = f.state.sourceFiles.filter(entry => !entry.id.startsWith('a-'));
  click(find(menu, 'shell-app-refresh')); f.flushFrames();
  assert.match(text(find(menu, 'shell-program-list')), /No applications or subfolders in this source folder/);
  key(menu, 'Escape'); f.flushFrames();
  assert.match(find(menu, 'shell-program-menu').getAttribute('aria-label'), /source folders: a$/);
  key(menu, 'ArrowLeft'); f.flushFrames();
  assert.ok(find(menu, 'shell-program-top.desktop'));
  key(menu, 'Escape'); f.flushFrames();
  assert.equal(menu.document.getElementById('shell-program-source-folders'), null, 'no qualified nested registrations means no entry');
  click(find(menu, 'shell-program-all')); f.flushFrames();
  assert.ok(find(menu, 'shell-program-orphan.desktop'));
  f.shell.showApplications(2);
  oldBranch(event('click'));
  assert.equal(menu.closed, true);
  assert.equal(f.calls.some(call => call[0] === 'launch'), false);
}, sourcePrograms);

scenario('XP Programs: real catalog and categories reuse bounded RootMenu navigation while search and both pin domains stay independent', f => {
  f.shell.selectTheme('xp');
  const menu = f.shell.showApplications(1), search = find(menu, 'shell-app-search');
  assert.ok(find(menu, 'shell-app-launcher-editor.desktop'));
  const trigger = find(menu, 'shell-all-programs');
  trigger.focus(); key(menu, 'ArrowRight'); f.flushFrames();
  const composingFocus = menu.document.activeElement;
  for (const name of ['ArrowDown', 'Home', 'End', 'ArrowLeft', 'Escape']) {
    assert.equal(key(menu, name, { isComposing: true }).defaultPrevented, false);
    assert.ok(menu.document.activeElement === composingFocus);
    assert.ok(menu.document.getElementById('shell-program-overlay'), 'Composing navigation leaves Programs open');
    assert.equal(menu.closed, false);
  }
  assert.ok(find(menu, 'shell-program-editor.desktop'));
  assert.ok(find(menu, 'shell-program-categories'));
  click(find(menu, 'shell-program-categories')); f.flushFrames();
  click(find(menu, programCategoryId('\u6587\u6863'))); f.flushFrames();
  assert.ok(find(menu, 'shell-program-editor.desktop'));
  assert.equal(menu.document.getElementById('shell-program-plain.desktop'), null);
  click(find(menu, 'shell-program-pin-editor.desktop')); f.flushFrames();
  assert.deepEqual(f.saved.snapshot.desktop.shortcuts.map(item => item.id), ['editor.desktop']);
  assert.deepEqual(f.saved.snapshot.launchers.applications, [], 'Programs Pin remains desktop-only');
  key(menu, 'Escape'); f.flushFrames();
  assert.ok(menu.document.activeElement === find(menu, programCategoryId('\u6587\u6863')));
  key(menu, 'ArrowLeft'); f.flushFrames();
  assert.ok(find(menu, 'shell-program-plain.desktop'), 'category index Back returns to flat All Programs');
  key(menu, 'Escape'); f.flushFrames();
  assert.ok(menu.document.activeElement === trigger && !menu.closed);
  assert.ok(find(menu, 'shell-app-search') === search, 'real input is not replaced or relabeled as a menu command');
  click(find(menu, 'shell-app-launcher-editor.desktop'));
  assert.deepEqual(f.saved.snapshot.launchers.applications, ['editor.desktop']);
  assert.deepEqual(f.saved.snapshot.desktop.shortcuts.map(item => item.id), ['editor.desktop']);
}, categorizedPrograms);

scenario('XP Programs: old leaf handlers reject changed membership and epochs, then fresh activation uses only its real entry', f => {
  f.shell.selectTheme('xp');
  const menu = f.shell.showApplications(1);
  find(menu, 'shell-all-programs').focus(); key(menu, 'ArrowRight'); f.flushFrames();
  browseCategory(f, menu, '\u6587\u6863');
  const row = find(menu, 'shell-program-editor.desktop'), old = callback(row, 'click');
  f.state.categoryFiles[0].tags = ['Utility'];
  assert.equal(old(event('click', { currentTarget: row })), false);
  assert.equal(f.calls.some(call => call[0] === 'launch'), false);
  key(menu, 'Escape'); f.flushFrames();
  click(find(menu, 'shell-program-all')); f.flushFrames();
  old(event('click', { currentTarget: row }));
  assert.equal(f.calls.some(call => call[0] === 'launch'), false);
  click(find(menu, 'shell-program-editor.desktop'));
  assert.equal(f.calls.filter(call => call[0] === 'launch').length, 1);
  assert.equal(menu.closed, true);
  old(event('click', { currentTarget: row }));
  assert.equal(f.calls.filter(call => call[0] === 'launch').length, 1);
}, categorizedPrograms);

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
  assert.equal(find(menu, 'shell-app-search').childNodes[1].firstChild.textContent, 'fix');
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
  assert.equal(key(menu, 'Escape', { isComposing: true }).defaultPrevented, false);
  assert.equal(menu.closed, false, 'An unconsumed composing Escape must not dismiss the RootMenu');
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
  const oldSearch = find(first, 'shell-app-search').listeners.get('textinput').at(-1);
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
  assert.equal(find(next, 'shell-app-search').childNodes[1].firstChild.textContent, '');
  assert.equal(find(next, 'shell-app-search-slot').lastChild.firstChild.textContent, 'Search applications');
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

scenario('application search retains native editing, bounded paste, composition and retired input guards', f => {
  const menu = f.shell.showApplications(1), field = find(menu, 'shell-app-search');
  const text = () => field.childNodes[1].firstChild.textContent;
  const previousClipboard = globalThis.clipboard;
  let clipboardText = '';
  globalThis.clipboard = { readText: () => clipboardText, writeText: value => { clipboardText = value; } };
  try {
    const hint = find(menu, 'shell-app-search-hint');
    domEvent(field, 'compositionstart');
    domEvent(field, 'compositionupdate', { data: 'preedit', selectionStart: 3 });
    assert.equal(hint.style.display, 'none', 'Empty committed query hides its placeholder during preedit');
    domEvent(field, 'compositionend');
    assert.equal(hint.style.display, 'flex', 'Cancelling an empty composition restores the placeholder');
    domEvent(field, 'textinput', { data: 'Fxiture' });
    key(menu, 'Home'); key(menu, 'ArrowRight'); key(menu, 'Delete'); key(menu, 'ArrowRight');
    domEvent(field, 'textinput', { data: 'x' });
    assert.equal(text(), 'Fixture', 'Delete and insertion edit at the caret instead of appending');
    key(menu, 'Home'); key(menu, 'ArrowRight', { shiftKey: true });
    const selection = field.firstChild.childNodes.map(node => ({ ...node.style }));
    click(find(menu, 'shell-app-refresh'));
    assert.ok(find(menu, 'shell-app-search') === field);
    field.focus();
    assert.deepEqual(field.firstChild.childNodes.map(node => ({ ...node.style })), selection);
    clipboardText = 'F';
    key(menu, 'v', { ctrlKey: true });
    assert.equal(text(), 'Fixture', 'Pasting replaces the retained selection');
    key(menu, 'Home'); key(menu, 'ArrowRight');
    clipboardText = 'x'.repeat(200);
    key(menu, 'v', { ctrlKey: true });
    assert.equal(text(), 'F' + 'x'.repeat(121) + 'ixture', 'Overlong middle paste preserves the suffix within 128 code points');
    key(menu, 'Delete');
    assert.equal(text(), 'F' + 'x'.repeat(121) + 'xture', 'Paste leaves the caret immediately before the preserved suffix');
    key(menu, 'a', { ctrlKey: true }); clipboardText = 'Fixture'; key(menu, 'v', { metaKey: true });
    domEvent(field, 'compositionstart');
    domEvent(field, 'compositionupdate', { data: 'input-method preedit', selectionStart: 3 });
    key(menu, 'Enter');
    assert.equal(f.calls.some(call => call[0] === 'launch'), false, 'Actual composition blocks launching even without an event flag');
    domEvent(field, 'compositionend');
    key(menu, 'Enter', { isComposing: true });
    key(menu, 'Enter', { repeat: true });
    assert.equal(menu.closed, false);
    const retired = field.listeners.get('keydown').at(-1);
    key(menu, 'Enter');
    assert.equal(f.calls.filter(call => call[0] === 'launch').length, 1);
    const next = f.shell.showApplications(2);
    retired(event('keydown', { key: 'Enter' }));
    assert.equal(f.calls.filter(call => call[0] === 'launch').length, 1);
    assert.equal(next.closed, false);
    assert.equal(text(), '', 'Closing clears the owned search input');
  } finally {
    if (previousClipboard === undefined) delete globalThis.clipboard;
    else globalThis.clipboard = previousClipboard;
  }
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
  for (const name of ['Escape', 'Enter']) {
    assert.equal(key(replacement, name, { isComposing: true }).defaultPrevented, false);
    assert.equal(replacement.closed, false);
    assert.equal(f.state.output.pendingToken, 2, 'Composing keys cannot Keep or Revert a trusted display transaction');
  }
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
