import { readPrivateConfigurationFile } from './desktop/shared/configuration-files.mjs';
import { readThemeEnvironment, readThemeFiles } from './desktop/shared/theme-resources.mjs';
import { decodeUtf8 } from './sysrt/sdk/js/encoding.mjs';
import { SHELL_CONFIGURATION_FILE, validateShellConfiguration, migrateShellConfiguration } from './desktop/shell/configuration.mjs';
import { readUserThemeCatalog } from './desktop/shell/theme-files.mjs';
import { BUILTIN_THEME_CATALOG, DEFAULT_DESKTOP_THEME, getDesktopTheme, installThemeCatalog } from './desktop/shared/ui/themes.mjs';

function directory(variable, fallback) {
  const base = readThemeEnvironment(variable) || readThemeEnvironment('HOME') + '/' + fallback;
  if (!base.startsWith('/')) throw new TypeError(variable + ' requires an absolute path');
  return base.replace(/\/+$/, '') + '/pollyui/org.pollyui.shell';
}
function optionalRead(path, name) {
  try { return readPrivateConfigurationFile(path, name); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export function readBootstrapTheme(native, report = console.error) {
  installThemeCatalog(BUILTIN_THEME_CATALOG);
  let configuration;
  try {
    const bytes = optionalRead(directory('XDG_CONFIG_HOME', '.config'), SHELL_CONFIGURATION_FILE);
    configuration = bytes === null ?
      migrateShellConfiguration(optionalRead(directory('XDG_DATA_HOME', '.local/share'), 'localstorage.dat')) :
      validateShellConfiguration(JSON.parse(decodeUtf8(bytes)));
  } catch (error) {
    report('[decorator] Cannot read saved Shell appearance; using packaged default: ' + String(error));
    return getDesktopTheme(DEFAULT_DESKTOP_THEME);
  }
  if (configuration.theme.filesEnabled) {
    try {
      installThemeCatalog(readUserThemeCatalog({
        readThemeFiles: () => readThemeFiles(() => {
          if (!native.decorationStatus().bootstrap)
            throw new Error('WM bootstrap authority changed while reading theme files');
        }),
      }));
    } catch (error) {
      report('[decorator] Cannot read user themes; using packaged catalog: ' + String(error));
      installThemeCatalog(BUILTIN_THEME_CATALOG);
    }
  }
  try { return getDesktopTheme(configuration.theme.id ?? DEFAULT_DESKTOP_THEME); }
  catch (error) {
    report('[decorator] Saved theme is unavailable; using packaged default: ' + String(error));
    return getDesktopTheme(DEFAULT_DESKTOP_THEME);
  }
}
