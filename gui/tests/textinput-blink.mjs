import { createTextInput } from './gui/sdk/js/textinput.mjs';

const check = (value, message) => {
  if (!value) throw new Error(message);
  console.log('PASS: ' + message);
};
const input = createTextInput({ value: 'abc', width: 240, fontSize: 20, color: '#123456' });
document.body.appendChild(input.root);
host.render(0);
const caret = input.root.childNodes[2];
const visible = () => caret.style.backgroundColor === '#123456';
input.root.focus();
check(visible(), 'focus immediately reveals the caret');
host.render(100);
host.render(629);
check(visible(), 'caret remains visible before the 530 ms interval');
const caretPixel = () => {
  const bounds = caret.getBoundingClientRect();
  return host.pixel(Math.floor(bounds.x + bounds.width / 2), Math.floor(bounds.y + bounds.height / 2));
};
check(caretPixel() === '#123456', 'the visible caret reaches the rendered pixels');
host.render(630);
check(!visible(), 'idle focused caret turns off at 530 ms');
check(caretPixel() !== '#123456', 'the hidden phase removes the rendered caret pixels');
host.render(1160);
check(visible(), 'idle focused caret turns on again');
host.render(1690);
check(!visible(), 'second idle cycle turns off');

host.text('x');
check(input.value === 'abcx' && visible(), 'text input resets the caret immediately without changing edit semantics');
host.render(1700);
host.render(2230);
check(!visible(), 'blinking resumes after typing');
host.key('ArrowLeft', 'keydown', { text: false });
check(input.getCaret() === 3 && visible(), 'caret navigation resets the visible phase');
host.render(2240);
host.render(2770);
check(!visible(), 'navigation starts a fresh blink interval');
input.setAppearance({ background: '#ffffff' });
check(!visible(), 'unrelated appearance refresh does not restart blinking');
host.render(3300);
check(visible(), 'appearance refresh preserves the running blink clock');

input.selectAll();
host.render(3830);
check(visible(), 'a selected range retains the existing steady caret behavior');
host.key('ArrowRight', 'keydown', { text: false });
check(visible(), 'collapsing selection reveals the caret');
host.compose('pending', 7, 0);
host.render(4000);
host.render(4530);
check(visible(), 'composition with a visible cursor does not blink it away');
host.compose('');
input.root.blur();
host.render(6000);
check(!visible(), 'blur hides the caret and stops its animation');

const another = createTextInput({ value: 'peer', color: '#abcdef' });
document.body.appendChild(another.root);
input.root.focus();
host.render(6100);
another.root.focus();
check(!visible(), 'another input owns focus exclusively');
host.render(6630);
check(another.root.childNodes[2].style.backgroundColor === '#abcdef',
  'the second input starts an independent visible phase');
host.render(7160);
check(another.root.childNodes[2].style.backgroundColor === 'transparent',
  'the second input blinks independently');
another.root.blur();

input.root.focus();
host.render(8000);
document.body.removeChild(input.root);
host.render(8530);
check(!visible(), 'detaching a focused input safely retires its pending blink');
document.body.appendChild(input.root);
host.render(9060);
check(!visible(), 'reattachment does not revive stale focus or animation');
input.root.focus();
check(visible(), 'an explicit refocus restarts the caret after reattachment');
input.root.blur();

const password = createTextInput({ value: 'secret', password: true });
document.body.appendChild(password.root);
password.root.focus();
host.render(10000);
host.render(10530);
check(password.root.childNodes[2].style.backgroundColor === 'transparent' &&
  password.root.childNodes[1].textContent === '\u2022'.repeat(6) && password.value === 'secret',
  'password caret blinks without exposing the value');
password.root.blur();
const legacySurface = { closed: false, setCursor() {} };
const legacy = createTextInput({ document, window: legacySurface, value: 'legacy host' });
document.body.appendChild(legacy.root);
legacy.root.focus();
host.render(11000);
host.render(11530);
check(legacy.root.childNodes[2].style.backgroundColor !== 'transparent',
  'a legacy Host without native state retains its steady focused caret');
legacySurface.closed = true;
host.render(12060);
legacy.root.blur();
check(legacy.root.childNodes[2].style.backgroundColor === 'transparent',
  'legacy Host blur retires the caret without requiring a state getter');
const originalFrame = globalThis.requestAnimationFrame;
let callbacks = 0;
try {
  globalThis.requestAnimationFrame = callback => originalFrame(timestamp => { callbacks++; callback(timestamp); });
  requestAnimationFrame(() => { input.root.blur(); input.root.focus(); });
  input.root.focus();
  host.render(20000);
  callbacks = 0;
  host.render(20010);
  check(callbacks === 1, 'refocus during a frame batch cannot revive the cancelled blink loop');
  input.root.blur();
} finally { globalThis.requestAnimationFrame = originalFrame; }
console.log('PASS: shared text input caret blink, reset, selection, composition and focus lifecycle');
