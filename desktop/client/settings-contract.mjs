import { parseThemeCatalog, freezeTheme } from './desktop/shell/theme-schema.mjs';

export const SETTINGS_APP_ID = 'org.pollyui.settings';
export const SETTINGS_BUS_NAME = 'org.pollyui.Shell.Settings';
export const SETTINGS_INSTANCE_NAME = 'org.pollyui.Settings.Instance';
export const SETTINGS_PATH = '/org/pollyui/Settings';
export const SETTINGS_INTERFACE = 'org.pollyui.Settings1';
export const SETTINGS_PAGES = Object.freeze(['appearance', 'displays', 'network', 'audio', 'keyboard', 'about']);
export const MANAGED_PAGES = Object.freeze(['displays', 'network', 'audio', 'keyboard']);
export const SETTINGS_VERSION = '0.1 (development)';
export const SETTINGS_METHODS = Object.freeze({
  Open: { signature: 's', replySignature: 'u' },
  Connect: { signature: '', replySignature: 'uus' },
  GetAppearance: { signature: '', replySignature: 's' },
  GetAbout: { signature: '', replySignature: 's' },
  SelectTheme: { signature: 's', replySignature: 's' },
  ReloadThemes: { signature: '', replySignature: 's' },
  RestoreThemes: { signature: '', replySignature: 's' },
  OpenManagedPage: { signature: 's', replySignature: '' },
});
export const settingsTarget = (member, destination = SETTINGS_BUS_NAME) =>
  ({ destination, path: SETTINGS_PATH, interface: SETTINGS_INTERFACE, member });
export const daemonTarget = member => ({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus',
  interface: 'org.freedesktop.DBus', member });

export function settingsPage(page, managed = false) {
  if (!(managed ? MANAGED_PAGES : SETTINGS_PAGES).includes(page))
    throw new TypeError('Unknown ' + (managed ? 'desktop control' : 'Settings') + ' page');
  return page;
}
export function settingsThemeId(id) {
  if (typeof id !== 'string' || id.length > 64 || !/^[a-z][a-z0-9_-]*$/.test(id))
    throw new TypeError('Settings theme ID must be a bounded catalog identifier');
  return id;
}
function fields(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)))
    throw new TypeError('Invalid ' + label + ' fields');
}
function boundedText(value, limit, label, empty = true) {
  if (typeof value !== 'string' || value.length > limit || (!empty && !value.length) ||
      /[\x00-\x08\x0b-\x1f\x7f]/.test(value))
    throw new TypeError('Invalid Settings ' + label);
}
function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid Settings ' + label);
}
function payload(text) {
  boundedText(text, 1024 * 1024, 'snapshot', false);
  return JSON.parse(text);
}
export function parseAppearance(text) {
  const value = payload(text);
  fields(value, ['version', 'revision', 'catalogRevision', 'themeId', 'catalog',
    'themeFilesEnabled', 'themeFilesAvailable', 'status', 'error'], 'appearance snapshot');
  if (value.version !== 1) throw new TypeError('Unsupported Settings snapshot version');
  integer(value.revision, 'appearance revision'); integer(value.catalogRevision, 'catalog revision');
  settingsThemeId(value.themeId);
  boundedText(value.status, 4096, 'appearance status'); boundedText(value.error, 16384, 'appearance error');
  if (typeof value.themeFilesEnabled !== 'boolean' || typeof value.themeFilesAvailable !== 'boolean')
    throw new TypeError('Invalid theme-file capability');
  const catalog = parseThemeCatalog(JSON.stringify(value.catalog));
  if (!catalog.themes.some(theme => theme.id === value.themeId)) throw new TypeError('Active theme is absent');
  return freezeTheme({ ...value, catalog });
}
export function parseAbout(text) {
  const value = payload(text);
  fields(value, ['version', 'services', 'outputs', 'themeId', 'applicationId', 'profiles'], 'about snapshot');
  if (value.version !== 1) throw new TypeError('Unsupported Settings snapshot version');
  fields(value.services, ['inputMethod', 'audio', 'message', 'error'], 'service snapshot');
  for (const key of ['inputMethod', 'audio'])
    if (!['unavailable', 'disabled', 'starting', 'ready', 'failed'].includes(value.services[key]))
      throw new TypeError('Invalid session service state');
  boundedText(value.services.message, 16384, 'service message');
  boundedText(value.services.error, 16384, 'service error');
  integer(value.outputs, 'output count');
  settingsThemeId(value.themeId);
  boundedText(value.applicationId, 256, 'Shell application ID', false);
  fields(value.profiles, ['display', 'audio', 'workspace'], 'profile snapshot');
  for (const key of Object.keys(value.profiles)) boundedText(value.profiles[key], 4096, key + ' profile');
  return freezeTheme(value);
}
