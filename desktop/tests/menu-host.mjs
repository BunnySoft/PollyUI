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

function fixture() {
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
function scenario(name, run) {
  test(name, () => {
    const f = fixture();
    try { run(f); } finally { f.done(); }
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

scenario('pointer toggles retain their existing close behavior and different controls replace menus', f => {
  const panel = f.surface('panel');
  click(find(panel, 'shell-menu'));
  const first = f.created.at(-1);
  assert.ok(find(first, 'shell-applications'));
  click(find(panel, 'shell-menu').firstChild);
  assert.equal(first.closed, true);
  assert.ok(f.created.at(-1) === first, 'same opener must not close on press then reopen on click');
  click(find(panel, 'shell-panel-settings'));
  const appearance = f.created.at(-1);
  click(find(panel, 'shell-menu'));
  assert.equal(appearance.closed, true);
  assert.ok(find(f.created.at(-1), 'shell-applications'));
  const applications = f.created.at(-1);
  click(find(f.surface('panel', 2), 'shell-menu'));
  assert.equal(applications.closed, true);
  assert.equal(f.created.at(-1).options.output, 2);
  assert.equal(f.shell.selectTheme('bigsur'), true);
  const dock = f.surface('dock');
  for (const id of ['shell-dock-applications', 'shell-dock-settings', 'shell-dock-about']) {
    click(find(dock, id));
    const current = f.created.at(-1);
    click(find(dock, id));
    assert.equal(current.closed, true);
    assert.ok(f.created.at(-1) === current);
  }
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
