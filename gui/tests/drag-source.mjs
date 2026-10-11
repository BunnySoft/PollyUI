const [scenario] = application.arguments;
const marker = 'Polly COPY \u4e2d\u6587';
const owner = scenario === 'owner-close' ? window.create({title:'Drag.owner', width:360, height:280}) : null;
const source = window.create({title: 'Drag.source', width: 360, height: 280, ...(owner ? {parent:owner} : {})});
const peer = window.create({title: 'Drag.peer', width: 360, height: 280});
window.close();
let input, peerInput, operation, promise, stale, detached;
const counts = {down: 0, up: 0, copied: 0, cancelled: 0, error: 0,
  received: 0, clipboard: 0, heartbeat: 0, invalid: 0, held: 0, pending: 0, bytes: 0, closed: 0};
function check(value, message) { if (!value) { counts.error++; throw new Error(message); } }
function rejects(fn) {
  let failed = false;
  try { fn(); } catch { failed = true; }
  check(failed, 'invalid native drag request was accepted');
  counts.invalid++;
}
const node = source.document.createElement('div');
node.style.width = 360; node.style.height = 280;
source.document.body.appendChild(node);
node.addEventListener('mousedown', event => {
  counts.down++; counts.held = 1; input = event.dragInput;
  check(input !== null, 'real ordinary Wayland down has native credential');
  node.setMouseCapture();
});
node.addEventListener('mouseup', () => { counts.up++; counts.held = 0; });
peer.document.body.addEventListener('mousedown', event => { peerInput = event.dragInput; });
peer.document.body.addEventListener('drop', event => {
  check(event.text === marker, 'SDL peer receives exact UTF-8 payload'); counts.received++;
});
source.document.body.addEventListener('drop', event => {
  check(event.text === marker, 'self-drop receives exact UTF-8 payload'); counts.received++;
});
let clicks = 0;
node.addEventListener('click', () => clicks++);
function items(mode) {
  if (mode === 8) {
    const offered = Array.from({length:16}, (_, i) => ({
      type:'application/x-polly-unused-' + i, data:new Uint8Array([i])
    }));
    return offered.concat(items(1));
  }
  if (mode === 4) return [{type:'application/x-polly-copy-test', data:new Uint8Array(0)}];
  if (mode === 1 || mode === 5) {
    const size = mode === 5 ? 17 * 1024 * 1024 : 262144;
    const storage = new Uint8Array(test.bytes(size + 4));
    const view = storage.subarray(2, size + 2);
    return [{type:'application/x-polly-copy-test', data: view}];
  }
  return [{type:'text/plain;charset=utf-8', data:marker}];
}
test.oncommand = (command, mode) => {
  if (command === 1) {
    if (mode === 6) {
      const payload = {type:'text/plain', get data() { source.document.body.removeChild(node); return marker; }};
      rejects(() => source.startDrag({input,items:[payload]}));
      return test.report(counts);
    }
    if (mode === 2) {
      rejects(() => source.startDrag({input: {}, items:items(0)}));
      rejects(() => peer.startDrag({input, items:items(0)}));
      rejects(() => source.startDrag({input, items:[{type:'text/plain',data:'bad\0text'}]}));
      rejects(() => source.startDrag({input, items:[{type:'text/plain',data:new Uint8Array([255])}]}));
      rejects(() => source.startDrag({input, items:items(0), action:'move'}));
      rejects(() => source.startDrag({input, items:[{type:'x/y',data:new DataView(new ArrayBuffer(4))}]}));
      rejects(() => source.startDrag({input, items:[{type:'x/y',data:new Uint8Array(1)},{type:'x/y',data:new Uint8Array(1)}]}));
    } else if (mode === 3) {
      rejects(() => source.startDrag({input: stale || input, items:items(0)}));
      return test.report(counts);
    }
    const offered = items(mode === 1 || mode === 4 || mode === 5 || mode === 8 ? mode : 0);
    const dragWindow = mode === 7 ? peer : source;
    const dragInput = mode === 7 ? peerInput : input;
    operation = dragWindow.startDrag({input:dragInput, items:offered});
    if (mode !== 7) check(!node.hasMouseCapture(), 'native drag takes over DOM mouse capture');
    if (mode === 1 || mode === 5) offered[0].data.fill(255);
    if (mode === 8) offered[16].data.fill(255);
    stale = input;
    rejects(() => dragWindow.startDrag({input:dragInput, items:items(0)}));
    counts.pending = 1;
    promise = operation.finished;
    promise.then(result => {
      counts.pending = 0; counts.held = 0;
      check(clicks === 0, 'drag release must not leak a DOM click');
      if (result.status === 'copied') {
        check(result.action === 'copy' && result.reason === null, 'honest COPY result');
        counts.copied++;
      } else {
        check(result.status === 'cancelled' && result.action === null, 'honest cancellation');
        counts.cancelled++;
      }
      if (scenario === 'reentrant') {
        const child = window.create({title:'Drag.reentrant', width:360, height:280});
        child.close(); source.close();
      }
    }, error => { counts.pending = 0; counts.error++; check(error instanceof Error, 'transport rejects Error'); });
  } else if (command === 2) operation?.cancel();
  else if (command === 3) {
    if (mode === 1) owner.close();
    else source.close();
    if (mode === 2) {
      const replacement = window.create({title:'Drag.replacement',width:360,height:280});
      rejects(() => replacement.startDrag({input,items:items(0)}));
      rejects(() => source.startDrag({input,items:items(0)}));
      replacement.close();
    }
    counts.closed = 1;
  }
  else if (command === 4) window.quit();
  else if (command === 5) clipboard.writeText('Polly clipboard unchanged');
  else if (command === 6) { check(clipboard.readText() === 'Polly clipboard unchanged', 'clipboard roundtrip'); counts.clipboard++; }
  else if (command === 11) { operation = null; test.gc(); }
  else if (command === 12) { source.document.body.removeChild(node); detached = true; }
  test.report(counts);
};
setInterval(() => { counts.heartbeat++; }, 10);
source.onclose = () => { counts.closed = 1; };
check(source.capabilities().dragCopy, 'ordinary native source supports COPY');
check(!window.capabilities().dragCopy, 'closed primary does not support COPY');
// Strongly retain operation while awaiting its Promise; dropping it cancels.
void promise; void detached; void clicks;
