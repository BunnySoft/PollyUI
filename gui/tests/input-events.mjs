import { createTextInput } from './gui/sdk/js/textinput.mjs';
import { createApp, h, reactive } from './gui/sdk/js/vue.mjs';
import { NInput, NDynamicInput, NAutoComplete, NMention, NOverlayHost } from './gui/sdk/js/naive.mjs';

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

const existing = document.body.childNodes.map(node => [node, node.style.display]);
const traversal = document.createElement('view'), candidates = [];
const negative = document.createElement('view'), hiddenParent = document.createElement('view');
negative.tabIndex = -1; traversal.appendChild(negative);
hiddenParent.style.display = 'none';
const hiddenChild = document.createElement('view');
hiddenChild.tabIndex = 0; hiddenParent.appendChild(hiddenChild); traversal.appendChild(hiddenParent);
let mutableParent;
for (let index = 0; index < 1100; index++) {
  const node = document.createElement('view');
  node.tabIndex = index === 0 ? 7 : index === 1 ? 1 : 0;
  node.style.height = 1;
  if (index === 512) {
    mutableParent = document.createElement('view');
    mutableParent.appendChild(node); traversal.appendChild(mutableParent);
  } else traversal.appendChild(node);
  candidates.push(node);
}
try {
  for (const [node] of existing) node.style.display = 'none';
  document.body.appendChild(traversal);
  candidates[255].focus(); host.key('Tab');
  check('Tab reaches eligible index 256 without a fixed collection limit', document.activeElement === candidates[256]);
  host.key('Tab', 'keydown', { shiftKey: true });
  check('reverse Tab crosses index 256 in preorder', document.activeElement === candidates[255]);
  candidates[1023].focus(); host.key('Tab');
  check('Tab reaches an eligible index beyond 1024', document.activeElement === candidates[1024]);
  candidates[1098].focus(); host.key('Tab');
  check('Tab reaches the actual final eligible node beyond 1024', document.activeElement === candidates[1099]);
  host.key('Tab');
  check('forward Tab wraps from the actual last node to first', document.activeElement === candidates[0]);
  host.key('Tab', 'keydown', { shiftKey: true });
  check('reverse Tab wraps from first to the actual last node', document.activeElement === candidates[1099]);
  candidates[0].focus(); host.key('Tab');
  check('positive tabindex keeps the existing preorder rather than browser sorting', document.activeElement === candidates[1]);
  candidates[1].blur(); host.key('Tab');
  check('no focused node selects first and skips hidden ancestors and negative tabindex', document.activeElement === candidates[0]);
  candidates[0].blur(); host.key('Tab', 'keydown', { shiftKey: true });
  check('no focused node selects the actual last in reverse', document.activeElement === candidates[1099]);
  candidates[512].focus(); mutableParent.style.display = 'none'; host.key('Tab');
  check('a focused node under a newly hidden ancestor falls back to first', document.activeElement === candidates[0]);
  candidates[512].focus(); host.key('Tab', 'keydown', { shiftKey: true });
  check('a focused node under a hidden ancestor falls back to last in reverse', document.activeElement === candidates[1099]);
  mutableParent.style.display = '';
  candidates[511].focus(); host.key('Tab');
  check('restoring an ancestor restores its original preorder position', document.activeElement === candidates[512]);
  negative.focus(); host.key('Tab');
  check('a focused negative-tabindex node falls back to first', document.activeElement === candidates[0]);
  candidates[600].focus(); traversal.removeChild(candidates[600]); host.key('Tab');
  check('removing the focused node falls back safely to first', document.activeElement === candidates[0]);
  const prevent = event => { if (event.key === 'Tab') event.preventDefault(); };
  candidates[1024].addEventListener('keydown', prevent);
  candidates[1024].focus(); host.key('Tab');
  check('preventDefault still blocks traversal beyond the old collection limit', document.activeElement === candidates[1024]);
  candidates[1024].removeEventListener('keydown', prevent); host.key('Tab');
  check('removing preventDefault resumes the immediate preorder successor', document.activeElement === candidates[1025]);
  traversal.style.display = 'none'; host.key('Tab');
  check('an empty eligible tree leaves the current focus unchanged', document.activeElement === candidates[1025]);
  const only = document.createElement('view');
  only.tabIndex = 0; document.body.appendChild(only); only.focus();
  host.key('Tab'); check('one eligible node wraps forward to itself', document.activeElement === only);
  host.key('Tab', 'keydown', { shiftKey: true });
  check('one eligible node wraps backward to itself', document.activeElement === only);
  document.body.removeChild(only);
} finally {
  if (traversal.parentNode) traversal.parentNode.removeChild(traversal);
  for (const [node, display] of existing) node.style.display = display;
}
console.log(passed + ' input-event assertions passed');
