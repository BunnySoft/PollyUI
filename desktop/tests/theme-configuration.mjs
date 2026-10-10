import { BUILTIN_THEME_CATALOG, DESKTOP_THEMES, getDesktopTheme } from './desktop/shell/themes.mjs';
import { parseThemeCatalog, parseThemeFile, applyThemeOverrides } from './desktop/shell/theme-schema.mjs';
import { createTextInput } from './gui/sdk/js/textinput.mjs';

function check(value, message) {
  if (!value) throw new Error('FAIL: ' + message);
  console.log('PASS: ' + message);
}
function rejects(value, parser, message) {
  let error;
  try { parser(typeof value === 'string' ? value : JSON.stringify(value)); } catch (failure) { error = failure; }
  check(error instanceof Error, message);
}
const clone = value => JSON.parse(JSON.stringify(value));
const encodeOverride = themes => JSON.stringify({ schemaVersion: 1, themes });
const original = JSON.stringify(BUILTIN_THEME_CATALOG);
check(parseThemeCatalog(original).themes.length === 5, 'builtin presets are validated JSON data');
const custom = clone(getDesktopTheme('bigsur'));
custom.id = 'user-blue';
custom.name = 'User blue';
custom.colors.accent = '#234567';
const loaded = parseThemeFile(JSON.stringify({ schemaVersion: 1, theme: custom }));
check(loaded.id === 'user-blue' && Object.isFrozen(loaded.window), 'custom identifiers and immutable snapshots');
const overridden = applyThemeOverrides(BUILTIN_THEME_CATALOG,
  encodeOverride({ xp: { colors: { accent: '#123456' }, panel: { height: 44 } } }));
check(overridden.themes[0].panel.height === 44 && overridden.themes[0].colors.accent === '#123456',
  'bounded user overrides replace only selected visual tokens');
check(JSON.stringify(BUILTIN_THEME_CATALOG) === original && DESKTOP_THEMES[0].panel.height === 30,
  'override merging cannot mutate the active or builtin catalog');
check(overridden.themes[1] === BUILTIN_THEME_CATALOG.themes[1], 'unchanged immutable themes can be shared');

rejects({ ...clone(BUILTIN_THEME_CATALOG), schemaVersion: 2 }, parseThemeCatalog, 'unknown schema version rejected');
rejects({ ...clone(BUILTIN_THEME_CATALOG), default: 'missing' }, parseThemeCatalog, 'missing recovery default rejected');
const duplicate = clone(BUILTIN_THEME_CATALOG);
duplicate.themes.push(duplicate.themes[0]);
rejects(duplicate, parseThemeCatalog, 'duplicate theme identities rejected');
rejects({ schemaVersion: 1, default: 'xp', themes: [] }, parseThemeCatalog, 'empty catalog rejected');
rejects(' '.repeat(128 * 1024 + 1), parseThemeCatalog, 'oversized documents rejected before parsing');
rejects('{"schemaVersion":1,"theme":', parseThemeFile, 'truncated JSON rejected');
for (const [group, key, invalid] of [
  ['window', 'titleHeight', 10000], ['window', 'borderWidth', -1],
  ['window', 'radius', 1.25], ['window', 'controls', 'execute-command'],
  ['colors', 'accent', 'url(https://example.invalid)'], ['colors', 'accent', '#123456ff'],
  ['panel', 'height', '36'], ['button', 'gloss', 'true'],
  ['desktop', 'asset', '../outside.png'], ['desktop', 'asset', '/absolute.png'],
  ['desktop', 'asset', 'https://example.invalid/wallpaper.png'], ['desktop', 'asset', 'picture.svg'],
  ['window', 'hoverOpacity', 2], ['window', 'fontFamily', '/some/font/file'],
  ['window', 'controlSize', 64], ['layout', 'menuBarHeight', 4],
]) {
  const bad = clone(custom);
  bad[group][key] = invalid;
  rejects({ schemaVersion: 1, theme: bad }, parseThemeFile, 'invalid token rejected: ' + group + '.' + key);
}
const command = clone(custom);
command.onApply = 'run something';
rejects({ schemaVersion: 1, theme: command }, parseThemeFile, 'executable/unknown fields rejected');
rejects(encodeOverride({ missing: { colors: { accent: '#ffffff' } } }),
  text => applyThemeOverrides(BUILTIN_THEME_CATALOG, text), 'override cannot invent a target');
rejects(encodeOverride({ xp: { id: 'replacement' } }),
  text => applyThemeOverrides(BUILTIN_THEME_CATALOG, text), 'override cannot change theme identity');
rejects('{"schemaVersion":1,"themes":{"xp":{"colors":{"__proto__":{"polluted":true}}}}}',
  text => applyThemeOverrides(BUILTIN_THEME_CATALOG, text), 'prototype keys rejected');
check(!Object.prototype.polluted, 'prototype remains unchanged');
const invalidLayers = clone(custom);
invalidLayers.desktop.layers = Array.from({ length: 129 }, () => clone(getDesktopTheme('xp').desktop.layers[0]));
rejects({ schemaVersion: 1, theme: invalidLayers }, parseThemeFile, 'wallpaper primitive count is bounded');
invalidLayers.desktop.layers = [clone(getDesktopTheme('xp').desktop.layers[0])];
invalidLayers.desktop.layers[0].onClick = 'execute';
rejects({ schemaVersion: 1, theme: invalidLayers }, parseThemeFile, 'wallpaper data cannot introduce event handlers');
const input = createTextInput({ value: 'themed input' });
document.body.appendChild(input.root);
input.root.focus();
input.selectAll();
const selection = JSON.stringify(input.getSelection()), caret = input.getCaret();
input.setAppearance({ color: '#ffffff', background: '#456789', selectionColor: '#789abc',
  borderColor: '#123456', borderRadius: 12, fontSize: 24 });
host.render();
check(input.value === 'themed input' && JSON.stringify(input.getSelection()) === selection &&
  input.getCaret() === caret && document.activeElement === input.root, 'input retheming preserves text, focus, caret and selection');
check(host.pixel(input.root.offsetLeft + input.root.offsetWidth - 10,
  input.root.offsetTop + input.root.offsetHeight / 2) === '#456789', 'input appearance changes actual pixels');
document.body.removeChild(input.root);
console.log('PASS: versioned theme data, immutable overrides and rejection boundaries');
