import { h, render } from './gui/sdk/js/reconciler.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
export function selectionScene(sdk) {
  return h('view', { style: { width: '100%', height: '100%', padding: 20, gap: 14, alignItems: 'flex-start',
    backgroundColor: sdk.theme.body } },
    sdk.NSwitch({ id: 'switch', value: true, 'aria-label': 'Enabled switch' }),
    sdk.NCheckbox({ id: 'checkbox', checked: true }, 'Selected checkbox'),
    sdk.NCheckbox({ id: 'unchecked', checked: false }, 'Unselected checkbox'),
    sdk.NRadioGroup({ id: 'radio', value: 'a', options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }] }),
    sdk.NTabs({ id: 'tabs', value: 'a', panes: [{ name: 'a', label: 'First', content: 'Pane A' }, { name: 'b', label: 'Second', content: 'Pane B' }] }),
    sdk.NSelect({ id: 'select', value: 'a', options: [{ value: 'a', label: 'Apple' }, { value: 'b', label: 'Banana' }] }),
    sdk.NMenu({ id: 'menu', value: 'a', items: [{ key: 'a', label: 'First item' }, { key: 'b', label: 'Second item' }] }));
}
export function checkSelectionAppearance(sdk, directory) {
  for (const name of ['light', 'dark']) {
    sdk.useTheme(name);
    render(selectionScene(sdk), document.body);
    host.render();
    check(host.save(directory + '/' + name + '.png'), 'Save actual default-pixel guard');
    const root = document.body.firstChild;
    console.log('SELECTION_DEFAULT ' + JSON.stringify({ name, boxes: Array.from(root.childNodes).map(node => {
      const r = node.getBoundingClientRect(); return [r.x, r.y, r.width, r.height];
    }) }));
  }
}
export function checkSelectionFocus(sdk) {
  const pixels = node => {
    const r = node.getBoundingClientRect(), result = [];
    for (let y = r.y; y < r.bottom; y++) for (let x = r.x; x < r.right; x++) result.push(host.pixel(x, y));
    return result;
  };
  const results = [];
  for (const name of ['light', 'dark']) {
    sdk.useTheme(name); render(selectionScene(sdk), document.body); host.render();
    const find = id => document.getElementById(id);
    for (const node of [find('switch'), find('checkbox'), find('unchecked'), find('radio').firstChild,
      find('tabs').firstChild.firstChild, find('select'), find('menu').firstChild]) {
      const box = JSON.stringify(node.getBoundingClientRect()), before = pixels(node);
      node.focus(); host.render();
      const focused = pixels(node), changed = before.filter((pixel, index) => pixel !== focused[index]).length;
      check(changed > 0 && box === JSON.stringify(node.getBoundingClientRect()), 'Every enabled selected/unselected control has visible, nonmoving focus');
      node.blur(); host.render();
      const blurred = pixels(node);
      check(before.every((pixel, index) => pixel === blurred[index]), 'Blur restores all control pixels');
      results.push({ name, role: node.getAttribute('role'), changed });
    }
  }
  console.log('SELECTION_FOCUS_PIXELS ' + JSON.stringify(results));
}
export async function checkNativeSelectionDPI(sdk, directory) {
  const pause = () => new Promise(resolve => setTimeout(resolve, 80));
  const child = window.create({ title: 'Naive.selection.DPI', width: 800, height: 600 });
  const owner = child.document, previous = globalThis.document;
  globalThis.document = owner;
  try { sdk.useTheme('light'); render(selectionScene(sdk), owner.body); }
  finally { globalThis.document = previous; }
  await pause();
  const checkbox = owner.getElementById('checkbox');
  checkbox.focus();
  const results = [];
  for (const dpi of [96, 144, 192]) {
    ownerTest.resize('Naive.selection.DPI', 800, 600, dpi);
    await pause();
    const state = child.state, r = checkbox.getBoundingClientRect();
    check(state.scale === dpi / 96 && Math.abs(state.pixelWidth - state.width * state.scale) <= 1 &&
      owner.activeElement === checkbox && checkbox.getAttribute('aria-checked') === 'true',
      'Actual host-adapter DPI preserves controlled state, focus and native physical/logical dimensions');
    results.push({ scale: state.scale, width: state.width, pixelWidth: state.pixelWidth, box: [r.x, r.y, r.width, r.height] });
    child.capture(directory + '/native-' + dpi + '.png');
  }
  console.log('SELECTION_HOST_ADAPTER_DPI ' + JSON.stringify(results));
  console.log('PASS: real window at 1/1.5/2 adapter boundaries; not monitor-DPI or Linux compositor qualification');
  child.close(); window.quit();
}
