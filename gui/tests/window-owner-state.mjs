const check = (value, message) => { if (!value) throw new Error(message); console.log('PASS: ' + message); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const end = Date.now() + 8000;
  while (Date.now() < end) { if (predicate()) return; await delay(10); }
  throw new Error('Native owner/state fixture timed out');
}
function rejects(action, message) {
  let error = null; try { action(); } catch (caught) { error = caught; }
  check(error instanceof TypeError || error instanceof RangeError, message);
}
function documentLookup(doc, owner, label) {
  const prototype = Object.getPrototypeOf(doc), reflect = globalThis.Reflect, get = reflect.get;
  const symbol = Symbol(label), proxySymbol = Symbol(label + ' proxy'), receiver = {};
  const failure = new Error('EXPECTED inherited Proxy get');
  let gets = 0, ownerGets = 0;
  doc.annotation = 17; doc[symbol] = 'retained';
  const inherited = Object.create(prototype, {
    receiverProbe: { get() { return this; }, configurable: true },
  });
  const proxy = new Proxy(inherited, {
    get(target, property, actualReceiver) {
      if (property === 'defaultView') { ownerGets++; return 'wrong owner'; }
      if (property === 'proxyProbe' || property === proxySymbol) { gets++; return actualReceiver; }
      if (property === 'throwProbe') throw failure;
      return get(target, property, actualReceiver);
    },
  });
  try {
    Object.setPrototypeOf(doc, proxy);
    check(doc.annotation === 17 && doc[symbol] === 'retained', label + ' ordinary string/Symbol extensions');
    check(doc.receiverProbe === doc && get(doc, 'receiverProbe', receiver) === receiver,
      label + ' inherited getter receives the actual/supplied receiver');
    check(doc.proxyProbe === doc && get(doc, 'proxyProbe', receiver) === receiver &&
      get(doc, proxySymbol, receiver) === receiver && gets === 3, label + ' delegates Proxy [[Get]] and Symbol keys');
    check(doc.defaultView === owner && get(doc, 'defaultView', receiver) === null && ownerGets === 0,
      label + ' owner lookup keeps its native receiver guard instead of delegating');
    let caught;
    try { doc.throwProbe; } catch (error) { caught = error; }
    check(caught === failure, label + ' propagates the original Proxy exception');
    reflect.get = () => { throw new Error('Mutable global Reflect.get consulted'); };
    check(doc.proxyProbe === doc, label + ' cached intrinsic survives replacing Reflect.get');
    globalThis.Reflect = { get() { throw new Error('Mutable global Reflect consulted'); } };
    check(doc.proxyProbe === doc && get(doc, 'proxyProbe', receiver) === receiver,
      label + ' cached intrinsic survives replacing global Reflect');
  } finally {
    globalThis.Reflect = reflect; reflect.get = get;
    Object.setPrototypeOf(doc, prototype);
    delete doc.annotation; delete doc[symbol];
  }
  check(doc.body && get(doc, 'body', doc) === doc.body, label + ' ordinary lookup survives restoration');
}
async function run() {
  check(document.defaultView === window, 'Root document identifies the actual global window handle');
  documentLookup(document, window, 'Root');
  const reflect = globalThis.Reflect, get = reflect.get;
  let child;
  try {
    reflect.get = () => { throw new Error('Child creation consulted mutable Reflect.get'); };
    globalThis.Reflect = { get() { throw new Error('Child creation consulted mutable Reflect'); } };
    child = window.create({title: 'Owner.child', width: 300, height: 180});
  } finally { globalThis.Reflect = reflect; reflect.get = get; }
  const doc = child.document;
  documentLookup(doc, child, 'Child created while global Reflect was replaced');
  check(doc.defaultView === child && doc !== document && doc.defaultView !== window, 'Child owner identity is stable and not the root');
  rejects(() => { doc.defaultView = window; }, 'defaultView rejects assignment');
  rejects(() => Object.defineProperty(doc, 'defaultView', {value: window}), 'defaultView is an own nonconfigurable property');
  const descriptor = Object.getOwnPropertyDescriptor(doc, 'defaultView');
  check(descriptor.get === undefined && descriptor.writable === false &&
    Reflect.get(doc, 'defaultView', {}) === null && Object.create(doc).defaultView === null,
    'No borrowable getter or forged receiver can acquire an owner');
  check(ownerTest.foreignViewRejected(doc), 'Cross-context lookup cannot acquire a foreign window handle');
  await until(() => child.document.body.offsetWidth === 300);
  let business = 0, replacement = 0, first = 0, second = 0;
  child.onstatechange = state => { business++; state.width = -1; };
  let removeSecond;
  const removeFirst = child.observeState(state => {
    check(state.width > 0, 'Observer receives a fresh snapshot after business mutation');
    first++; removeSecond();
  });
  removeSecond = child.observeState(() => second++);
  check(first === 0 && second === 0, 'observeState registration does not synchronously invoke the callback');
  ownerTest.resize('Owner.child', 360, 220);
  await until(() => first > 0 && child.state.width === 360);
  check(business > 0 && second === 0, 'Business callback runs and same-event unsubscribe skips another observer');
  child.onstatechange = () => replacement++;
  const previous = first;
  ownerTest.resize('Owner.child', 420, 260);
  await until(() => first > previous && replacement > 0);
  check(second === 0, 'Reassigning onstatechange does not replace independent observers');
  removeFirst(); removeFirst(); removeSecond(); removeSecond();
  const quiet = first;
  ownerTest.resize('Owner.child', 440, 280);
  await until(() => child.state.width === 440);
  await delay(40);
  check(first === quiet, 'Unsubscribe is idempotent and stops delivery');
  let selfCalls = 0, addedCalls = 0, removeAdded;
  const removeSelf = child.observeState(() => {
    selfCalls++; removeSelf();
    removeAdded = child.observeState(() => addedCalls++);
  });
  ownerTest.resize('Owner.child', 480, 300);
  await until(() => selfCalls === 1);
  await delay(30);
  check(addedCalls === 0, 'Self-unsubscribe is safe and additions do not receive the in-progress event');
  ownerTest.resize('Owner.child', 500, 320);
  await until(() => addedCalls === 1);
  check(selfCalls === 1, 'New observer receives only the later native state event');
  removeAdded();
  rejects(() => child.observeState.call({}, () => {}), 'Borrowed method rejects a non-Window receiver');
  rejects(() => child.observeState('not a callback'), 'Listener callback type is explicit');
  const subscriptions = Array.from({length: 64}, () => child.observeState(() => {}));
  rejects(() => child.observeState(() => {}), 'Per-window observer overflow is explicit');
  subscriptions.forEach(remove => remove());
  const closing = window.create({title: 'Owner.closing', width: 200, height: 140});
  await until(() => closing.document.body.offsetWidth === 200);
  const closingDoc = closing.document;
  let afterClose = 0;
  const late = closing.observeState(() => closing.close());
  closing.observeState(() => afterClose++);
  ownerTest.resize('Owner.closing', 240, 160);
  await until(() => closing.closed);
  check(closingDoc.defaultView === null && afterClose === 0, 'Callback close invalidates owner and stops remaining delivery safely');
  late(); late();
  rejects(() => closing.observeState(() => {}), 'Closed-window registration is explicitly rejected');
  for (let i = 0; i < 12; i++) {
    let peer = window.create({title: 'Owner.gc', width: 180, height: 100});
    const retained = peer.document, remove = peer.observeState(() => retained.body);
    peer.close();
    check(retained.defaultView === null, 'Retained closed document has no live owner');
    remove(); remove(); peer = null; ownerTest.gc();
  }
  child.close(); ownerTest.gc();
  check(doc.defaultView === null, 'Retained child document remains safe after GC');
  documentLookup(doc, null, 'Retained closed child after GC');
  console.log('PASS: native root/child owner, immutable association and independent state lifecycle');
  window.quit();
}
run().catch(error => { console.error(String(error) + '\n' + error.stack); window.quit(); throw error; });
