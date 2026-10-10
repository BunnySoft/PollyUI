import { createTextInput } from './gui/sdk/js/textinput.mjs';
import { createApp, h, reactive } from './gui/sdk/js/vue.mjs';
import { NInput } from './gui/sdk/js/naive.mjs';

function check(value, message) {
  if (!value) throw new Error('FAIL: ' + message);
  console.log('PASS: ' + message);
}
function rejects(action, message) {
  let failed = false;
  try { action(); } catch { failed = true; }
  check(failed, message);
}
const first = createTextInput({ value: 'original', width: 300 });
const second = createTextInput({ value: '', width: 300 });
document.body.appendChild(first.root);
document.body.appendChild(second.root);
host.render();
check(first.root.ownerDocument === document, 'elements expose their owning document');
first.root.focus();
first.selectAll();
const events = [];
for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'textinput'])
  first.root.addEventListener(type, event => events.push([type, event.data]));
host.compose('ni', 2, 0);
check(first.value === 'original' && first.root.textContent === 'ni', 'preedit renders without changing committed value');
host.compose('nihao', 5, 0);
host.text('\u4f60\u597d');
check(first.value === '\u4f60\u597d', 'commit replaces the original selection exactly once');
check(events.map(event => event[0]).join(',') ===
  'compositionstart,compositionupdate,compositionupdate,compositionend,textinput', 'composition event order');
check(events[3][1] === '\u4f60\u597d', 'compositionend reports the committed text');
host.compose('cancel', 6, 0);
host.compose('');
check(first.value === '\u4f60\u597d' && first.root.textContent === first.value, 'cancel removes preedit without committing it');
host.compose('\ud83d\ude42x', 2, 0);
first.value = 'replacement';
check(first.root.textContent === 'replacement', 'external replacement cancels composition');
host.compose('pending', 7, 0);
second.root.focus();
check(first.root.textContent === 'replacement', 'focus changes discard old preedit');
host.compose('second', 6, 0);
host.text('B');
check(second.value === 'B' && first.value === 'replacement', 'commit stays in its focused field');
first.root.focus();
first.root.addEventListener('compositionend', event => { if (event.data === 'steal') second.root.focus(); });
host.compose('old', 3, 0);
host.text('steal');
check(second.value === 'B' && first.value === 'replacement', 'focus changes inside compositionend cannot redirect a commit');
host.compose('detached', 8, 0);
document.body.removeChild(second.root);
check(second.root.ownerDocument === null && document.activeElement === null, 'detaching a composing field releases focus');
rejects(() => first.root.setInputMethod({}), 'unfocused fields cannot enable input methods');
first.root.focus();
rejects(() => first.root.setInputMethod({ width: NaN }), 'invalid caret dimensions are rejected');
rejects(() => first.root.setInputMethod({ purpose: 'unknown' }), 'invalid input purposes are rejected');
rejects(() => first.root.setInputMethod({ unknown: true }), 'unknown input-method options are rejected');

const password = createTextInput({ value: 'private\ud83d\ude42', password: true });
document.body.appendChild(password.root);
host.render();
password.root.focus();
check(password.root.textContent === '\u2022'.repeat(8), 'password content is masked by code point');
clipboard.writeText('unchanged');
password.selectAll();
host.key('c', 'keydown', { ctrlKey: true });
check(clipboard.readText() === 'unchanged', 'password selections are not copied');
host.compose('must-not-appear', 3, 0);
check(!password.root.textContent.includes('must') && password.value === 'private\ud83d\ude42',
  'sensitive fields reject preedit display');

const mount = document.createElement('view');
document.body.appendChild(mount);
const model = reactive({ value: 'AB' });
let commits = 0;
createApp({ setup: () => () => h('view', {}, NInput({
  id: 'composed-controlled', value: model.value, onInput(value) { model.value = value; commits++; },
})) }).mount(mount);
host.render();
const controlled = document.getElementById('composed-controlled');
controlled.focus();
host.key('a', 'keydown', { ctrlKey: true });
host.compose('nihao', 5, 0);
check(model.value === 'AB' && controlled.textContent === 'nihao', 'controlled input renders uncommitted preedit');
host.text('\u4f60\u597d');
check(model.value === '\u4f60\u597d' && commits === 1, 'controlled input commits exactly once');
host.compose('cancel', 6, 0);
model.value = 'external';
host.flush(); host.render();
check(controlled.textContent === 'external' && commits === 1, 'controlled external changes cancel preedit without onInput');
console.log('PASS: composition suite complete');
