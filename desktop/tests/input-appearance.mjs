import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
register('./root-loader.mjs', import.meta.url);
const { parseThemeCatalog, parseThemeFile, applyThemeOverrides } = await import('../shared/ui/theme-schema.mjs');
const { inputAppearance } = await import('../shared/ui/input-appearance.mjs');
const catalog = parseThemeCatalog(readFileSync(new URL('../resources/themes/builtin.json', import.meta.url), 'utf8'));
assert.deepEqual(catalog, parseThemeCatalog(readFileSync(new URL('../resources/themes/fallback.json', import.meta.url), 'utf8')));
for (const theme of catalog.themes) {
  const appearance = inputAppearance(theme, 14);
  assert.equal(appearance.focusColor, theme.colors.focus);
  assert.equal(appearance.fontSize, theme.layout.sectionFontSize);
  assert.equal(appearance.selectionTextColor, theme.colors.selectionText);
  assert.equal(appearance.borderRadius, theme.button.radius);
  assert.equal(Object.isFrozen(theme.colors), true);
  assert.throws(() => { theme.colors.selectionText = '#123456'; }, TypeError);
  const legacy = JSON.parse(JSON.stringify(theme));
  delete legacy.colors.selectionText;
  const parsed = parseThemeFile(JSON.stringify({ schemaVersion: 1, theme: legacy }));
  assert.equal(parsed.colors.selectionText, undefined);
  assert.equal(inputAppearance(parsed).selectionTextColor, parsed.colors.text);
  const overridden = applyThemeOverrides({ schemaVersion: 1, default: parsed.id, themes: [parsed] },
    JSON.stringify({ schemaVersion: 1, themes: { [parsed.id]: { colors: { selectionText: '#123abc' } } } }));
  assert.equal(overridden.themes[0].colors.selectionText, '#123abc');
  for (const value of [null, 17, '#fff', '#ffffff80', 'white', '#xyzxyz']) {
    const invalid = JSON.parse(JSON.stringify(theme)); invalid.colors.selectionText = value;
    assert.throws(() => parseThemeFile(JSON.stringify({ schemaVersion: 1, theme: invalid })), /selectionText.*RGB/);
  }
}
const neutral = { fontSize: 14, borderRadius: 6, color: '#333639', background: '#ffffff',
  borderColor: '#cbd5e1', focusColor: '#2563eb', selectionColor: '#2080f0' };
assert.deepEqual(inputAppearance(null, 14, neutral), neutral);
assert.notEqual(inputAppearance(null, 14, neutral), neutral);
assert.throws(() => inputAppearance(null), TypeError);
console.log('PASS: complete shared input appearance; optional selection-text compatibility, strict RGB, immutable catalog, overrides and unchanged neutral defaults');
