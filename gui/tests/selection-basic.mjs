import { h, render } from './gui/sdk/js/reconciler.mjs';
import { NSwitch, NCheckbox, NRadioGroup, useTheme, theme } from './gui/sdk/js/naive.mjs';

const check = (value, message) => { if (!value) throw new Error(message); console.log('PASS: ' + message); };
const calls = [];
let value = false, checked = false, radio = 'a', disabled = false, vertical = false;
const options = [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Blocked', disabled: true },
  { value: 'c', label: 'Charlie' }];
const original = JSON.stringify(options);
function paint() {
  render(h('view', { style: { width: '100%', height: '100%', padding: 20, gap: 14, alignItems: 'flex-start', backgroundColor: theme.body } },
    h('view', { id: 'before', tabIndex: 0, style: { width: 60, height: 20 } }, 'Before'),
    NSwitch({ id: 'switch', value, disabled, onUpdate: next => { calls.push(['switch', next]); value = next; paint(); } }),
    NCheckbox({ id: 'checkbox', checked, disabled, onChange: next => { calls.push(['checkbox', next]); checked = next; paint(); } }, 'Check'),
    NRadioGroup({ id: 'radio', value: radio, options, disabled, vertical, onUpdate: next => { calls.push(['radio', next]); radio = next; paint(); } }),
    h('view', { id: 'after', tabIndex: 0, style: { width: 60, height: 20 } }, 'After')), document.body);
  host.render();
}
const key = (name, extra = {}) => { host.key(name, 'keydown', { text: false, ...extra }); host.render(); };
const find = id => document.getElementById(id);
const pixels = node => {
  const r = node.getBoundingClientRect(), result = [];
  for (let y = r.y; y < r.bottom; y++) for (let x = r.x; x < r.right; x++) result.push(host.pixel(x, y));
  return result.join('');
};
paint();
find('before').focus(); key('Tab');
check(document.activeElement === find('switch'), 'Tab enters the switch');
const sw = find('switch'), box = sw.getBoundingClientRect(), unfocused = pixels(find('checkbox'));
key('Enter'); check(calls.length === 0, 'Switch Enter is not a blind toggle');
key(' '); check(value && sw.getAttribute('aria-checked') === 'true' && calls.length === 1, 'Space toggles controlled switch once');
key(' ', { repeat: true }); check(calls.length === 1, 'Held activation key does not repeat');
key('Tab');
const cb = find('checkbox');
check(document.activeElement === cb && pixels(cb) !== unfocused, 'Checkbox is reachable and has actual visible focus pixels');
key(' '); check(checked && cb.getAttribute('aria-checked') === 'true' && calls.length === 2, 'Checkbox Space updates controlled checked truth once');
key('Tab');
let radios = Array.from(find('radio').childNodes);
check(document.activeElement === radios[0], 'Tab enters the selected radio, not the entire group');
let composingUpdates = 0, composingPrevented = 0;
const composingControls = [
  NSwitch({ onUpdate: () => composingUpdates++ }),
  NCheckbox({ onChange: () => composingUpdates++ }),
  NRadioGroup({ value: 'a', options, onUpdate: () => composingUpdates++ }).children[2],
];
for (const control of composingControls)
  for (const name of [' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'])
    control.props.onKeydown({ key: name, isComposing: true, currentTarget: radios[2],
      preventDefault() { composingPrevented++; }, stopPropagation() { composingPrevented++; } });
check(composingUpdates === 0 && composingPrevented === 0 && document.activeElement === radios[0],
  'Composing switch, checkbox and radio keys neither select, move focus nor consume the IME event');
key('ArrowRight'); check(radio === 'c' && document.activeElement === radios[2], 'Radio arrow skips disabled option and selects the next enabled item');
key('Home'); check(radio === 'a' && document.activeElement === radios[0], 'Radio Home selects first enabled');
key('End'); check(radio === 'c', 'Radio End selects last enabled');
key('Tab'); check(document.activeElement === find('after'), 'Radio group occupies one Tab stop');
const count = calls.length;
disabled = true; paint();
find('before').focus(); key('Tab');
check(document.activeElement === find('after'), 'Group and individual disabled controls are skipped by Tab');
for (const node of [sw, cb, ...radios]) {
  node.focus(); key(' '); key('ArrowRight');
  const r = node.getBoundingClientRect();
  host.mouse('click', r.x + 3, r.y + 3);
  check(node.querySelector('.n-selection-focus').style.opacity === '0', 'Disabled focus paint remains hidden');
}
check(calls.length === count, 'Disabled controls and options never invoke callbacks');
disabled = false; paint();
for (const node of [sw, cb]) {
  const r = node.getBoundingClientRect();
  host.mouse('click', r.x + 3, r.y + 3, { button: 2 });
}
check(calls.length === count, 'Non-primary click does not activate selection controls');
for (const node of [sw, cb, radios[0]]) {
  const before = calls.length, r = node.getBoundingClientRect();
  host.mouse('mousedown', r.x + 3, r.y + 3);
  host.mouse('mouseup', r.x + 3, r.y + 3);
  host.mouse('click', r.x + 3, r.y + 3); host.render();
  check(calls.length === before + 1, 'Primary pointer activation invokes exactly one controlled callback');
}
const selectedCount = calls.length, selectedBox = radios[0].getBoundingClientRect();
host.mouse('mousedown', selectedBox.x + 3, selectedBox.y + 3);
host.mouse('mouseup', selectedBox.x + 3, selectedBox.y + 3);
host.mouse('click', selectedBox.x + 3, selectedBox.y + 3);
check(calls.length === selectedCount + 1 && calls.at(-1)[1] === 'a', 'Selected radio primary click retains the original callback contract');
cb.focus(); useTheme('dark'); paint();
check(find('checkbox') === cb && document.activeElement === cb &&
  cb.querySelector('.n-selection-focus').style.opacity === '1', 'Dark retheme preserves node/focus and focus paint');
check(sw.getBoundingClientRect().width === box.width && sw.getBoundingClientRect().height === box.height,
  'Focus/theme changes do not move the switch hitbox');
useTheme('light'); paint(); cb.blur(); host.render();
check(cb.querySelector('.n-selection-focus').style.opacity === '0', 'Blur clears focus without rerender');
check(JSON.stringify(options) === original, 'Controlled options and values are not mutated');
vertical = true; radio = 'a'; paint(); radios[0].focus(); key('ArrowDown');
check(radio === 'c' && document.activeElement === radios[2], 'Vertical radio Down skips a disabled row');
key('ArrowUp'); check(radio === 'a', 'Vertical radio Up restores first enabled row');
console.log('PASS: actual basic selection keyboard, disabled, pointer, controlled, focus and theme lifecycle');
