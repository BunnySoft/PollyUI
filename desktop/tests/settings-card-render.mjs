import { render } from './gui/sdk/js/reconciler.mjs';
import { settingsCard } from './desktop/shared/ui/presentation.mjs';
import { button } from './desktop/shared/ui/button.mjs';
import { getDesktopTheme } from './desktop/shared/ui/themes.mjs';
import { panelAppearance } from './desktop/shared/ui/panel-appearance.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
export function checkSettingsCardAdoption() {
  let calls = 0;
  const results = [];
  for (const id of ['server2003', 'modern']) {
    const theme = getDesktopTheme(id);
    render(settingsCard(theme, 'Card title', 'Original subtitle', [
      button('card-action', 'Original action', theme, () => calls++)], 'card-root'), document.body);
    host.render();
    const card = document.getElementById('card-root'), expected = panelAppearance(theme, 'card');
    check(Number(card.style.padding) === expected.padding && Number(card.style.gap) === expected.gap &&
      Number(card.style.borderWidth) === expected.borderWidth && Number(card.style.borderRadius) === expected.borderRadius,
      'Shared card shape and spacing come from the frozen panel projection');
    const r = card.getBoundingClientRect(), x = Math.floor(r.x + r.width / 2), y = Math.floor(r.y + r.height / 2);
    const edges = [host.pixel(x, r.y), host.pixel(x, r.bottom - 1), host.pixel(r.x, y), host.pixel(r.right - 1, y)];
    if (id === 'server2003') check(edges.join(':') === '#808080:#FFFFFF:#808080:#FFFFFF',
      'Actual card bevel alone owns all four outside edges');
    document.getElementById('card-action').focus();
    host.key(' ', 'keydown', { text: false }); host.render();
    check(calls === results.length + 1 && card.textContent.includes('Card title') && card.textContent.includes('Original subtitle'),
      'Passive panel decoration preserves the original children and one action');
    results.push({ id, padding: expected.padding, borderWidth: expected.borderWidth,
      radius: expected.borderRadius, edges, card: [r.x, r.y, r.width, r.height] });
  }
  document.activeElement?.blur(); render(null, document.body);
  console.log('SETTINGS_CARD_ADOPTION ' + JSON.stringify({ results, calls }));
}
