import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
register('../../desktop/tests/root-loader.mjs', import.meta.url);
const target = process.env.SCROLLBAR_CONTRACT_MODULE || new URL('../sdk/js/scrollbar.mjs', import.meta.url).href;
const { createVerticalScrollbar, verticalScrollMetrics } = await import(target);
const { scrollbarAppearance, scrollbarStyles, scrollbarStyleKeys } = await import('../sdk/js/scrollbar-appearance.mjs');

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
    removeAttribute(key) { this.attributes.delete(key); }
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
  fire(f.track, 'wheel', { deltaY: 37 }); assert.equal(f.viewport.scrollTop, 237);
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

test('optional scroll notification reports changed clamped values without constructor, idle or reentrant callbacks', () => {
  const f = fixture(), values = [];
  f.viewport.scrollTop = 9000;
  let controller;
  controller = createVerticalScrollbar({ ...f, appearance: { metrics: { width: 10 } },
    onScroll(value) { values.push(value); controller.update(); } });
  assert.equal(f.viewport.scrollTop, 4000);
  assert.deepEqual(values, [], 'Construction never calls the consumer before it receives its controller');
  controller.update(); controller.update();
  assert.deepEqual(values, []);
  fire(f.track, 'keydown', { key: 'Home' });
  fire(f.track, 'keydown', { key: 'ArrowDown' });
  assert.deepEqual(values, [0, 42]);
  f.viewport.scrollTop = 9000; controller.update();
  assert.deepEqual(values, [0, 42, 4000], 'External changes publish their normalized value once');
  f.viewport.childNodes[0].offsetHeight = 420; controller.update();
  assert.deepEqual(values, [0, 42, 4000, 220], 'Content shrink publishes its actual clamp');
  controller.update(); controller.setAppearance({ metrics: { arrowSize: 16 } });
  assert.equal(values.length, 4, 'Retheme and idle updates are not scroll events');
  const key = f.track.listeners.get('keydown')[0];
  controller.stop();
  key({ key: 'End', preventDefault() {}, stopPropagation() {} }); controller.update();
  assert.equal(values.length, 4, 'Stop retires both live and retained controller callbacks');
  const closing = fixture();
  let closes = 0, owned;
  owned = createVerticalScrollbar({ ...closing, onScroll() { closes++; owned.stop(); } });
  owned.update();
  fire(closing.track, 'keydown', { key: 'End' }); owned.update();
  assert.equal(closes, 1, 'A consumer can stop its controller during synchronous notification');
  assert.ok([...closing.track.listeners.values()].every(list => list.length === 0));
});

