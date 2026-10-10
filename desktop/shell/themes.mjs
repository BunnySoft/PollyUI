const nodeRuntime = typeof process !== 'undefined' && process.versions?.node;
const { parseThemeCatalog } = await import(nodeRuntime ? './theme-schema.mjs' : './desktop/shell/theme-schema.mjs');

async function readBuiltin(name) {
  if (nodeRuntime) {
    const { readFile } = await import('node:fs/promises');
    return readFile(new URL('../resources/themes/' + name, import.meta.url), 'utf8');
  }
  const response = await fetch('file://desktop/resources/themes/' + name);
  if (!response.ok) throw new Error('Cannot read desktop theme data: ' + name);
  return response.text();
}

export let THEME_LOAD_ERROR = '';
let builtin;
try {
  builtin = parseThemeCatalog(await readBuiltin('builtin.json'));
} catch (error) {
  THEME_LOAD_ERROR = 'Cannot load desktop themes; using the packaged recovery theme. ' + String(error);
  console.error('[themes] ' + THEME_LOAD_ERROR);
  builtin = parseThemeCatalog(await readBuiltin('fallback.json'));
}

export const DEFAULT_DESKTOP_THEME = builtin.default;
export const BUILTIN_THEME_CATALOG = builtin;
export let DESKTOP_THEMES = builtin.themes;
export let THEME_REVISION = 1;

export function installThemeCatalog(catalog) {
  const validated = parseThemeCatalog(JSON.stringify(catalog));
  if (validated.default !== DEFAULT_DESKTOP_THEME)
    throw new TypeError('A theme catalog cannot replace the recovery default');
  DESKTOP_THEMES = validated.themes;
  THEME_REVISION++;
}

export function getDesktopTheme(id) {
  const theme = DESKTOP_THEMES.find(candidate => candidate.id === id);
  if (!theme) throw new RangeError('Unknown desktop appearance: ' + String(id));
  return theme;
}
