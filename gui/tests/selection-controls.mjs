import { h, createApp, reactive } from './gui/sdk/js/vue.mjs';
import { NTabs, NSelect, NMenu, NOverlayHost, useTheme, theme } from './gui/sdk/js/naive.mjs';

const check = (value, message) => { if (!value) throw new Error(message); console.log('PASS: ' + message); };
const model = reactive({ tab: 'a', menu: 'a', select: 'a', disabled: false, showSelect: true, replaceSelect: false,
  options: [{ value: 'a', label: 'Apple' }, { value: 'b', label: 'Blocked', disabled: true }, { value: 'c', label: 'Cherry' }],
  blockedLast: false, tick: 0, selectWidth: 180, horizontal: false, callbackVersion: 0 });
const calls = [];
const callback = kind => {
  const version = model.callbackVersion;
  return value => { calls.push([kind, value, version]); model[kind] = value; };
};
const find = id => document.getElementById(id);
const settle = async () => {
  for (let i = 0; i < 3; i++) { await Promise.resolve(); host.render(); }
};
const key = async (name, extra = {}) => { host.key(name, 'keydown', { text: false, ...extra }); await settle(); };
const click = async (node, button = 0) => {
  const r = node.getBoundingClientRect();
  host.mouse('mousedown', r.x + r.width / 2, r.y + r.height / 2, { button });
  host.mouse('mouseup', r.x + r.width / 2, r.y + r.height / 2, { button });
  host.mouse('click', r.x + r.width / 2, r.y + r.height / 2, { button });
  await settle();
};
const list = () => document.querySelector('.n-select-list');
const options = () => list()?.querySelectorAll('.n-select-option') || [];
createApp({ setup: () => () => {
  void model.tick;
  return h('view', { style: { width: '100%', height: '100%', backgroundColor: theme.body } },
    h('view', { style: { padding: 20, gap: 12 } },
      h('view', { id: 'before', tabIndex: 0, style: { width: 60, height: 18 } }, 'Before'),
      NTabs({ id: 'tabs', value: model.tab, disabled: model.disabled, onUpdate: callback('tab'),
        panes: [{ name: 'a', label: 'First', content: 'Pane A' }, { name: 'b', label: 'Blocked', disabled: true, content: 'Pane B' },
          { name: 'c', label: 'Last', disabled: model.blockedLast, content: 'Pane C' }] }),
      model.showSelect ? model.replaceSelect ? h('canvas', { id: 'replaced-select', style: { width: 180, height: 34 } }) :
        NSelect({ id: 'select', value: model.select, options: model.options, width: model.selectWidth,
          disabled: model.disabled, onUpdate: callback('select') }) : null,
      NMenu({ id: 'menu', value: model.menu, disabled: model.disabled, mode: model.horizontal ? 'horizontal' : 'vertical', onUpdate: callback('menu'),
        items: [{ key: 'a', label: 'Menu A' }, { key: 'b', label: 'Blocked menu', disabled: true },
          { key: 'c', label: 'Menu C', disabled: model.blockedLast }] }),
      h('view', { id: 'after', tabIndex: 0, style: { width: 60, height: 18 } }, 'After')),
    NOverlayHost());
} }).mount(document.body);
await settle();
let composingPrevented = 0;
const composingKeys = node => {
  for (const key of ['Enter', ' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Tab', 'Escape'])
    node.__listeners.keydown({ key, isComposing: true, currentTarget: node,
      preventDefault() { composingPrevented++; }, stopPropagation() { composingPrevented++; } });
};
const initialFocus = document.activeElement;
for (const node of [find('tabs-tab-2'), find('select'), find('menu-item-2')]) composingKeys(node);
check(composingPrevented === 0 && calls.length === 0 && !list() && document.activeElement === initialFocus,
  'Composing tabs, Select and Menu keys preserve selection, focus and the closed portal without consuming IME events');
find('before').focus(); await key('Tab');
check(document.activeElement === find('tabs-tab-0'), 'Tab enters the selected tab');
await key('ArrowRight');
check(model.tab === 'c' && document.activeElement === find('tabs-tab-2') &&
  find('tabs-panel').textContent === 'Pane C' && find('tabs-tab-2').getAttribute('aria-selected') === 'true',
  'Tabs arrow skips disabled pane, selects and displays controlled content');
