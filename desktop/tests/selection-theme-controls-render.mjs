import { h, createApp, reactive } from './gui/sdk/js/vue.mjs';
import { render } from './gui/sdk/js/reconciler.mjs';
import { NOverlayHost, theme as sdkTheme } from './gui/sdk/js/naive.mjs';
import { getDesktopTheme } from './desktop/shared/ui/themes.mjs';
import { themedSwitch, themedCheckbox, themedRadioGroup, themedTabs, themedSelect, themedMenu } from './desktop/shared/ui/selection-controls.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
const ids = ['server2003', 'xp', 'aqua', 'lion', 'bigsur', 'modern'];
const settle = async () => { for (let i = 0; i < 4; i++) { await Promise.resolve(); host.render(); } };
const rect = node => { const r = node.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
const key = async name => { host.key(name, 'keydown', { text: false }); await settle(); };
const pointer = async (node, type, button = 0) => {
  const r = node.getBoundingClientRect();
  host.mouse(type, r.x + r.width / 2, r.y + r.height / 2, { button }); await settle();
};
const click = async (node, button = 0) => {
  for (const type of ['mousedown', 'mouseup', 'click']) await pointer(node, type, button);
};
export async function checkThemedSelectionControls(directory) {
  check(host.width === 1280 && host.height === 900, 'One actual scale-1 six-theme component sheet');
  const model = reactive({ override: null, disabled: false, check: false, switch: true, radio: 'a', tab: 'a', menu: 'a', value: 'a',
    options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Blocked', disabled: true }, { value: 'c', label: 'Charlie' }] });
  const calls = [];
  const update = (kind, id) => value => { calls.push([kind, id, value]); model[kind] = value; };
  createApp({ setup: () => () => h('view', { style: { width: '100%', height: '100%', backgroundColor: '#ffffff' } },
    ids.map((id, index) => {
      const theme = getDesktopTheme(index === 0 && model.override ? model.override : id);
      const props = suffix => ({ id: id + '-' + suffix, disabled: model.disabled });
      const column = (width, child) => h('view', { style: { width, minWidth: 0, flexShrink: 0 } }, child);
      return h('view', { id: id + '-row', style: { height: 146, flexShrink: 0, padding: 10, gap: 12, backgroundColor: theme.colors.body } },
        h('view', { style: { color: theme.colors.text, fontSize: theme.layout.fontSize } }, theme.name),
        h('view', { style: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 } },
          column(65, themedSwitch(theme, { ...props('switch'), value: model.switch, onUpdate: update('switch', id), 'aria-label': 'Switch ' + id })),
          column(140, themedCheckbox(theme, { ...props('check'), checked: model.check, onChange: update('check', id) }, 'Checkbox')),
          column(165, themedRadioGroup(theme, { ...props('radio'), value: model.radio, onUpdate: update('radio', id),
            options: model.options })),
          column(200, themedTabs(theme, { ...props('tabs'), value: model.tab, onUpdate: update('tab', id),
            panes: model.options.map(option => ({ name: option.value, label: option.label, disabled: option.disabled, content: 'Themed pane' })) })),
          column(150, themedSelect(theme, { ...props('select'), value: model.value, onUpdate: update('value', id),
            width: 150, options: model.options })),
          column(200, themedMenu(theme, { ...props('menu'), value: model.menu, onUpdate: update('menu', id),
            mode: 'horizontal', items: model.options.map(option => ({ key: option.value, label: option.label, disabled: option.disabled })) }))));
    }), NOverlayHost()) }).mount(document.body);
  await settle();
  const find = id => document.getElementById(id), results = [];
  const sdkBefore = JSON.stringify(sdkTheme);
  for (const id of ids) {
    const theme = getDesktopTheme(id), box = find(id + '-check').querySelector('.n-selection-marker');
    const sw = find(id + '-switch');
    const result = { id, switch: rect(sw), checkbox: rect(box), markerFill: box.style.backgroundColor,
      markerRadius: box.style.borderRadius, labelFont: Number(find(id + '-check').querySelector('.n-selection-label').style.fontSize),
      switchFill: sw.style.backgroundColor };
    check(result.labelFont === theme.layout.fontSize && result.switchFill === theme.colors.accent,
      'Each instance consumes its own complete theme rather than module-global green');
    results.push(result);
  }

  check(host.save(directory + '/six-theme-selection.png'), 'Save actual shared six-theme sheet');
  for (const id of ids) {
    const marker = find(id + '-check').querySelector('.n-selection-marker'), theme = getDesktopTheme(id);
    host.mouse('mousemove', 1279, 899); await settle();
    await pointer(find(id + '-check'), 'mousemove');
    check(marker.style.borderColor === theme.colors.accent, 'Hovered marker consumes its own accent edge');
    await pointer(find(id + '-switch'), 'mousedown');
    const knob = find(id + '-switch').querySelector('.n-selection-knob');
    check(knob.style.backgroundColor === theme.button.to, 'Held knob consumes its own pressed face');
    await pointer(find(id + '-switch'), 'mousecancel');
    check(knob.style.backgroundColor === theme.button.from, 'Cancel restores the same theme face without activating');
  }
  const classic = find('server2003-check'), luna = find('xp-check'), originalClassic = rect(classic), beforeCount = calls.length;
  classic.focus(); await settle(); await key(' ');
  check(model.check && classic.getAttribute('aria-checked') === 'true' && calls.length === beforeCount + 1,
    'Themed checkbox retains controlled Space semantics exactly once');
  const ring = classic.querySelector('.theme-focus-ring');
  check(Number(ring.style.opacity) === 1 && classic.querySelector('.classic-focus-paint'),
    'Classic uses the existing repeat-Canvas focus and original detail ancestry');
  luna.focus(); await settle();
  check(luna.querySelector('.luna-focus-paint') && Number(luna.querySelector('.luna-focus-ring').style.opacity) === 1,
    'Luna reuses its complete Canvas focus instead of the retired fixed dots');
  const classicFill = find('server2003-switch').style.backgroundColor;
  model.override = 'modern'; await settle();
  check(find('server2003-check') === classic && find('server2003-switch').style.backgroundColor === getDesktopTheme('modern').colors.accent &&
    find('xp-switch').style.backgroundColor === getDesktopTheme('xp').colors.accent && classicFill !== find('server2003-switch').style.backgroundColor,
    'Retained per-instance retheme updates only that instance, without global bleed');
  check(JSON.stringify(sdkTheme) === sdkBefore, 'Desktop adapter never mutates the module-global SDK theme');
  model.override = null; await settle();
  check(rect(classic).join(':') === originalClassic.join(':'), 'Restoring a theme restores its actual configured control geometry');
  const trigger = find('server2003-select'); trigger.focus(); await key('Enter');
  let list = document.querySelector('.n-select-list');
  check(list && list.style.backgroundColor === getDesktopTheme('server2003').colors.surface &&
    list.querySelector('.n-selection-label').style.fontSize === String(getDesktopTheme('server2003').layout.fontSize),
    'The portal consumes the same instance palette and row typography');
  model.override = 'aqua'; await settle();
  check(document.querySelector('.n-select-list') === list && find('server2003-select') === trigger &&
    document.activeElement === trigger && list.querySelector('.n-select-option').style.height ===
      String(Math.max(getDesktopTheme('aqua').layout.buttonHeight, getDesktopTheme('aqua').layout.fontSize + 10)),
    'Open popup retheme retains trigger/list DOM and applies its current metrics');
  await key('End'); await key('Enter');
  check(model.value === 'c' && !document.querySelector('.n-select-list'), 'Themed portal navigation/commit still uses original controlled callbacks');
  model.disabled = true; await settle();
  const disabledCalls = calls.length;
  for (const id of ids) {
    const node = find(id + '-switch'); node.focus(); await key(' '); await click(node);
    check(node.getAttribute('aria-disabled') === 'true' && node.tabIndex === -1,
      'Disabled per-instance semantics are not replaced by decoration');
  }
  check(calls.length === disabledCalls, 'Disabled themed controls cannot emit a callback');
  check(host.save(directory + '/six-theme-selection-disabled.png'), 'Save bounded disabled-state sheet');
  model.disabled = false; model.override = null; await settle();
  const group = find('server2003-radio'); group.firstChild.focus(); await key('ArrowRight');
  check(model.radio === 'c', 'Themed radio still skips the disabled option');
  find('xp-tabs-tab-0').focus(); await key('End');
  check(model.tab === 'c', 'Themed tab activation selects the matching pane');
  find('modern-menu-item-0').focus(); await key('ArrowRight'); await key('Enter');
  check(model.menu === 'c', 'Themed menu retains horizontal roving and one activation');
  await click(find('aqua-check'), 2);
  check(model.check, 'Non-primary click does not toggle a themed checkbox');
  document.activeElement?.blur(); await settle();
  console.log('SIX_THEME_SELECTION ' + JSON.stringify({ results, calls, sameDOM: true,
    globalsUnchanged: JSON.stringify(sdkTheme) === sdkBefore, scope: 'Actual shared components, not qualified OS screenshot equivalence' }));
}

export function checkClassicSelectionEdges(verify = true) {
  const theme = getDesktopTheme('server2003');
  render(h('view', { style: { padding: 20, gap: 20, alignItems: 'flex-start', backgroundColor: theme.colors.body } },
    themedCheckbox(theme, { id: 'edge-checkbox', checked: true }, 'Checkbox'),
    themedSwitch(theme, { id: 'edge-switch', value: false }),
    themedSelect(theme, { id: 'edge-select', value: 'a', options: [{ value: 'a', label: 'Selected' }] }),
    themedTabs(theme, { id: 'edge-tabs', value: 'a', panes: [{ name: 'a', label: 'Active tab', content: 'Pane' }] })),
  document.body);
  host.render();
  const find = id => document.getElementById(id);
  const components = [
    [find('edge-checkbox'), find('edge-checkbox').querySelector('.n-selection-marker'), 'checkbox', ['#808080', '#ffffff', '#808080', '#ffffff']],
    [find('edge-switch'), find('edge-switch').querySelector('.n-selection-knob'), 'knob', ['#ffffff', '#404040', '#ffffff', '#404040']],
    [find('edge-select'), find('edge-select'), 'select', ['#808080', '#ffffff', '#808080', '#ffffff']],
    [find('edge-tabs-tab-0'), find('edge-tabs-tab-0'), 'tab', ['#ffffff', '#404040', '#ffffff', '#404040']],
  ];
  const samples = [];
  for (const [control, part, kind, expected] of components) {
    for (const phase of ['initial', 'hover', 'down', 'cancel', 'leave']) {
      const r = control.getBoundingClientRect();
      if (phase !== 'initial') host.mouse({ hover: 'mousemove', down: 'mousedown', cancel: 'mousecancel', leave: 'mousemove' }[phase],
        phase === 'leave' ? 799 : r.x + r.width / 2, phase === 'leave' ? 599 : r.y + r.height / 2);
      host.render();
      const p = part.getBoundingClientRect(), x = Math.floor(p.x + p.width / 2), y = Math.floor(p.y + p.height / 2);
      const edges = [host.pixel(x, p.y), host.pixel(x, p.bottom - 1), host.pixel(p.x, y), host.pixel(p.right - 1, y)];
      samples.push({ kind, phase, box: [p.x, p.y, p.width, p.height], edges });
      if (verify) check(edges.every((color, index) => color.toLowerCase() === expected[index]),
        'Passive Classic bevel owns all real outer pixels through ' + kind + '/' + phase + ': ' + JSON.stringify(edges));
    }
  }
  console.log('CLASSIC_SELECTION_BEVEL ' + JSON.stringify({ verify, samples, edgeOrder: ['top', 'bottom', 'left', 'right'] }));
}
