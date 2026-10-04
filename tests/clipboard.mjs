import { createTextInput } from './js/textinput.mjs';
import { createApp, h, reactive } from './js/vue.mjs';
import { NInput } from './js/naive.mjs';
function check(value, message) {
  if (!value) throw new Error('FAIL: ' + message);
  console.log('PASS: ' + message);
}
function rejects(action, message) {
  let failed = false;
  try { action(); } catch { failed = true; }
  check(failed, message);
}
clipboard.writeText('Polly \u4e2d\u6587 \ud83d\ude42');
check(clipboard.readText() === 'Polly \u4e2d\u6587 \ud83d\ude42', 'Unicode clipboard text roundtrips');
const source = new Uint8Array([10, 20, 0, 255]);
clipboard.write([{ type: 'application/x-polly', data: source.subarray(1) }]);
source[1] = 99;
check(Array.from(new Uint8Array(clipboard.read('application/x-polly'))).join(',') === '20,0,255',
  'clipboard copies the exact typed-array view');
check(clipboard.formats().includes('application/x-polly') && clipboard.read('application/missing') === null,
  'clipboard MIME discovery and absent formats');
clipboard.write([{ type: 'application/empty', data: new ArrayBuffer(0) }]);
check(clipboard.read('application/empty').byteLength === 0, 'empty clipboard buffers remain valid');
rejects(() => clipboard.writeText('bad\0text'), 'embedded NUL text is rejected');
rejects(() => clipboard.write([{ type: 'bad\nmime', data: new ArrayBuffer(1) }]), 'invalid MIME names are rejected');
rejects(() => clipboard.write([{ type: 'x/a', data: new ArrayBuffer(1) }, { type: 'x/a', data: new ArrayBuffer(1) }]),
  'duplicate MIME types are rejected');
clipboard.write([]);
check(clipboard.formats().length === 0 && clipboard.readText() === '', 'clipboard can be cleared');
rejects(() => clipboard.write(Array.from({ length: 17 }, (_, i) =>
  ({ type: 'x/' + i, data: new ArrayBuffer(0) }))), 'clipboard format count is bounded');
rejects(() => clipboard.write([{ type: 'x/large', data: new ArrayBuffer(16 * 1024 * 1024 + 1) }]),
  'oversized binary clipboard payloads are rejected');
rejects(() => clipboard.write([{ get type() { throw new Error('getter'); } }]), 'throwing MIME getters are surfaced');
rejects(() => clipboard.write([{ type: 'x/data', data: {} }]), 'non-buffer clipboard data is rejected');
const detached = new ArrayBuffer(1);
if (typeof detached.transfer === 'function') {
  detached.transfer();
  rejects(() => clipboard.write([{ type: 'x/detached', data: detached }]), 'detached clipboard buffers are rejected');
}
check(clipboard.formats().length === 0, 'rejected writes preserve the previous clipboard');

const input = createTextInput({ value: 'Copy \ud83d\ude42 \u4e2d\u6587', width: 300 });
document.body.appendChild(input.root);
host.render();
input.root.focus();
host.key('a', 'keydown', { ctrlKey: true });
host.key('c', 'keydown', { ctrlKey: true });
check(clipboard.readText() === input.value, 'Ctrl+A and Ctrl+C copy the selection');
host.key('x', 'keydown', { ctrlKey: true });
check(input.value === '', 'Ctrl+X cuts only after copying');
host.key('v', 'keydown', { ctrlKey: true });
check(input.value === 'Copy \ud83d\ude42 \u4e2d\u6587', 'Ctrl+V pastes text into the input');
clipboard.writePrimaryText('primary ');
host.mouse('auxclick', input.root.offsetLeft + 8, input.root.offsetTop + 8, { button: 1 });
check(input.value.startsWith('primary '), 'middle click inserts primary selection');
check(clipboard.readText() === 'Copy \ud83d\ude42 \u4e2d\u6587', 'primary selection is independent of the clipboard');
const mount = document.createElement('view');
document.body.appendChild(mount);
const state = reactive({ value: 'Controlled \ud83d\ude42' });
createApp({ setup: () => () => h('view', {}, NInput({
  id: 'clipboard-controlled', value: state.value, onInput: value => state.value = value,
})) }).mount(mount);
host.render();
document.getElementById('clipboard-controlled').focus();
host.key('a', 'keydown', { metaKey: true }); host.key('c', 'keydown', { metaKey: true });
check(clipboard.readText() === state.value, 'controlled input supports Meta+A/Meta+C');
host.key('x', 'keydown', { ctrlKey: true });
check(state.value === '', 'controlled input cuts the selected text');
host.key('v', 'keydown', { ctrlKey: true });
check(state.value === 'Controlled \ud83d\ude42', 'controlled input pastes without extra key-generated text');
console.log('PASS: clipboard suite complete');