await key('Home'); check(model.tab === 'a', 'Tabs Home selects the first enabled pane');
await key('End'); check(model.tab === 'c', 'Tabs End selects the last enabled pane');
const tabCount = calls.length;
await key('Enter'); await key(' '); await key(' ', { repeat: true });
check(calls.length === tabCount, 'Activation of an already selected tab does not duplicate a change callback');
await key('Tab');
const trigger = find('select');
check(document.activeElement === trigger, 'Tabs has one Tab stop and exits to Select');
await key('Enter');
check(list() && trigger.getAttribute('aria-expanded') === 'true' && document.activeElement === trigger &&
  trigger.getAttribute('aria-activedescendant') === options()[0].id, 'Enter opens the window-local list with combobox focus retained');
const composingActive = trigger.getAttribute('aria-activedescendant'), composingCount = calls.length;
composingKeys(trigger);
check(composingPrevented === 0 && list() && trigger.getAttribute('aria-activedescendant') === composingActive &&
  calls.length === composingCount && document.activeElement === trigger,
  'Composing Select keys do not navigate, commit, close or steal focus from an open popup');
await key('ArrowDown');
check(trigger.getAttribute('aria-activedescendant') === options()[2].id, 'Select arrows skip disabled options');
await key('Enter');
check(model.select === 'c' && !list() && document.activeElement === trigger &&
  calls.filter(item => item[0] === 'select').length === 1, 'Select commit updates controlled value once and restores focus');
await key(' ');
check(list(), 'Space opens Select');
await key('Home'); await key('Escape');
check(!list() && model.select === 'c' && document.activeElement === trigger, 'Escape closes without committing or stealing trigger focus');
await key('ArrowUp'); check(list(), 'ArrowUp opens Select');
await key('Tab');
check(!list() && document.activeElement === find('menu-item-0'), 'Tab closes Select and exits normally without refocusing it');
await key('ArrowDown');
check(document.activeElement === find('menu-item-2') && model.menu === 'a', 'Menu arrows skip disabled items without activating');
await key('Enter');
check(model.menu === 'c' && calls.filter(item => item[0] === 'menu').length === 1, 'Menu Enter activates once');
await key('Home'); await key(' ');
check(model.menu === 'a' && calls.filter(item => item[0] === 'menu').length === 2, 'Menu Home/Space navigation and activation');
await key('End'); await key('Tab');
check(document.activeElement === find('after'), 'Menu is one roving Tab stop');
const count = calls.length;
model.disabled = true; await settle();
find('before').focus(); await key('Tab');
check(document.activeElement === find('after'), 'Disabled tabs/select/menu groups are skipped by Tab');
for (const node of [trigger, find('tabs-tab-2'), find('menu-item-2')]) {
  node.focus(); await key('Enter'); await key(' '); await key('ArrowDown'); await click(node);
  check(node.querySelector('.n-selection-focus').style.opacity === '0', 'Disabled group hides focus paint');
}
check(calls.length === count && !list(), 'Disabled groups never open or activate');
model.disabled = false; await settle();
await click(find('tabs-tab-1')); await click(find('menu-item-1'));
await click(trigger, 2); await click(find('tabs-tab-0'), 2); await click(find('menu-item-0'), 2);
check(calls.length === count && !list(), 'Disabled items and non-primary pointers do not activate');
trigger.focus(); await key('Enter');
await click(options()[1]);
check(list() && calls.length === count, 'Disabled Select option cannot commit by pointer');
await click(options()[0], 2);
check(list() && calls.length === count, 'Non-primary Select option click cannot commit');
model.select = 'a'; model.options = [{ value: 'a', label: 'Renamed Apple', disabled: true }, { value: 'z', label: 'Zebra' }];
await settle();
console.log('SELECT_DYNAMIC ' + JSON.stringify({ same: find('select') === trigger,
  active: document.activeElement?.id, list: Boolean(list()), options: Array.from(options()).map(node => [node.id, node.textContent, node.getAttribute('aria-disabled')]),
  activeDescendant: trigger.getAttribute('aria-activedescendant') }));
check(find('select') === trigger && document.activeElement === trigger &&
  options().length === 2 && options()[0].textContent === 'Renamed Apple' &&
  trigger.getAttribute('aria-activedescendant') === options()[1].id,
  'Open popup follows new value/options/disabled state with retained trigger DOM/focus');
model.callbackVersion = 1; await settle();
await key('Enter');
check(model.select === 'z' && calls.at(-1)[1] === 'z' && calls.at(-1)[2] === 1 && !list(),
  'Dynamic Select commits only the current enabled option through the latest callback, not a stale closure');
