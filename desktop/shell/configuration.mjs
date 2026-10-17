import { encodeUtf8, decodeUtf8 } from './sysrt/sdk/js/encoding.mjs';
import { validateAudioPreferences, readAudioPreferences } from './desktop/shell/audio-preferences.mjs';
import { validateDisplayProfile, readDisplayProfile } from './desktop/shell/display-profiles.mjs';
import { validateWorkspacePreferences, readWorkspacePreferences } from './desktop/shell/workspaces.mjs';
import { validateShortcuts, migrateLegacyShortcuts } from './desktop/shell/shortcuts.mjs';
import { validateDesktopShortcuts } from './desktop/shell/desktop-shortcuts.mjs';
import { validateLauncherPins } from './desktop/shell/launcher-pins.mjs';

export const SHELL_CONFIGURATION_FILE = 'shell-preferences.json';
export function defaultShellConfiguration() {
  return { version: 4, theme: { id: null, filesEnabled: true },
    audio: null, display: null, workspace: null, shortcuts: null,
    desktop: { version: 1, shortcuts: [] }, launchers: { version: 1, applications: [] } };
}
function keys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === expected;
}
export function validateShellConfiguration(value, report) {
  const legacy = value?.version === 1 && keys(value, 'audio,display,shortcuts,theme,version,workspace');
  const previous = value?.version === 2 && keys(value, 'audio,desktop,display,shortcuts,theme,version,workspace');
  const withLaunchers = (value?.version === 3 || value?.version === 4) &&
    keys(value, 'audio,desktop,display,launchers,shortcuts,theme,version,workspace');
  if ((!legacy && !previous && !withLaunchers) ||
      !keys(value.theme, 'filesEnabled,id') || typeof value.theme.filesEnabled !== 'boolean' ||
      (value.theme.id !== null && (typeof value.theme.id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(value.theme.id))))
    throw new TypeError('Invalid or unsupported Shell configuration schema');
  return { version: 4, theme: { ...value.theme },
    audio: value.audio === null ? null : validateAudioPreferences(value.audio),
    display: value.display === null ? null : validateDisplayProfile(value.display),
    workspace: value.workspace === null ? null : validateWorkspacePreferences(value.workspace),
    shortcuts: value.shortcuts === null ? null : value.version === 4 ? validateShortcuts(value.shortcuts) :
      migrateLegacyShortcuts(value.shortcuts, report),
    desktop: legacy ? { version: 1, shortcuts: [] } : validateDesktopShortcuts(value.desktop),
    launchers: withLaunchers ? validateLauncherPins(value.launchers) : { version: 1, applications: [] } };
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function snapshot(value) {
  return freeze(JSON.parse(JSON.stringify(validateShellConfiguration(value))));
}
export function migrateShellConfiguration(bytes, report) {
  const result = defaultShellConfiguration();
  if (bytes === null) return result;
  if (!(bytes instanceof Uint8Array) || decodeUtf8(bytes.subarray(0, 6)) !== 'PUST1\n')
    throw new TypeError('Invalid legacy Shell storage header');
  let offset = 6;
  function field() {
    const begin = offset;
    while (offset < bytes.length && bytes[offset] >= 48 && bytes[offset] <= 57) offset++;
    if (begin === offset || bytes[offset++] !== 10) throw new TypeError('Invalid legacy storage byte length');
    const length = Number(decodeUtf8(bytes.subarray(begin, offset - 1)));
    if (!Number.isSafeInteger(length) || length < 0 || length >= bytes.length - offset ||
        bytes[offset + length] !== 10) throw new TypeError('Truncated legacy storage field');
    const text = decodeUtf8(bytes.subarray(offset, offset + length));
    offset += length + 1;
    return text;
  }
  const seen = new Set();
  while (offset < bytes.length) {
    const key = field(), value = field();
    if (seen.has(key)) throw new TypeError('Duplicate legacy Shell preference');
    seen.add(key);
    switch (key) {
      case 'desktop.theme': result.theme.id = value; break;
      case 'desktop.theme.files':
        if (value !== 'enabled' && value !== 'disabled') throw new TypeError('Invalid legacy theme-file preference');
        result.theme.filesEnabled = value === 'enabled'; break;
      case 'desktop.audio.v1': result.audio = readAudioPreferences(value); break;
      case 'desktop.displays.v1': result.display = readDisplayProfile(value); break;
      case 'desktop.workspaces.v1': result.workspace = readWorkspacePreferences(value); break;
      case 'desktop.shortcuts.v1': result.shortcuts = migrateLegacyShortcuts(JSON.parse(value), report); break;
    }
  }
  return validateShellConfiguration(result);
}

export function createShellConfiguration(files, readLegacy, report = console.error) {
  let current, closed = false;
  function publish(value, initial = false) {
    const next = snapshot(value), bytes = encodeUtf8(JSON.stringify(next) + '\n');
    try { files.write(bytes, initial); }
    catch (error) {
      if (error.committed) current = next;
      throw error;
    }
    current = next;
  }
  try {
    const bytes = files.read();
    const diagnostics = [];
    const diagnostic = message => diagnostics.push('[shell] Shortcut migration: ' + message);
    if (bytes === null) publish(migrateShellConfiguration(readLegacy(), diagnostic), true);
    else {
      const parsed = JSON.parse(decodeUtf8(bytes));
      const migrated = snapshot(validateShellConfiguration(parsed, diagnostic));
      if (parsed.version !== 4) publish(migrated);
      else current = migrated;
    }
    if (diagnostics.length) report(diagnostics.join('; '));
  } catch (error) {
    try { files.close(); }
    catch (cleanup) {
      throw Object.assign(new Error(error.message + '; configuration cleanup failed: ' + cleanup.message),
        { cause: error, cleanup, committed: error.committed });
    }
    throw error;
  }
  function live() { if (closed) throw new Error('Shell configuration is closed'); }
  return Object.freeze({
    get snapshot() { live(); return current; },
    update(patch) {
      live();
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('Typed configuration patch required');
      publish({ ...current, ...patch });
      return current;
    },
    close() { if (!closed) { closed = true; files.close(); } },
  });
}
