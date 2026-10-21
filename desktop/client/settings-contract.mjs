import { parseThemeCatalog, freezeTheme } from './desktop/shared/ui/theme-schema.mjs';
import { transparencyMode, windowOpacityPercent } from './desktop/shared/ui/transparency.mjs';
import { windowSwitcherStyle, windowSwitcherMotion } from './desktop/shared/ui/window-switcher.mjs';
import { wallpaperPreferences } from './desktop/shared/ui/procedural-wallpaper.mjs';
import { companionPreferences } from './desktop/shared/ui/companion.mjs';
import { workspaceCubePreferences } from './desktop/shared/ui/workspace-cube.mjs';

export const SETTINGS_APP_ID = 'org.pollyui.settings';
export const SETTINGS_BUS_NAME = 'org.pollyui.Shell.Settings';
export const SETTINGS_INSTANCE_NAME = 'org.pollyui.Settings.Instance';
export const SETTINGS_PATH = '/org/pollyui/Settings';
export const SETTINGS_INTERFACE = 'org.pollyui.Settings1';
export const SETTINGS_PAGES = Object.freeze(['appearance', 'displays', 'network', 'audio', 'keyboard', 'about']);
export const MANAGED_PAGES = Object.freeze(['displays', 'network', 'audio', 'keyboard']);
export const SETTINGS_VERSION = '0.1 (development)';
export function runtimeBuild(identity = typeof application === 'undefined' ? {} : application) {
  return Object.freeze({
    version: typeof identity.runtimeVersion === 'string' && identity.runtimeVersion ? identity.runtimeVersion : 'unknown',
    revision: /^[0-9a-f]{40}$/i.test(identity.runtimeRevision || '') ? identity.runtimeRevision : 'unknown',
    sourceDirty: typeof identity.runtimeSourceDirty === 'boolean' ? identity.runtimeSourceDirty : null,
  });
}
export function buildLabel(build) {
  return 'PollyDesktop ' + build.version + ' | ' +
    (build.revision === 'unknown' ? 'revision unknown' : build.revision.slice(0, 8)) +
    (build.sourceDirty === true ? ' (modified)' : build.sourceDirty === null ? ' (source state unknown)' : '');
}
export const SETTINGS_METHODS = Object.freeze({
  Open: { signature: 's', replySignature: 'u' },
  Connect: { signature: '', replySignature: 'uus' },
  Ready: { signature: '', replySignature: '' },
  GetAppearance: { signature: '', replySignature: 's' },
  GetMaterialSource: { signature: '', replySignature: 's' },
  GetAbout: { signature: '', replySignature: 's' },
  GetNetwork: { signature: '', replySignature: 's' },
  NetworkAction: { signature: 's', replySignature: 's' },
  RefreshNetwork: { signature: '', replySignature: 's' },
  ReplyNetworkAuthentication: { signature: 's', replySignature: 's' },
  CancelNetworkConnection: { signature: '', replySignature: 's' },
  DetachNetwork: { signature: '', replySignature: '' },
  GetDisplays: { signature: '', replySignature: 's' },
  ApplyDisplays: { signature: 's', replySignature: 's' },
  ForgetDisplayProfile: { signature: 'u', replySignature: 's' },
  GetAudio: { signature: '', replySignature: 's' },
  RefreshAudio: { signature: '', replySignature: 's' },
  AudioAction: { signature: 's', replySignature: 's' },
  ForgetAudio: { signature: 's', replySignature: 's' },
  GetKeyboard: { signature: '', replySignature: 's' },
  KeyboardAction: { signature: 's', replySignature: 's' },
  CancelShortcutRecording: { signature: 'u', replySignature: 's' },
  DetachPage: { signature: 's', replySignature: '' },
  SelectTheme: { signature: 's', replySignature: 's' },
  SetTransparency: { signature: 's', replySignature: 's' },
  SetWindowOpacity: { signature: 'u', replySignature: 's' },
  SetSwitcherStyle: { signature: 's', replySignature: 's' },
  SetSwitcherMotion: { signature: 'b', replySignature: 's' },
  SetWallpaper: { signature: 's', replySignature: 's' },
  SetCompanion: { signature: 's', replySignature: 's' },
  SetWorkspaceCube: { signature: 's', replySignature: 's' },
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
function validateBuild(build) {
  fields(build, ['version', 'revision', 'sourceDirty'], 'runtime build');
  boundedText(build.version, 80, 'runtime version', false);
  if (build.revision !== 'unknown' && !/^[0-9a-f]{40}$/i.test(build.revision))
    throw new TypeError('Invalid runtime revision');
  if (build.sourceDirty !== null && typeof build.sourceDirty !== 'boolean')
    throw new TypeError('Invalid runtime source state');
}
export function parseAppearance(text) {
  const value = payload(text);
  fields(value, ['version', 'revision', 'catalogRevision', 'themeId', 'catalog',
    'themeFilesEnabled', 'themeFilesAvailable', 'status', 'error', 'build',
    ...(Object.hasOwn(value, 'transparency') ? ['transparency'] : []),
    ...(Object.hasOwn(value, 'windowOpacity') ? ['windowOpacity'] : []),
    ...(Object.hasOwn(value, 'switcher') ? ['switcher'] : []),
    ...(Object.hasOwn(value, 'wallpaper') ? ['wallpaper'] : []),
    ...(Object.hasOwn(value, 'companion') ? ['companion'] : []),
    ...(Object.hasOwn(value, 'workspaceCube') ? ['workspaceCube'] : [])], 'appearance snapshot');
  if (value.version !== 1) throw new TypeError('Unsupported Settings snapshot version');
  integer(value.revision, 'appearance revision'); integer(value.catalogRevision, 'catalog revision');
  validateBuild(value.build);
  settingsThemeId(value.themeId);
  boundedText(value.status, 4096, 'appearance status'); boundedText(value.error, 16384, 'appearance error');
  if (typeof value.themeFilesEnabled !== 'boolean' || typeof value.themeFilesAvailable !== 'boolean')
    throw new TypeError('Invalid theme-file capability');
  if (Object.hasOwn(value, 'transparency')) {
    fields(value.transparency, ['mode', 'available', 'target', 'reason'], 'transparency snapshot');
    transparencyMode(value.transparency.mode);
    if (typeof value.transparency.available !== 'boolean') throw new TypeError('Invalid transparency capability');
    boundedText(value.transparency.target, 80, 'transparency target');
    boundedText(value.transparency.reason, 1024, 'transparency reason');
  }
  if (Object.hasOwn(value, 'windowOpacity')) {
    fields(value.windowOpacity, ['available', 'percent', 'requestedPercent', 'reason', 'error'], 'window opacity snapshot');
    if (typeof value.windowOpacity.available !== 'boolean')
      throw new TypeError('Invalid global window opacity capability');
    windowOpacityPercent(value.windowOpacity.requestedPercent);
    if (value.windowOpacity.available || value.windowOpacity.percent !== null)
      windowOpacityPercent(value.windowOpacity.percent);
    boundedText(value.windowOpacity.reason, 1024, 'window opacity reason');
    boundedText(value.windowOpacity.error, 4096, 'window opacity error');
  }
  if (Object.hasOwn(value, 'switcher')) {
    const projection = Object.hasOwn(value.switcher, 'projectionAvailable') || Object.hasOwn(value.switcher, 'projectionReason');
    fields(value.switcher, ['style', 'available', 'reason',
      ...(projection ? ['projectionAvailable', 'projectionReason'] : []),
      ...(Object.hasOwn(value.switcher, 'motion') ? ['motion'] : [])], 'window switcher snapshot');
    windowSwitcherStyle(value.switcher.style);
    if (typeof value.switcher.available !== 'boolean') throw new TypeError('Invalid window preview capability');
    boundedText(value.switcher.reason, 1024, 'window preview reason');
    if (projection) {
      if (typeof value.switcher.projectionAvailable !== 'boolean')
        throw new TypeError('Invalid 3D window projection capability');
      boundedText(value.switcher.projectionReason, 1024, '3D window projection reason');
    }
    if (Object.hasOwn(value.switcher, 'motion')) windowSwitcherMotion(value.switcher.motion);
  }
  if (Object.hasOwn(value, 'wallpaper')) {
    const video = Object.hasOwn(value.wallpaper, 'videoAvailable') || Object.hasOwn(value.wallpaper, 'videoReason') ||
      Object.hasOwn(value.wallpaper, 'playback');
    fields(value.wallpaper, ['mode', 'reducedMotion', 'available', 'reason', 'error',
      ...(Object.hasOwn(value.wallpaper, 'video') ? ['video'] : []),
      ...(video ? ['videoAvailable', 'videoReason', 'playback'] : [])], 'wallpaper snapshot');
    wallpaperPreferences({ mode: value.wallpaper.mode, reducedMotion: value.wallpaper.reducedMotion,
      ...(Object.hasOwn(value.wallpaper, 'video') ? { video: value.wallpaper.video } : {}) });
    if (typeof value.wallpaper.available !== 'boolean') throw new TypeError('Invalid procedural wallpaper capability');
    boundedText(value.wallpaper.reason, 1024, 'wallpaper reason');
    boundedText(value.wallpaper.error, 4096, 'wallpaper error');
    if (video) {
      if (typeof value.wallpaper.videoAvailable !== 'boolean') throw new TypeError('Invalid native video decoder capability');
      boundedText(value.wallpaper.videoReason, 1024, 'video wallpaper reason');
      const playback = value.wallpaper.playback;
      fields(playback, ['ready', 'paused', 'ended', 'width', 'height', 'frames', 'loop', 'muted'], 'video playback');
      for (const key of ['ready', 'paused', 'ended'])
        if (typeof playback[key] !== 'boolean') throw new TypeError('Invalid video playback state');
      for (const key of ['width', 'height', 'frames', 'loop']) integer(playback[key], 'video ' + key);
      if (playback.width > 1280 || playback.height > 720 ||
          (playback.ready && (!playback.width || !playback.height)) || playback.muted !== true)
        throw new TypeError('Video playback violates its pixel or muted-audio contract');
    }
  }
  if (Object.hasOwn(value, 'companion')) {
    fields(value.companion, ['enabled', 'reducedMotion', 'available', 'reason', 'error'], 'companion snapshot');
    companionPreferences({ enabled: value.companion.enabled, reducedMotion: value.companion.reducedMotion });
    if (typeof value.companion.available !== 'boolean') throw new TypeError('Invalid desktop companion capability');
    boundedText(value.companion.reason, 1024, 'companion reason');
    boundedText(value.companion.error, 4096, 'companion error');
  }
  if (Object.hasOwn(value, 'workspaceCube')) {
    fields(value.workspaceCube, ['enabled', 'motion', 'available', 'reason', 'error'], 'workspace cube snapshot');
    workspaceCubePreferences({ enabled: value.workspaceCube.enabled, motion: value.workspaceCube.motion });
    if (typeof value.workspaceCube.available !== 'boolean') throw new TypeError('Invalid workspace cube capability');
    boundedText(value.workspaceCube.reason, 1024, 'workspace cube reason');
    boundedText(value.workspaceCube.error, 4096, 'workspace cube error');
  }
  const catalog = parseThemeCatalog(JSON.stringify(value.catalog));
  if (!catalog.themes.some(theme => theme.id === value.themeId)) throw new TypeError('Active theme is absent');
  return freezeTheme({ ...value, catalog });
}
export const MATERIAL_SOURCE_LIMIT = 128 * 1024;
const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function parseMaterialSource(text) {
  boundedText(text, MATERIAL_SOURCE_LIMIT + 1024, 'material source', false);
  const value = JSON.parse(text);
  fields(value, ['version', 'revision', 'generation', 'themeId', 'width', 'height', 'dataURL'], 'material source');
  if (value.version !== 1) throw new TypeError('Unsupported material source version');
  integer(value.revision, 'material revision'); integer(value.generation, 'material owner generation');
  if (!value.generation) throw new TypeError('Invalid material owner generation');
  settingsThemeId(value.themeId);
  for (const key of ['width', 'height'])
    if (!Number.isInteger(value[key]) || value[key] < 1 || value[key] > 128)
      throw new TypeError('Invalid material source dimensions');
  const prefix = 'data:image/png;base64,', data = value.dataURL;
  if (typeof data !== 'string' || data.length > MATERIAL_SOURCE_LIMIT || !data.startsWith(prefix))
    throw new TypeError('Material source must be a bounded PNG data URL');
  const encoded = data.slice(prefix.length);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded) ||
      encoded.length < 44 || (encoded.endsWith('==') && (base64Alphabet.indexOf(encoded.at(-3)) & 15)) ||
      (encoded.endsWith('=') && !encoded.endsWith('==') && (base64Alphabet.indexOf(encoded.at(-2)) & 3)))
    throw new TypeError('Invalid material PNG base64');
  const header = [];
  for (let i = 0; i < 44; i += 4) {
    const word = [...encoded.slice(i, i + 4)].reduce((n, c) => (n << 6) | Math.max(0, base64Alphabet.indexOf(c)), 0);
    header.push(word >>> 16 & 255, word >>> 8 & 255, word & 255);
  }
  const u32 = offset => header.slice(offset, offset + 4).reduce((n, byte) => n * 256 + byte, 0);
  if (header.slice(0, 8).join() !== '137,80,78,71,13,10,26,10' || u32(8) !== 13 ||
      header.slice(12, 16).join() !== '73,72,68,82' || u32(16) !== value.width || u32(20) !== value.height)
    throw new TypeError('Material PNG header does not match its dimensions');
  return freezeTheme(value);
}
export function matchMaterialSource(value, appearance, generation) {
  if (value.generation !== generation || value.themeId !== appearance.themeId || value.revision !== appearance.revision)
    throw new Error('Material source does not match the current appearance or owned Settings generation');
  return value;
}
export function parseAbout(text) {
  const value = payload(text);
  fields(value, ['version', 'services', 'outputs', 'themeId', 'applicationId', 'profiles', 'build'], 'about snapshot');
  if (value.version !== 1) throw new TypeError('Unsupported Settings snapshot version');
  validateBuild(value.build);
  fields(value.services, ['inputMethod', 'audio', 'decorations', 'message', 'error'], 'service snapshot');
  for (const key of ['inputMethod', 'audio', 'decorations'])
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
