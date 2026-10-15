import assert from 'node:assert/strict';

const descendants = node => [node, ...node.childNodes.flatMap(descendants)];
class Node {
  constructor(ownerDocument, type = 'view') {
    Object.assign(this, { ownerDocument, type, childNodes: [], parentNode: null, style: {},
      attributes: new Map(), listeners: new Map(), id: '', tabIndex: -1, value: '',
      scrollTop: 0, scrollLeft: 0, offsetWidth: 900, offsetHeight: 640, offsetTop: 0, offsetLeft: 0 });
  }
  get firstChild() { return this.childNodes[0] || null; }
  get textContent() { return this.type === '#text' ? this.value : this.childNodes.map(node => node.textContent).join(''); }
  set textContent(value) { this.value = String(value); this.childNodes = []; }
  appendChild(node) { return this.insertBefore(node, null); }
  insertBefore(node, before) {
    node.parentNode?.removeChild(node);
    const index = before ? this.childNodes.indexOf(before) : this.childNodes.length;
    assert.ok(index >= 0);
    const adopt = child => { child.ownerDocument = this.ownerDocument; child.childNodes.forEach(adopt); };
    adopt(node); this.childNodes.splice(index, 0, node); node.parentNode = this; return node;
  }
  removeChild(node) {
    const index = this.childNodes.indexOf(node); assert.ok(index >= 0);
    if (descendants(node).includes(this.ownerDocument.activeElement)) this.ownerDocument.activeElement.blur();
    this.childNodes.splice(index, 1); node.parentNode = null; return node;
  }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  removeAttribute(key) { this.attributes.delete(key); }
  querySelector(selector) {
    assert.match(selector, /^\.[a-zA-Z][\w-]*$/);
    return descendants(this).slice(1).find(node =>
      (node.className || '').split(/\s+/).includes(selector.slice(1))) || null;
  }
  addEventListener(type, callback) {
    this.listeners.set(type, [...(this.listeners.get(type) || []), callback]);
  }
  removeEventListener(type, callback) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter(value => value !== callback));
  }
  focus() {
    if (this.ownerDocument.activeElement === this) return;
    this.ownerDocument.activeElement?.blur(); this.ownerDocument.activeElement = this;
    for (const callback of this.listeners.get('focus') || []) callback({ target: this, currentTarget: this });
  }
  blur() {
    if (this.ownerDocument.activeElement !== this) return;
    this.ownerDocument.activeElement = null;
    for (const callback of this.listeners.get('blur') || []) callback({ target: this, currentTarget: this });
  }
  setInputMethod() {}
  cancelComposition() {}
  getBoundingClientRect() { return { x: this.offsetLeft, y: this.offsetTop, width: this.offsetWidth, height: this.offsetHeight }; }
}
function document() {
  const doc = {
    activeElement: null,
    createElement: type => new Node(doc, type),
    createTextNode: value => Object.assign(new Node(doc, '#text'), { value: String(value) }),
    getElementById: id => descendants(doc.body).find(node => node.id === id) || null,
  };
  doc.body = new Node(doc); return doc;
}
export function applicationHost(t) {
  const previous = { document: globalThis.document, measureText: globalThis.measureText };
  globalThis.document = document(); globalThis.measureText = value => String(value).length * 7;
  const windows = [];
  t.after(() => { Object.assign(globalThis, previous); });
  return { windows, create(options) {
    const surface = { ...options, document: document(), closed: false,
      close() { if (!this.closed) { this.closed = true; this.onclose?.(); } } };
    windows.push(surface); return surface;
  }, close() {} };
}
export async function deliver(node, type = 'click', extra = {}) {
  assert.ok(node, 'Expected a rendered application control');
  const event = { type, target: node, currentTarget: node, key: '', button: 0,
    preventDefault() {}, stopPropagation() {}, ...extra };
  for (const callback of [...(node.listeners.get(type) || [])]) await callback(event);
}
