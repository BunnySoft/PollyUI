import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
register('../../desktop/tests/root-loader.mjs', import.meta.url);
const { createVerticalScrollbar, verticalScrollMetrics } = await import('../sdk/js/scrollbar.mjs');
const { scrollbarAppearance, scrollbarStyles } = await import('../sdk/js/scrollbar-appearance.mjs');

function fixture() {
  const doc = { activeElement: null, captured: null, styleWrites: 0, attributeWrites: 0, createElement: () => new Node() };
  class Node {
    constructor() {
      const style = new Proxy({}, { set(target, key, value) { doc.styleWrites++; target[key] = value; return true; } });
      Object.assign(this, { ownerDocument: doc, style, attributes: new Map(), listeners: new Map(),
        parentNode: null, childNodes: [], tabIndex: -1, offsetTop: 20, offsetLeft: 330,
        offsetWidth: 16, offsetHeight: 200, scrollTop: 0 });
    }
    get firstChild() { return this.childNodes[0] ?? null; }
    insertBefore(node, before) {
      const index = before ? this.childNodes.indexOf(before) : this.childNodes.length;
      this.childNodes.splice(index, 0, node); node.parentNode = this; return node;
    }
    removeChild(node) { this.childNodes.splice(this.childNodes.indexOf(node), 1); node.parentNode = null; }
    setAttribute(key, value) { doc.attributeWrites++; this.attributes.set(key, String(value)); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    addEventListener(type, fn) {
      const list = this.listeners.get(type) ?? [];
      list.push(fn); this.listeners.set(type, list);
    }
    removeEventListener(type, fn) { this.listeners.set(type, this.listeners.get(type).filter(entry => entry !== fn)); }
    getBoundingClientRect() { return { x: this.offsetLeft, y: this.offsetTop, width: this.offsetWidth, height: this.offsetHeight }; }
    focus() {
      const previous = doc.activeElement;
      if (previous === this) return;
      if (previous) fire(previous, 'blur');
      doc.activeElement = this; fire(this, 'focus');
    }
    setMouseCapture() { doc.captured = this; }
    releaseMouseCapture() { if (doc.captured === this) { doc.captured = null; fire(this, 'lostmousecapture'); } }
  }
  const viewport = new Node(), track = new Node(), thumb = new Node();
  viewport.childNodes = [{ offsetTop: 20, offsetHeight: 4200 }];
  Object.assign(track.style, { width: '10', opacity: '0', backgroundColor: '#123456' });
  Object.assign(thumb.style, { left: '2', width: '6', backgroundColor: '#654321' });
  track.insertBefore(thumb, null);
  return { viewport, track, thumb, doc };
}
function fire(node, type, extra = {}) {
  const event = { currentTarget: node, target: node, button: 0, clientX: 338, clientY: 25,
    preventDefault() {}, stopPropagation() {}, ...extra };
  for (const fn of [...(node.listeners.get(type) ?? [])]) fn(event);
}

test('legacy geometry, 28px minimum, page/42px key step and capture path remain unchanged', () => {
  const f = fixture(), controller = createVerticalScrollbar(f);
  assert.deepEqual(controller.update(), { height: 200, content: 4200, maximum: 4000,
    value: 0, thumbHeight: 28, travel: 172, top: 0 });
  assert.equal(f.track.childNodes.length, 1);
  fire(f.track, 'keydown', { key: 'ArrowDown' }); assert.equal(f.viewport.scrollTop, 42);
  fire(f.track, 'keydown', { key: 'End' }); assert.equal(f.viewport.scrollTop, 4000);
  fire(f.track, 'keydown', { key: 'Home' });
  fire(f.track, 'mousedown'); assert.equal(f.doc.captured, f.track);
  fire(f.track, 'mousemove', { clientY: 1000 }); assert.equal(f.viewport.scrollTop, 4000);
  fire(f.track, 'mouseup', { clientY: 1000 }); assert.equal(f.doc.captured, null);
  fire(f.track, 'keydown', { key: 'Home' });
  fire(f.track, 'mousedown', { clientY: 180 }); assert.equal(f.viewport.scrollTop, 200);
  controller.stop();
  assert.ok([...f.track.listeners.values()].every(list => list.length === 0));
});

test('appearance validation rejects unknown fields, geometry overrides and invalid callbacks explicitly', () => {
  assert.equal(scrollbarAppearance(undefined), null);
  for (const value of [null, [], { theme: 'desktop' }, { metrics: [] }, { metrics: { rows: 3 } },
    { paint: true }, { decorate: 3 }]) assert.throws(() => scrollbarAppearance(value), TypeError);
  for (const metrics of [{ width: NaN }, { stepSize: 0 }, { arrowSize: -1 }, { minThumbHeight: Infinity },
    { width: 8, thumbInset: 4 }]) assert.throws(() => scrollbarAppearance({ metrics }), RangeError);
  for (const value of [null, [], { viewport: {} }, { thumb: { top: 10 } }, { thumb: { opacity: NaN } }])
    assert.throws(() => scrollbarStyles(value, {}), TypeError);
  assert.throws(() => verticalScrollMetrics(fixture().viewport, 200, { startInset: -1 }), RangeError);
});

test('one controller owns arrow steps, held/drag/focus states and idle-paint deduplication', () => {
  const f = fixture(), states = [];
  const appearance = { metrics: { width: 16, thumbInset: 1, arrowSize: 16, stepSize: 17 },
    paint(state) { states.push(state); return { thumb: { backgroundColor: state.held ? '#ff0000' : '#00ff00' } }; } };
  const controller = createVerticalScrollbar({ ...f, appearance });
  assert.equal(controller.update().top, 16);
  assert.equal(Number(f.thumb.style.height), 28);
  const count = states.length;
  const writes = [f.doc.styleWrites, f.doc.attributeWrites];
  for (let i = 0; i < 20; i++) controller.update();
  controller.setAppearance(appearance);
  assert.equal(states.length, count, 'unchanged caller update is not a paint notification');
  assert.deepEqual([f.doc.styleWrites, f.doc.attributeWrites], writes, 'idle updates do not write styles or attributes either');
  fire(f.track, 'mousedown', { clientY: 212 });
  assert.equal(f.viewport.scrollTop, 17);
  assert.equal(states.at(-1).held, 'increment'); assert.equal(f.doc.captured, null);
  fire(f.track, 'mouseup');
  fire(f.track, 'keydown', { key: 'ArrowDown' }); assert.equal(f.viewport.scrollTop, 34);
  controller.step(-1); assert.equal(f.viewport.scrollTop, 17);
  fire(f.track, 'keydown', { key: 'Home' });
  fire(f.track, 'mousedown', { clientY: 40 });
  assert.equal(f.doc.captured, f.track); assert.equal(states.at(-1).dragging, true);
  const originalTrack = f.track, originalThumb = f.thumb;
  controller.setAppearance({ ...appearance, metrics: { ...appearance.metrics, arrowSize: 0 } });
  assert.equal(f.track, originalTrack); assert.equal(f.thumb, originalThumb);
  assert.equal(f.doc.captured, f.track, 'retheme is not a second gesture owner or forced cancellation');
  fire(f.track, 'mousemove', { clientY: 900 }); assert.equal(f.viewport.scrollTop, 4000);
  fire(f.track, 'blur');
  assert.equal(f.doc.captured, null);
  assert.equal(states.at(-1).focused, false); assert.equal(states.at(-1).held, null);
  controller.stop();
});

test('overflow truth, tiny tracks, resize clamp, cancellation, opt-out and stop are bounded', () => {
  const f = fixture(); let current = true, decorated = 0, cleaned = 0;
  const appearance = { metrics: { width: 16, thumbInset: 1, arrowSize: 16 },
    decorate() { decorated++; return () => cleaned++; }, paint: () => ({ thumb: { backgroundColor: '#abcdef' } }) };
  const controller = createVerticalScrollbar({ ...f, isCurrent: () => current, appearance });
  f.track.offsetHeight = f.viewport.offsetHeight = 12;
  assert.equal(controller.update().thumbHeight, 0);
  assert.equal(f.thumb.style.display, 'none');
  assert.equal(f.track.getAttribute('aria-disabled'), 'false', 'arrows still scroll actual overflow when no thumb travel fits');
  fire(f.track, 'mousedown', { clientY: 29 }); assert.equal(f.viewport.scrollTop, 42);
  fire(f.track, 'mouseup');
  f.track.offsetHeight = f.viewport.offsetHeight = 200; controller.update();
  fire(f.track, 'keydown', { key: 'Home' }); fire(f.track, 'mousedown', { clientY: 40 });
  current = false; controller.update();
  assert.equal(f.doc.captured, null); assert.equal(f.track.style.opacity, '0');
  fire(f.track, 'mousemove', { clientY: 900 }); assert.equal(f.viewport.scrollTop, 0);
  current = true; f.viewport.childNodes[0].offsetHeight = 42; controller.update();
  assert.equal(f.track.getAttribute('aria-disabled'), 'true');
  assert.equal(f.track.tabIndex, -1); assert.equal(f.viewport.scrollTop, 0);
  controller.setAppearance(undefined);
  assert.equal(decorated, 1); assert.equal(cleaned, 1);
  assert.equal(f.track.childNodes.length, 1);
  assert.equal(f.track.style.width, '10'); assert.equal(f.thumb.style.width, '6');
  assert.equal(f.thumb.style.backgroundColor, '#654321');
  controller.stop(); assert.equal(controller.update(), null);
  assert.throws(() => controller.setAppearance(appearance), /stopped/);
  assert.throws(() => controller.step(2), RangeError);
});
