import { createTextInput } from './gui/sdk/js/textinput.mjs';
import { getDesktopTheme } from './desktop/shared/ui/themes.mjs';
import { inputAppearance } from './desktop/shared/ui/input-appearance.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
const results = [];
const input = createTextInput({ document, value: 'Selection AV cafe\u0301', fontSize: 20, padding: 8, width: 440 });
document.body.appendChild(input.root);
for (const id of ['server2003', 'aqua', 'lion', 'xp']) {
  const theme = getDesktopTheme(id);
  const baseline = createTextInput({ document, value: 'Selection AV cafe\u0301', fontSize: 20, padding: 8, width: 440 });
  const legacy = { ...inputAppearance(theme), fontSize: 20 };
  delete legacy.selectionTextColor;
  baseline.setAppearance(legacy); document.body.appendChild(baseline.root); host.render();
  baseline.root.focus(); baseline.selectAll(); host.render();
  const oldBox = baseline.root.firstChild.firstChild.getBoundingClientRect();
  let oldForeground = 0;
  for (let y = 0; y < oldBox.height; y++) for (let x = 0; x < oldBox.width; x++)
    if (host.pixel(oldBox.x + x, oldBox.y + y).toLowerCase() === theme.colors.selectionText) oldForeground++;
  baseline.root.blur(); document.body.removeChild(baseline.root);
  input.setAppearance({ ...inputAppearance(theme), fontSize: 20 }); host.render();
  input.root.focus(); input.selectAll(); host.render();
  const layer = input.root.querySelector('.input-selection-text'), r = input.root.firstChild.firstChild.getBoundingClientRect();
  const selection = input.getSelection(), caret = input.getCaret();
  let foreground = 0;
  for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++)
    if (host.pixel(r.x + x, r.y + y).toLowerCase() === theme.colors.selectionText) foreground++;
  check(foreground > 0 && input.root.firstChild.firstChild.style.backgroundColor === theme.colors.selection &&
    (layer ? layer.childNodes[0].childNodes[1].style.color : input.root.childNodes[1].style.color) === theme.colors.selectionText,
    'Actual theme selection has its configured foreground without changing the selection background');
  const root = input.root;
  input.setAppearance(inputAppearance(theme)); host.render();
  check(root === input.root && document.activeElement === root && input.getCaret() === caret &&
    JSON.stringify(input.getSelection()) === JSON.stringify(selection), 'Semantic font retheme preserves actual editing selection/focus');
  results.push({ id, foreground: theme.colors.selectionText, background: theme.colors.selection,
    oldForegroundPixels: oldForeground, foregroundPixels: foreground });
  root.blur(); host.render();
}
document.body.removeChild(input.root);
console.log('SELECTION_THEME_PIXELS ' + JSON.stringify(results));