test('scroll callback validation precedes mutations and callback failure still releases mouseup capture', () => {
  for (const onScroll of [null, true, 1, 'changed', {}]) {
    const f = fixture(), before = [f.doc.styleWrites, f.doc.attributeWrites];
    assert.throws(() => createVerticalScrollbar({ ...f, onScroll }), TypeError);
    assert.deepEqual([f.doc.styleWrites, f.doc.attributeWrites], before);
    assert.equal(f.track.listeners.size, 0);
    assert.equal(f.track.childNodes.length, 1);
  }
  const f = fixture(), failure = new Error('Consumer scroll failed');
  let calls = 0;
  const controller = createVerticalScrollbar({ ...f, onScroll() { calls++; throw failure; } });
  controller.update(); fire(f.track, 'mousedown');
  assert.equal(f.doc.captured, f.track);
  assert.throws(() => fire(f.track, 'mouseup', { clientY: 150 }), error => error === failure);
  assert.equal(f.doc.captured, null);
  controller.update(); assert.equal(calls, 1, 'An unchanged value does not replay a failed notification');
  controller.stop();
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
  f.track.offsetHeight = 240; controller.update();
  assert.equal(states.length, count + 1, 'actual internal bounds changes notify the existing surface/focus painter once');
  controller.update(); assert.equal(states.length, count + 1, 'the new unchanged bounds are deduplicated too');
  f.track.offsetHeight = 200; controller.update();
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

test('arrow-lane drag has exact no-motion invariance and measured midrange delta mapping', () => {
  const f = fixture(), appearance = { metrics: { arrowSize: 15 } };
  const controller = createVerticalScrollbar({ ...f, appearance });
  f.viewport.scrollTop = 1000;
  const metrics = controller.update(), y = f.track.offsetTop + metrics.top + 7;
  fire(f.track, 'mousedown', { clientY: y });
  fire(f.track, 'mousemove', { clientY: y });
  assert.equal(f.viewport.scrollTop, 1000, 'same-coordinate move must not add the arrow-lane origin');
  fire(f.track, 'mouseup', { clientY: y });
  assert.equal(f.viewport.scrollTop, 1000, 'same-coordinate release must not scroll either');
  fire(f.track, 'mousedown', { clientY: y });
  const delta = 14, expected = 1000 + delta / metrics.travel * metrics.maximum;
  fire(f.track, 'mousemove', { clientY: y + delta });
  assert.equal(f.viewport.scrollTop, expected, 'only the pointer delta maps through measured thumb travel');
  fire(f.track, 'mouseup', { clientY: y + delta });
  assert.equal(f.viewport.scrollTop, expected);
  controller.stop();
});

test('captured retheme and resize reanchor the lane without a no-motion value jump', () => {
  const f = fixture(), controller = createVerticalScrollbar({ ...f, appearance: { metrics: { arrowSize: 15 } } });
  f.viewport.scrollTop = 1000;
  const before = controller.update(), y = f.track.offsetTop + before.top + 7;
  fire(f.track, 'mousedown', { clientY: y });
  controller.setAppearance({ metrics: { arrowSize: 0 } });
  assert.equal(f.doc.captured, f.track);
  fire(f.track, 'mousemove', { clientY: y });
  assert.equal(f.viewport.scrollTop, 1000, 'removing arrows must not reinterpret the old grab position');
  const after = controller.update(), delta = 10, expected = 1000 + delta / after.travel * after.maximum;
  fire(f.track, 'mousemove', { clientY: y + delta });
  assert.equal(f.viewport.scrollTop, expected);
  f.track.offsetHeight = 240; controller.update();
  fire(f.track, 'mousemove', { clientY: y + delta });
  fire(f.track, 'mouseup', { clientY: y + delta });
  assert.equal(f.viewport.scrollTop, expected, 'a resized lane keeps the same captured pointer/value anchor');
  controller.stop();
});

test('rejected initial schema/callbacks leave no listeners, owned nodes, style or aria mutations on retry', () => {
  for (const kind of ['schema', 'callback-type', 'decorate', 'paint', 'cleanup']) {
    const f = fixture(), original = new Error('initial ' + kind), cleanupError = new Error('cleanup failure');
    f.track.setAttribute('aria-valuemax', '17');
    const keys = [...scrollbarStyleKeys, 'width', 'left', 'right', 'top', 'height', 'display', 'pointerEvents'];
    const style = node => keys.map(key => [key, node.style[key] ?? '']);
    const before = [style(f.track), style(f.thumb)], errors = [], report = console.error;
    let cleaned = 0, caught;
    const appearance = kind === 'schema' ? { metrics: { width: 0 } } : kind === 'callback-type' ? { paint: 7 } : {
      metrics: { width: 16, thumbInset: 1, arrowSize: 16 },
      decorate(parts) {
        parts.trackDetail.insertBefore(f.doc.createElement('view'), null);
        if (kind === 'decorate') throw original;
        return () => { cleaned++; if (kind === 'cleanup') throw cleanupError; };
      },
      paint() { throw original; },
    };
    console.error = message => errors.push(message);
    try { createVerticalScrollbar({ ...f, appearance }); } catch (error) { caught = error; }
    finally { console.error = report; }
    assert.ok(caught instanceof Error);
    if (!['schema', 'callback-type'].includes(kind)) assert.equal(caught, original, 'the original callback exception is rethrown unchanged');
    assert.ok([...f.track.listeners.values()].every(list => list.length === 0), kind + ': no ghost listeners');
    assert.equal(f.track.childNodes.length, 1); assert.equal(f.thumb.childNodes.length, 0);
    assert.deepEqual([style(f.track), style(f.thumb)], before);
    assert.equal(f.track.getAttribute('aria-valuemax'), '17');
    assert.equal(f.track.getAttribute('aria-disabled'), null); assert.equal(f.track.tabIndex, -1);
    if (['paint', 'cleanup'].includes(kind)) assert.equal(cleaned, 1);
    assert.equal(errors.length, kind === 'cleanup' ? 1 : 0, 'cleanup failure must be explicit, not swallowed');
    const controller = createVerticalScrollbar({ ...f, appearance: { metrics: { arrowSize: 16 } } });
    fire(f.track, 'mousedown', { clientY: 212 }); fire(f.track, 'mouseup', { clientY: 212 });
    assert.equal(f.viewport.scrollTop, 42, 'retry arrow invokes one original step');
    fire(f.track, 'keydown', { key: 'ArrowDown' });
    assert.equal(f.viewport.scrollTop, 84, 'retry key invokes one step, not a leaked controller');
    controller.stop();
  }
});

test('surface opacity is consumed while visibility still hides fitted content and legacy opt-out stays exact', () => {
  const f = fixture(), appearance = {
    paint: state => ({ track: { opacity: state.focused ? 0.6 : 0.37 } }),
  };
  const controller = createVerticalScrollbar({ ...f, appearance });
  assert.equal(f.track.style.opacity, '0.37');
  f.track.focus(); assert.equal(f.track.style.opacity, '0.6', 'focus paint applies its legal opacity immediately');
  fire(f.track, 'blur'); assert.equal(f.track.style.opacity, '0.37');
  f.doc.activeElement = null;
  f.viewport.childNodes[0].offsetHeight = 42; controller.update();
  assert.equal(f.track.style.opacity, '0', 'no-overflow visibility wins over surface opacity');
  f.viewport.childNodes[0].offsetHeight = 4200; controller.update();
  assert.equal(f.track.style.opacity, '0.37', 'restored overflow restores the declared surface opacity');
  controller.setAppearance(undefined); controller.update();
  assert.equal(f.track.style.opacity, '1', 'unconfigured legacy visibility remains unchanged');
  controller.stop();
});
