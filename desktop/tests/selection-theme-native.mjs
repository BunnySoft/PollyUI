import { h, createApp } from './gui/sdk/js/vue.mjs';
import { render } from './gui/sdk/js/reconciler.mjs';
import { NOverlayHost } from './gui/sdk/js/naive.mjs';
import { getDesktopTheme } from './desktop/shared/ui/themes.mjs';
import { themedCheckbox, themedSelect } from './desktop/shared/ui/selection-controls.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = refs => Object.fromEntries(Object.entries(refs).map(([key, value]) => [key, Boolean(value.deref())]));
export async function checkThemedSelectionNative() {
  const theme = getDesktopTheme('server2003'), child = window.create({ title: 'Themed Select resize', width: 640, height: 500 });
  const owner = child.document, previous = globalThis.document;
  let renders = 0;
  globalThis.document = owner;
  try {
    createApp({ setup: () => () => {
      renders++;
      return h('view', { style: { width: '100%', height: '100%' } },
        h('view', { style: { position: 'absolute', top: 30, left: 20 } },
          themedSelect(theme, { id: 'themed-native-select', value: 0, width: 200,
            options: Array.from({ length: 20 }, (_, value) => ({ value, label: 'Option ' + value })) })), NOverlayHost());
    } }).mount(owner.body);
  } finally { globalThis.document = previous; }
  await pause(100);
  ownerTest.resize('Themed Select resize', 640, 500, ownerTest.nativeDpiMessage ? 96 : 0); await pause(100);
  const trigger = owner.getElementById('themed-native-select');
  trigger.focus();
  // Reuse the installed SDK event entry; the resize below is a real native
  // host operation, not a VNode update or forced-render proxy.
  trigger.__listeners.keydown({ currentTarget: trigger, key: 'Enter', repeat: false, preventDefault() {} });
  await pause(100);
  const snapshot = () => {
    const list = owner.querySelector('.n-select-list'), r = list.getBoundingClientRect();
    return { viewport: [owner.body.offsetWidth, owner.body.offsetHeight], list: [r.x, r.y, r.width, r.height],
      bottom: r.bottom, rowHeight: list.querySelector('.n-select-option').offsetHeight, renders, focused: owner.activeElement === trigger };
  };
  const before = snapshot();
  ownerTest.resize('Themed Select resize', 640, 80, ownerTest.nativeDpiMessage ? 96 : 0);
  await pause(120);
  const small = snapshot();
  check(small.list[3] < small.rowHeight && small.bottom <= small.viewport[1] && small.focused,
    'Themed open portal converges inside a genuinely sub-row native viewport without claiming a full visible row');
  ownerTest.resize('Themed Select resize', 640, 500, ownerTest.nativeDpiMessage ? 96 : 0);
  await pause(120);
  const grown = snapshot();
  check(grown.list[3] === before.list[3] && grown.focused, 'Themed portal restores its own row metrics on pure host grow');
  trigger.__listeners.keydown({ currentTarget: trigger, key: 'Escape', repeat: false, preventDefault() {} });
  await pause(50); child.close();
  const closed = async focused => {
    let peer = window.create({ title: 'Themed checkbox GC ' + focused, width: 240, height: 140 });
    let doc = peer.document;
    const original = globalThis.document; globalThis.document = doc;
    try { render(themedCheckbox(theme, { id: 'collect-themed', checked: true }, 'Collect'), doc.body); }
    finally { globalThis.document = original; }
    await pause(90);
    let node = doc.getElementById('collect-themed');
    if (focused) node.focus();
    await pause(90);
    const refs = { node: new WeakRef(node), document: new WeakRef(doc), window: new WeakRef(peer) };
    node = null; doc = null; peer.close(); peer = null; return refs;
  };
  const plain = await closed(false), focused = await closed(true);
  for (let i = 0; i < 8; i++) { await pause(30); ownerTest.gc(); }
  const collection = { plain: alive(plain), focused: alive(focused) };
  check(Object.values(collection.plain).every(value => !value) && Object.values(collection.focused).every(value => !value),
    'Decorated checkbox focus/marker state does not retain a closed native owner');
  console.log('THEMED_SELECTION_NATIVE ' + JSON.stringify({ before, small, grown, collection,
    scope: 'Existing native resize + GC runner; Select opening uses its installed listener, not native-key injection' }));
  window.quit();
}
