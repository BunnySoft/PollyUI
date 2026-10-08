import assert from 'node:assert/strict';
import { childPath, parentPath } from '../files/model.mjs';

// Explicit in-memory dependencies, not product filesystem or native input proof.
export function fixtureFiles({ overwrite = true } = {}) {
  const records = new Map(), calls = [];
  let serial = 0;
  const error = (code, message = code) => Object.assign(new Error(message), { code });
  function put(path, type = 'file', values = {}) {
    const record = { path, name: path.split('/').at(-1) || '/', type, identity: 'fixture-' + (++serial),
      permissions: '0600', bytes: 0, mtimeMs: 0, uid: 1000, gid: 1000,
      readable: true, writable: true, text: '', ...values };
    records.set(path, record); return record;
  }
  put('/', 'directory'); put('/home', 'directory'); put('/home/polly', 'directory');
  put('/home/polly/Docs', 'directory');
  put('/home/polly/hello.txt', 'file', { text: 'Hello from the injected fixture.' });
  put('/home/polly/space "quoted" \u6587\u4ef6.txt', 'file', { text: 'Unicode fixture.' });
  put('/home/polly/image.png', 'file'); put('/home/polly/special', 'other');
  function get(path) { const record = records.get(path); if (!record) throw error('ENOENT'); return record; }
  const observed = record => { const { text, ...value } = record; return { ...value }; };
  function parent(directory, identity) {
    const value = get(directory);
    if (value.type !== 'directory' || value.identity !== identity) throw error('ESTALE');
    if (!value.writable) throw error('EACCES');
  }
  const files = {
    version: 1, implementation: 'posix-ordinary-v1', maxEntries: 1024, maxTextBytes: 1048576, overwrite,
    locations() { calls.push(['locations']); return { home: '/home/polly', documents: '/home/polly/Docs',
      downloads: '/home/polly/Downloads', desktop: '/home/polly/Desktop' }; },
    listDirectory(path) {
      calls.push(['listDirectory', path]);
      const value = get(path);
      if (value.type !== 'directory' || !value.readable) throw error('EACCES');
      return { version: 1, path, identity: value.identity, complete: true,
        entries: [...records.values()].filter(item => item.path !== path && parentPath(item.path) === path).map(observed) };
    },
    stat(path, follow = false) {
      calls.push(['stat', path, follow]); const value = get(path);
      return observed(follow && value.type === 'symlink' ? get(value.linkTarget) : value);
    },
    readText(path, identity) {
      calls.push(['readText', path, identity]); const value = get(path);
      if (value.identity !== identity) throw error('ESTALE');
      if (value.type !== 'file' || !value.readable) throw error('EACCES');
      return { path, identity, text: value.text };
    },
    writeText(directory, name, text, identity) {
      calls.push(['writeText', directory, name, text, identity]); parent(directory, identity);
      const path = childPath(directory, name);
      if (records.has(path)) throw error('EEXIST');
      return observed(put(path, 'file', { text }));
    },
    replaceText(path, text, expected, directoryIdentity) {
      calls.push(['replaceText', path, text, expected, directoryIdentity]);
      if (!overwrite) throw error('ENOSYS');
      parent(parentPath(path), directoryIdentity);
      const value = get(path);
      if (value.identity !== expected) throw error('ESTALE');
      if (value.type !== 'file' || !value.writable) throw error('EACCES');
      return observed(put(path, 'file', { text }));
    },
    createDirectory() { throw error('TEST_UNEXPECTED_CALL'); },
    rename() { throw error('TEST_UNEXPECTED_CALL'); },
  };
  return { files, calls, records, put, get, error, observed };
}

export const nodes = node => [node, ...node.childNodes.flatMap(nodes)];
class FixtureNode {
  constructor(ownerDocument, type) {
    Object.assign(this, { ownerDocument, type, childNodes: [], parentNode: null, style: {},
      attributes: new Map(), listeners: new Map(), id: '', tabIndex: -1, value: '',
      offsetTop: 0, offsetLeft: 0, offsetWidth: 800, offsetHeight: 600, scrollTop: 0, scrollLeft: 0 });
  }
  get textContent() { return this.type === '#text' ? this.value : this.childNodes.map(node => node.textContent).join(''); }
  set textContent(value) { this.value = String(value); this.childNodes = []; }
  get lastChild() { return this.childNodes.at(-1); }
  appendChild(node) { return this.insertBefore(node, null); }
  insertBefore(node, before) {
    node.parentNode?.removeChild(node);
    const adopt = child => { child.ownerDocument = this.ownerDocument; child.childNodes.forEach(adopt); };
    adopt(node);
    const index = before ? this.childNodes.indexOf(before) : this.childNodes.length;
    assert.ok(index >= 0); this.childNodes.splice(index, 0, node); node.parentNode = this; return node;
  }
  removeChild(node) {
    const index = this.childNodes.indexOf(node); assert.ok(index >= 0);
    this.childNodes.splice(index, 1); node.parentNode = null; return node;
  }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  removeAttribute(key) { this.attributes.delete(key); }
  addEventListener(type, callback) {
    const listeners = this.listeners.get(type) ?? []; listeners.push(callback); this.listeners.set(type, listeners);
  }
  removeEventListener(type, callback) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(value => value !== callback));
  }
  focus() {
    const previous = this.ownerDocument.activeElement;
    if (previous === this) return;
    if (previous) deliver(previous, 'blur', {}, false);
    this.ownerDocument.activeElement = this;
    deliver(this, 'focus', {}, false);
  }
  setInputMethod() {}
  cancelComposition() {}
}
export function fixtureDocument() {
  const doc = { activeElement: null,
    createElement: type => new FixtureNode(doc, type),
    createTextNode: value => Object.assign(new FixtureNode(doc, '#text'), { value: String(value) }),
    getElementById: id => nodes(doc.body).find(node => node.id === id) ?? null };
  doc.body = doc.createElement('view'); return doc;
}
export function fixtureHost(t) {
  const before = { document: globalThis.document, measureText: globalThis.measureText };
  globalThis.document = fixtureDocument();
  globalThis.measureText = (text, size) => Array.from(text).length * size * 0.6;
  const windows = [], host = {
    create(options) {
      const window = { ...options, document: fixtureDocument(), closed: false,
        close() { if (!this.closed) { this.closed = true; this.onclose?.(); } } };
      windows.push(window); return window;
    },
    close() {},
  };
  t.after(() => { windows.forEach(window => window.close()); Object.assign(globalThis, before); });
  return { host, windows };
}
export function deliver(node, type = 'click', extra = {}, bubble = true) {
  assert.ok(node, 'Expected rendered node');
  const event = { type, target: node, currentTarget: node, button: 0, key: '', defaultPrevented: false,
    prevented: false, stopped: false, preventDefault() { this.defaultPrevented = this.prevented = true; },
    stopPropagation() { this.stopped = true; }, ...extra };
  for (let current = node; current; current = bubble && !event.stopped ? current.parentNode : null) {
    event.currentTarget = current;
    for (const callback of [...(current.listeners.get(type) || [])]) callback(event);
  }
  return event;
}
export async function settled() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
