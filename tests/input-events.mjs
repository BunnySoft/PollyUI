import { createTextInput } from './js/textinput.mjs';
import { createApp, h, reactive } from './js/vue.mjs';
import { NInput, NDynamicInput, NAutoComplete, NMention, NOverlayHost } from './js/naive.mjs';

let passed = 0;
function check(name, value) {
  if (!value) throw new Error('FAIL: ' + name);
  passed++;
  console.log('PASS: ' + name);
}
const field = createTextInput({ value: '' });
document.body.appendChild(field.root);
let lastKey, lastText, blockTab = false;
field.root.addEventListener('keydown', e => {
  lastKey = e;
  if (e.key === 'x' || (e.key === 'Tab' && blockTab)) e.preventDefault();
});
field.root.addEventListener('textinput', e => { lastText = e.data; });
field.root.focus();
host.key('a', 'keydown', { code: 'KeyA' });
check('printable convenience key inserts once', field.value === 'a');
check('physical key carries its code', lastKey.key === 'a' && lastKey.code === 'KeyA');
host.key('b', 'keydown', { text: false, code: 'KeyB' });
check('physical key without commit does not insert', field.value === 'a');
host.text('\u4e2d\u6587\ud83d\ude00');
check('one UTF-8 commit inserts the complete string', field.value === 'a\u4e2d\u6587\ud83d\ude00');
check('textinput exposes data, not a fabricated key', lastText === '\u4e2d\u6587\ud83d\ude00');
host.key('ArrowLeft');
check('left arrow does not split a surrogate pair', field.getCaret() === 3);
host.key('ArrowRight');
check('right arrow advances over a surrogate pair', field.getCaret() === 5);
host.key('Backspace');
check('backspace removes a complete code point', field.value === 'a\u4e2d\u6587');
host.key('Home'); host.key('Delete');
check('delete removes the next character', field.value === '\u4e2d\u6587');
field.selectAll(); host.text('ok');
check('committed text replaces a selection atomically', field.value === 'ok');
host.key('x');
check('preventDefault blocks key-generated text', field.value === 'ok');
host.key('c', 'keydown', { code: 'KeyC', ctrlKey: true, repeat: true });
check('shortcuts do not insert text', field.value === 'ok');
check('control and repeat are reflected', lastKey.ctrlKey && lastKey.repeat && !lastKey.altKey);
host.key('A', 'keydown', { shiftKey: true, altKey: true, metaKey: true, capsLock: true, numLock: true });
check('all modifier fields are present', lastKey.shiftKey && lastKey.altKey && lastKey.metaKey &&
  lastKey.capsLock && lastKey.numLock && !lastKey.ctrlKey);
const second = document.createElement('view');
second.tabIndex = 0;
document.body.appendChild(second);
const hidden = document.createElement('view');
hidden.tabIndex = 0; hidden.style.display = 'none';
document.body.appendChild(hidden);
field.root.focus();
host.key('Tab');
check('Tab advances after keydown', document.activeElement === second);
host.key('Tab', 'keydown', { shiftKey: true });
check('Shift+Tab moves backwards', document.activeElement === field.root);
host.key('Tab', 'keydown', { shiftKey: true });
check('reverse traversal wraps and skips hidden nodes', document.activeElement === second);
field.root.focus(); blockTab = true;
host.key('Tab');
check('preventDefault cancels Tab traversal', document.activeElement === field.root);
let failed = false;
try { host.key('a', 'keydown', { get ctrlKey() { throw new Error('option getter'); } }); }
catch (e) { failed = e.message === 'option getter'; }
check('option accessor errors propagate before dispatch', failed && field.value === 'ok');

const root = document.createElement('view');
Object.assign(root.style, { position: 'absolute', left: 330, top: 0, width: 350 });
document.body.appendChild(root);
const state = reactive({ input: '', plain: '', dynamic: [''], auto: '', mention: '' });
createApp({ setup: () => () => h('view', {},
  NInput({ id: 'typed', value: state.input, onInput: v => state.input = v }),
  h('view', { id: 'plain' }, NInput({ value: state.plain, onInput: v => state.plain = v })),
  NDynamicInput({ id: 'dynamic', value: state.dynamic, onChange: v => state.dynamic = v }),
  NAutoComplete({ id: 'auto', value: state.auto, onInput: v => state.auto = v }),
  NMention({ id: 'mention', value: state.mention, onInput: v => state.mention = v }),
  NOverlayHost(),
) }).mount(root);
host.render();
document.getElementById('typed').focus();
host.text('\u4e2d\ud83d\ude00');
check('controlled input accepts committed Unicode text', state.input === '\u4e2d\ud83d\ude00');
host.key('ArrowLeft'); host.key('Delete');
check('controlled input edits without splitting emoji', state.input === '\u4e2d');
state.input = '\ud83d\ude00';
host.flush(); host.render(); host.key('Delete');
check('external value changes cannot leave the caret inside a surrogate pair', state.input === '');
document.getElementById('plain').firstChild.focus();
host.text('\ud83d\ude00'); host.key('Backspace');
check('input without an ID has the same text semantics', state.plain === '');
document.getElementById('dynamic').firstChild.firstChild.focus();
host.text('item\ud83d\ude00'); host.key('Backspace');
check('dynamic input uses text commits', state.dynamic[0] === 'item');
document.getElementById('auto').focus();
host.text('complete');
check('autocomplete uses text commits', state.auto === 'complete');
document.getElementById('mention').focus();
host.text('@user');
check('mention uses text commits', state.mention === '@user');
console.log(passed + ' input-event assertions passed');
