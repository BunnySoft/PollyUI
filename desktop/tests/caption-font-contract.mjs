import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import test from 'node:test';
register('./root-loader.mjs', import.meta.url);
const { parseThemeCatalog, parseThemeFile, applyThemeOverrides } = await import('../shared/ui/theme-schema.mjs');
const { fitCaptionText } = await import('../shared/ui/caption-paint.mjs');
const catalog = parseThemeCatalog(readFileSync(new URL('../resources/themes/builtin.json', import.meta.url), 'utf8'));
const original = JSON.stringify(catalog);
const withFamily = family => ({ ...catalog.themes[0], window: { ...catalog.themes[0].window, fontFamily: family } });

test('named window font families share file/catalog/override validation without changing defaults', () => {
  for (const family of ['sans-serif', 'serif', 'monospace', 'DejaVu Sans', 'Noto Sans CJK SC',
    'Source Sans 3', '思源黑体', '游ゴシック', 'Cafe\u0301 Sans', 'Font.Name_2 (UI)', "O'Connor Sans"]) {
    const theme = withFamily(family);
    assert.equal(parseThemeFile(JSON.stringify({ schemaVersion: 1, theme })).window.fontFamily, family);
    assert.equal(parseThemeCatalog(JSON.stringify({ schemaVersion: 1, default: theme.id, themes: [theme] }))
      .themes[0].window.fontFamily, family);
    assert.equal(applyThemeOverrides(catalog, JSON.stringify({ schemaVersion: 1,
      themes: { [theme.id]: { window: { fontFamily: family } } } })).themes[0].window.fontFamily, family);
  }
  assert.equal(JSON.stringify(catalog), original);
  assert.ok(catalog.themes.every(theme => ['sans-serif', 'serif', 'monospace'].includes(theme.window.fontFamily)));
});

test('font family names are bounded literal names, not paths, lists, declarations or resources', () => {
  for (const family of ['', null, 42, [], ' '.repeat(4), ' leading', 'trailing ', 'a'.repeat(129),
    '/usr/share/font.ttf', '..\\font.ttf', 'file:font.ttf', 'https://fonts.invalid/a', 'url(font)',
    'Sans; color:red', 'Sans, serif', '"DejaVu Sans"', "'DejaVu Sans'", "Sans'",
    'Sans\0evil', 'Sans\nother', 'Sans\tother', 'Sans\u007f', 'Sans\u0085', 'Sans\u2028other',
    'Sans\u202eother', 'Sans\u200bother', 'Sans\ud800', 'Sans{bad}', 'Sans[bad]']) {
    const theme = withFamily(family);
    assert.throws(() => parseThemeFile(JSON.stringify({ schemaVersion: 1, theme })), TypeError, String(family));
    assert.throws(() => parseThemeCatalog(JSON.stringify({ schemaVersion: 1, default: theme.id, themes: [theme] })),
      TypeError, String(family));
    assert.throws(() => applyThemeOverrides(catalog, JSON.stringify({ schemaVersion: 1,
      themes: { [theme.id]: { window: { fontFamily: family } } } })), TypeError, String(family));
  }
});

test('ASCII sanitization, cap and fitting retain their existing output', () => {
  const ctx = { measureText: value => ({ width: value.length }) };
  assert.equal(fitCaptionText(ctx, 'Title', 20), 'Title');
  assert.equal(fitCaptionText(ctx, 'Long title', 5), 'Long…');
  assert.equal(fitCaptionText(ctx, '\0A\tB\nC\u007f', 100), ' A B C ');
  assert.equal(fitCaptionText(ctx, '', 0.5), '');
  assert.equal(fitCaptionText(ctx, 'abc', 0), '');
  assert.equal(fitCaptionText(ctx, 'abc', 0.5), '');
  assert.equal(fitCaptionText(ctx, 'abc', 1), '…');
  assert.equal(fitCaptionText(ctx, 'x'.repeat(600), 1000), 'x'.repeat(512));
});

test('without a native grapheme API the existing SDK fallback remains code-point safe only', () => {
  assert.equal(typeof globalThis.textBoundaries, 'undefined');
  const ctx = { measureText: value => ({ width: Array.from(value).length }) };
  assert.equal(fitCaptionText(ctx, '😀😀', 2), '😀😀');
  assert.equal(fitCaptionText(ctx, '😀😀😀', 2), '😀…');
  assert.equal(fitCaptionText(ctx, 'x'.repeat(511) + '😀😀', 1000), 'x'.repeat(511) + '😀');
});
