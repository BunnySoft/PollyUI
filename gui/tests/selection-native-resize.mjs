import { h, createApp } from './gui/sdk/js/vue.mjs';
import { NSelect, NOverlayHost } from './gui/sdk/js/naive.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
const pause = () => new Promise(resolve => setTimeout(resolve, 120));
export async function checkNativeSelectResize(verify = true) {
  const child = window.create({ title: 'Select.resize.review', width: 640, height: 500 });
  const owner = child.document, original = globalThis.document;
  const observe = child.observeState;
  let renders = 0, subscriptions = 0;
  child.observeState = function(callback) {
    const remove = observe.call(this, callback);
    let active = true;
    subscriptions++;
    return () => { if (active) { active = false; subscriptions--; remove(); } };
  };
  globalThis.document = owner;
  try {
    createApp({ setup: () => () => {
      renders++;
      return h('view', { style: { width: '100%', height: '100%' } },
        h('view', { style: { position: 'absolute', left: 20, top: 20 } },
          NSelect({ id: 'native-select', value: 0, options: Array.from({ length: 20 }, (_, value) =>
            ({ value, label: 'Option ' + value })) })), NOverlayHost());
    } }).mount(owner.body);
  } finally { globalThis.document = original; }
  await pause();
  ownerTest.resize('Select.resize.review', 640, 500, ownerTest.nativeDpiMessage ? 96 : 0);
  await pause();
  const trigger = owner.getElementById('native-select');
  // Opening uses the installed real SDK key listener; the host resize itself is native.
  trigger.__listeners.keydown({ currentTarget: trigger, key: 'Enter', repeat: false, preventDefault() {} });
  await pause();
  const list = () => owner.querySelector('.n-select-list');
  const snapshot = () => {
    const r = list().getBoundingClientRect();
    return { viewport: [owner.body.offsetWidth, owner.body.offsetHeight], box: [r.x, r.y, r.width, r.height],
      bottom: r.bottom, renders, subscriptions, focused: owner.activeElement === trigger };
  };
  const before = snapshot(), callbacks = [], requestFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = callback => requestFrame(time => { callbacks.push(time); callback(time); });
  ownerTest.resize('Select.resize.review', 640, 80, ownerTest.nativeDpiMessage ? 96 : 0);
  // No fixture render, reactive model update or host.render follows either resize.
  await pause();
  const shrunk = snapshot(), shrinkFrames = callbacks.length;
  ownerTest.resize('Select.resize.review', 640, 500, ownerTest.nativeDpiMessage ? 96 : 0);
  await pause();
  const grown = snapshot(), growFrames = callbacks.length - shrinkFrames;
  trigger.__listeners.keydown({ currentTarget: trigger, key: 'Escape', repeat: false, preventDefault() {} });
  await pause();
  const closedAt = callbacks.length;
  ownerTest.resize('Select.resize.review', 620, 480, ownerTest.nativeDpiMessage ? 96 : 0);
  await pause();
  globalThis.requestAnimationFrame = requestFrame;
  console.log('SELECT_NATIVE_RESIZE ' + JSON.stringify({ verify, before, shrunk, grown, shrinkFrames, growFrames,
    afterCloseFrames: callbacks.length - closedAt, afterCloseSubscriptions: subscriptions,
    opening: 'Real SDK listener entry; not an injected native key event',
    tinyViewport: 'Only a partial option row is possible at 80px; no full-row claim' }));
  child.close(); window.quit();
  if (verify) {
    check(shrunk.box[3] < 32 && shrunk.bottom <= shrunk.viewport[1] && grown.box[3] === before.box[3] &&
      shrunk.focused && grown.focused, 'Open Select follows pure native host shrink/grow and keeps actual trigger focus');
    check(shrinkFrames > 0 && shrinkFrames <= 4 && growFrames > 0 && growFrames <= 4 &&
      before.subscriptions === 1 && subscriptions === 0 && callbacks.length === closedAt,
      'Open resize work is bounded and closing removes the owner subscription');
  }
}