await key('Enter');
model.disabled = true; await settle();
check(!list() && trigger.getAttribute('aria-expanded') === 'false', 'Disabling an open trigger closes its popup');
model.disabled = false; model.options = []; await settle();
trigger.focus(); await key('Enter');
check(list() && list().textContent === 'No options' && !trigger.getAttribute('aria-activedescendant'), 'Empty list opens an explicit inert state');
const emptyCount = calls.length;
await key('ArrowDown'); await key('End'); await key('Enter'); await key('Escape');
check(calls.length === emptyCount && !list(), 'Empty list navigation cannot emit a value');
model.options = Array.from({ length: 24 }, (_, i) => ({ value: i, label: 'Long option ' + i, disabled: i === 22 }));
model.select = 0; await settle();
trigger.focus(); await key('Enter'); await key('End');
const longList = list(), last = options()[23], viewport = longList.getBoundingClientRect(), rect = last.getBoundingClientRect();
check(longList.scrollTop > 0 && rect.top >= viewport.top && rect.bottom <= viewport.bottom &&
  viewport.bottom <= host.height, 'Long list is viewport-bounded and keyboard End reveals the whole last row');
host.scroll(viewport.x + 8, viewport.y + 8, -10000); await settle();
check(longList.scrollTop === 0, 'Long-list wheel scrolling clamps to the first row without a timer loop');
await key('End');
useTheme('dark'); model.tick++; await settle();
check(list() === longList && find('select') === trigger && document.activeElement === trigger &&
  longList.style.backgroundColor === theme.card, 'Open light-to-dark retheme preserves trigger/list DOM and updates actual palette');
await key('Home'); await key(' ');
check(model.select === 0 && !list(), 'Long-list Home/Space commit uses the current controlled value');
trigger.focus(); await key('Enter');
model.showSelect = false; await settle();
check(!list(), 'Removing an open trigger closes the overlay');
model.showSelect = true; await settle();
find('select').focus(); await key('Enter');
model.replaceSelect = true; await settle();
check(!list(), 'Type-replacing an open trigger also closes its overlay without requiring an onLeave traversal');
model.replaceSelect = false; await settle();
find('select').focus(); await key('Enter');
await click(find('before'));
check(!list() && find('select').getAttribute('aria-expanded') === 'false', 'Backdrop close leaves no stale open flag');
model.selectWidth = 72;
model.options = [{ value: 'narrow', label: 'A long option label that must stay inside the narrow popup' }];
await settle();
find('select').focus(); await key('ArrowDown');
check(list().offsetWidth === 72 && list().getBoundingClientRect().right <= host.width &&
  options()[0].firstChild.style.overflow === 'hidden', 'Narrow popup preserves the configured hitbox and bounds long labels');
model.selectWidth = 120; await settle(); await settle();
check(list().offsetWidth === 120, 'Open popup remeasures a controlled trigger-width change after actual layout');
await key('Enter');
check(model.select === 'narrow' && !list(), 'Narrow option keyboard commit still works');
model.blockedLast = true; await settle();
find('tabs-tab-0').focus(); await key('End');
check(document.activeElement === find('tabs-tab-0') && find('tabs-tab-2').tabIndex === -1,
  'Dynamic individual tab disable leaves only the remaining enabled Tab stop');
find('menu-item-0').focus(); await key('ArrowDown');
check(document.activeElement === find('menu-item-0') && find('menu-item-2').tabIndex === -1,
  'Dynamic individual menu disable cannot receive roving focus');
model.blockedLast = false; await settle();
const pointerCount = calls.length;
await click(find('tabs-tab-2'));
await click(find('menu-item-2'));
check(calls.length === pointerCount + 2 && model.tab === 'c' && model.menu === 'c',
  'Enabled tab/menu primary clicks each invoke exactly one controlled callback');
const selectedTabCount = calls.length;
await click(find('tabs-tab-2'));
check(calls.length === selectedTabCount + 1 && calls.at(-1)[1] === 'c',
  'Selected tab primary click retains the original callback contract');
find('select').focus(); await key('Enter');
const commitCount = calls.length;
await click(options()[0]);
check(calls.length === commitCount + 1 && !list() && document.activeElement === find('select'),
  'Enabled Select option primary click commits once and restores actual focus');
model.horizontal = true; await settle();
find('menu-item-0').focus(); await key('ArrowRight');
check(document.activeElement === find('menu-item-2') && find('menu').getAttribute('role') === 'menubar',
  'Horizontal menu uses Left/Right roving navigation and a menubar role');
await key('ArrowLeft'); check(document.activeElement === find('menu-item-0'), 'Horizontal menu Left skips disabled entries');
useTheme('light'); model.tick++; await settle();
check(find('select').getAttribute('role') === 'combobox' && find('tabs-panel').getAttribute('role') === 'tabpanel',
  'Semantic roles survive light/dark and dynamic lifecycle');
console.log('PASS: actual Tabs/Select/Menu keyboard, disabled, dynamic controlled overlays, focus recovery and retheme');
