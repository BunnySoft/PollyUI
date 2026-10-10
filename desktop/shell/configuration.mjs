import { encodeUtf8, decodeUtf8 } from './sysrt/sdk/js/encoding.mjs';
import { validateAudioPreferences, readAudioPreferences } from './desktop/shell/audio-preferences.mjs';
import { validateDisplayProfile, readDisplayProfile } from './desktop/shell/display-profiles.mjs';
import { validateWorkspacePreferences, readWorkspacePreferences } from './desktop/shell/workspaces.mjs';
import { validateShortcuts } from './desktop/shell/shortcuts.mjs';

export const SHELL_CONFIGURATION_FILE = 'shell-preferences.json';
export function defaultShellConfiguration() {
  return { version: 1, theme: { id: null, filesEnabled: true },
    audio: null, display: null, workspace: null, shortcuts: null };
}
function keys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === expected;
}
export function validateShellConfiguration(value) {
  if (!keys(value, 'audio,display,shortcuts,theme,version,workspace') || value.version !== 1 ||
      !keys(value.theme, 'filesEnabled,id') || typeof value.theme.filesEnabled !== 'boolean' ||
      (value.theme.id !== null && (typeof value.theme.id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(value.theme.id))))
    throw new TypeError('Invalid or unsupported Shell configuration schema');
  return { version: 1, theme: { ...value.theme },
    audio: value.audio === null ? null : validateAudioPreferences(value.audio),
    display: value.display === null ? null : validateDisplayProfile(value.display),
    workspace: value.workspace === null ? null : validateWorkspacePreferences(value.workspace),
    shortcuts: value.shortcuts === null ? null : validateShortcuts(value.shortcuts) };
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
export function migrateShellConfiguration(bytes) {
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
      case 'desktop.shortcuts.v1': result.shortcuts = validateShortcuts(JSON.parse(value)); break;
    }
  }
  return validateShellConfiguration(result);
}

export function createShellConfiguration(files, readLegacy) {
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
    if (bytes === null) publish(migrateShellConfiguration(readLegacy()), true);
    else current = snapshot(JSON.parse(decodeUtf8(bytes)));
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
