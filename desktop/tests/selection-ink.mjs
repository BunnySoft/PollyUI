import assert from 'node:assert/strict';
import { register } from 'node:module';
register('./root-loader.mjs', import.meta.url);
const { DESKTOP_THEMES } = await import('../shared/ui/themes.mjs');
const { desktopCommand } = await import('../shared/ui/presentation.mjs');
const { desktopView } = await import('../shell/desktop-view.mjs');
const descendants = node => node ? [node, ...(node.children || []).flatMap(descendants)] : [];
const part = (node, name) => descendants(node).find(child => child.props?.className === name);
const item = { id: 'missing', name: 'Caption', x: 0, y: 0 };
for (const original of DESKTOP_THEMES) {
  for (const mode of ['shipped', 'custom', 'missing']) {
    const theme = { ...original, colors: { ...original.colors } };
    if (mode === 'custom') theme.colors.selectionText = '#e040d0';
    if (mode === 'missing') delete theme.colors.selectionText;
    const legacy = theme.button.surfaceStyle === 'classic' ? theme.colors.accentText : theme.colors.text;
    const selected = desktopCommand('quiet', 'Quiet', theme, () => {}, { quiet: true, selected: true, icon: 'folder' });
    const ordinary = desktopCommand('ordinary', 'Ordinary', theme, () => {}, { selected: true });
    const disabled = desktopCommand('disabled', 'Disabled', theme, () => {}, { quiet: true, selected: true, enabled: false, icon: 'folder' });
    assert.equal(part(selected, 'theme-command-label').props.style.color, theme.colors.selectionText ?? legacy);
    assert.equal(part(ordinary, 'theme-command-label').props.style.color, legacy, 'Nonquiet face never opts into selection foreground');
    assert.equal(part(disabled, 'theme-command-label').props.style.color, theme.colors.muted);
    for (const stroke of descendants(part(selected, 'theme-command-icon'))) {
      if (stroke.props?.className === 'theme-icon-ink-fill')
        assert.equal(stroke.props.style.backgroundColor, theme.colors.selectionText ?? theme.colors.accent);
      if (stroke.props?.className === 'theme-icon-ink-border')
        assert.equal(stroke.props.style.borderColor, theme.colors.selectionText ?? theme.colors.accent);
    }
    const tree = desktopView(theme, '', { items: [item], selected: new Set([item.id]), focused: item.id },
      [{ ...item, unavailable: 'Missing fixture application' }]);
    const option = descendants(tree).find(node => node.props?.role === 'option');
    assert.equal(option.children[1].props.style.color, theme.colors.selectionText ?? theme.colors.text);
    assert.equal(option.children[2].props.style.color, theme.colors.selectionText ?? theme.colors.text);
    assert.equal(option.children[0].children[0].props.style.borderColor, theme.colors.selectionText ?? theme.colors.accent);
    assert.equal(option.props['aria-selected'], 'true');
  }
}
console.log('PASS: six-theme/custom/missing semantic ink for quiet commands and desktop caption/status/monochrome art; ordinary/disabled contracts preserved');
