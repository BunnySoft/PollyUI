import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
register('./root-loader.mjs', import.meta.url);
const { DESKTOP_THEMES } = await import('../shared/ui/themes.mjs');
const { panelAppearance } = await import('../shared/ui/panel-appearance.mjs');
const { settingsView } = await import('../apps/settings/ui/appearance.mjs');
const { shortcutsView } = await import('../apps/settings/ui/keyboard.mjs');
const flatten = node => node && typeof node === 'object' ? [node, ...(node.children ?? []).flatMap(flatten)] : [];
const noop = () => {};

test('Settings error/status and keyboard cards share passive theme surfaces and preserve actions', () => {
  for (const theme of DESKTOP_THEMES) {
    const appearance = settingsView(theme, noop, noop, noop, 'An explicit fixture error', true,
      null, null, null, null, null, null, true, 'Fixture status');
    for (const role of ['alert', 'status']) {
      const node = flatten(appearance).find(node => node.props?.role === role);
      assert.equal(node.props.style.borderRadius, panelAppearance(theme).borderRadius);
      assert.equal(node.props.style.padding, panelAppearance(theme).padding);
      assert.equal(node.children.some(child => child.props?.className === 'theme-bevel'),
        theme.button.surfaceStyle === 'classic');
      if (role === 'status') assert.equal(node.children.at(-1).props.style.color,
        theme.colors.selectionText ?? theme.colors.text, 'selected status text remains readable in Classic/Aqua');
    }
    const calls = [];
    const keyboard = shortcutsView(theme, [{ action: 'switch', label: 'Switch windows', key: 'Tab', modifiers: [] }],
      null, action => calls.push(action), noop, noop, noop);
    const nodes = flatten(keyboard), change = nodes.find(node => node.props?.id === 'shell-shortcut-switch');
    const card = nodes.find(node => node.children?.some(child => child.children?.includes(change)));
    for (const [key, value] of Object.entries(panelAppearance(theme))) assert.equal(card.props.style[key], value);
    change.props.onKeydown({ key: 'Enter', preventDefault() {}, stopPropagation() {} });
    assert.deepEqual(calls, ['switch']);
  }
});
