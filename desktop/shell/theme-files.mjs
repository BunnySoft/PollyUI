import { BUILTIN_THEME_CATALOG } from './desktop/shell/themes.mjs';
import { parseThemeFile, parseThemeCatalog, applyThemeOverrides } from './desktop/shell/theme-schema.mjs';

export function readUserThemeCatalog(native) {
  const result = native.readThemeFiles();
  if (!result || !Array.isArray(result.files) || result.files.length > 64)
    throw new TypeError('Invalid native theme-file snapshot');
  const themes = [...BUILTIN_THEME_CATALOG.themes];
  const ids = new Set(themes.map(theme => theme.id));
  for (const file of [...result.files].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    const theme = parseThemeFile(file.text);
    if (theme.id !== file.id) throw new TypeError('Theme identity does not match its directory');
    if (ids.has(theme.id)) throw new TypeError('Duplicate theme identity; use theme-overrides.json for builtin overrides');
    ids.add(theme.id);
    themes.push(theme);
  }
  const catalog = parseThemeCatalog(JSON.stringify({ schemaVersion: 1, default: BUILTIN_THEME_CATALOG.default, themes }));
  return result.overrides === null ? catalog : applyThemeOverrides(catalog, result.overrides);
}
