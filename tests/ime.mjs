// ime.mjs — headless composition/preedit and candidate-area coverage.

import { createTextInput } from './js/textinput.mjs';
import { ref, createApp, h } from './js/vue.mjs';
import { NInput, NOverlayHost } from './js/naive.mjs';

let pass = 0, fail = 0;
function check(name, condition) {
  if (condition) { pass++; console.log('PASS: ' + name); }
  else { fail++; console.log('FAIL: ' + name); }
}

const input = createTextInput({ value: 'A', width: 260, fontSize: 18 });
input.root.style.marginLeft = '24';
input.root.style.marginTop = '20';
document.body.appendChild(input.root);

const events = [];
for (const type of ['compositionstart', 'compositionupdate', 'compositionend']) {
  input.root.addEventListener(type, e => {
    events.push({ type: e.type, data: e.data, start: e.start, length: e.length });
  });
}

host.render();
check('text input is marked for native IME',
      input.root.getAttribute('textInput') === 'true');
host.click(input.root.offsetLeft + input.root.offsetWidth - 10,
           input.root.offsetTop + input.root.offsetHeight / 2);

const initialArea = host.textInputArea();
check('focused input exposes a candidate area', initialArea !== null);
check('candidate area follows the input bounds',
      initialArea && initialArea.x === input.root.offsetLeft &&
      initialArea.y === input.root.offsetTop &&
      initialArea.width === input.root.offsetWidth);

host.composition('editing', 'ni', 2, 0);
const editingArea = host.textInputArea();
check('compositionstart and compositionupdate are dispatched',
      events.length === 2 &&
      events[0].type === 'compositionstart' &&
      events[1].type === 'compositionupdate');
check('composition range is exposed',
      events[1].data === 'ni' && events[1].start === 2 && events[1].length === 0);
check('preedit is rendered without changing the committed value',
      input.root.textContent === 'Ani' && input.value === 'A');
check('candidate cursor advances with the preedit caret',
      editingArea && initialArea && editingArea.cursor > initialArea.cursor);

host.composition('editing', 'nihao', 1, 2);
const selectedArea = host.textInputArea();
check('SDL preedit selection keeps the candidate cursor at start',
      selectedArea &&
      Math.abs(selectedArea.cursor - (8 + measureText('An', 18))) < 1);

host.composition('commit', '你');
check('compositionend carries committed text',
      events.length === 4 && events[3].type === 'compositionend' &&
      events[3].data === '你');
check('committed CJK text replaces the preedit',
      input.value === 'A你' && input.root.textContent === 'A你');

host.composition('commit', '😀');
check('committed emoji remains a complete code point',
      input.value === 'A你😀');
host.key('Backspace');
check('Backspace removes a complete emoji',
      input.value === 'A你');

host.click(700, 500);
check('candidate area clears when the input loses focus',
      host.textInputArea() === null);

const mount = document.createElement('view');
mount.style.marginLeft = '24';
mount.style.marginTop = '80';
document.body.appendChild(mount);
let controlled = '';
createApp({ setup() {
  const value = ref('');
  return () => h('view', {},
    NInput({ id: 'ime-controlled', value: value.value, width: 260,
      onInput: next => { value.value = next; controlled = next; } }),
    NOverlayHost());
} }).mount(mount);
host.render();

const nativeInput = document.getElementById('ime-controlled');
host.click(nativeInput.offsetLeft + 20, nativeInput.offsetTop + 15);
check('controlled input exposes a candidate area',
      host.textInputArea() !== null);
host.composition('editing', 'zhong', 5, 0);
const editingInput = document.getElementById('ime-controlled');
check('controlled input renders preedit text',
      editingInput.textContent.indexOf('zhong') >= 0 && controlled === '');
check('controlled input updates its candidate cursor',
      host.textInputArea() !== null && host.textInputArea().cursor > 12);
host.composition('commit', '中');
check('controlled input commits CJK text',
      controlled === '中' &&
      document.getElementById('ime-controlled').textContent.indexOf('中') >= 0);

host.composition('editing', 'stale', 5, 0);
host.click(input.root.offsetLeft + 20, input.root.offsetTop + 15);
host.composition('commit', '错');
check('commit is not redirected after focus changes',
      controlled === '中' && input.value === 'A你');
host.composition('commit', '新');
check('new focused input accepts subsequent committed text',
      input.value === 'A新你');

const anonymousMount = document.createElement('view');
anonymousMount.style.marginLeft = '24';
anonymousMount.style.marginTop = '140';
document.body.appendChild(anonymousMount);
let anonymousValue = '😀';
createApp({ setup() {
  const value = ref('😀');
  return () => NInput({ value: value.value, width: 180,
    onInput: next => { value.value = next; anonymousValue = next; } });
} }).mount(anonymousMount);
host.render();
const anonymousInput = anonymousMount.childNodes[0];
host.click(anonymousInput.offsetLeft + 20, anonymousInput.offsetTop + 15);
host.key('Backspace');
check('ID-less input deletes a complete emoji',
      anonymousValue === '');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
