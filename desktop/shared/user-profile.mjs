import { encodeUtf8 } from './sysrt/sdk/js/encoding.mjs';

const PASSWD = '/etc/passwd', MAX_BYTES = 1048576, NAME_BYTES = 256, MAX_UID = 4294967295;
const validUid = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_UID;
const profile = (uid, username = '', displayName = '', error = '') =>
  Object.freeze({ version: 1, uid, username, displayName, error });
const unavailable = (uid, error) => profile(validUid(uid) ? uid : null, '', '', error);
const numericId = text => /^(?:0|[1-9][0-9]{0,9})$/.test(text) && validUid(Number(text));
function boundedName(value) {
  if (!value.length || !value.trim().length || /[\x00-\x1f\x7f-\x9f]/.test(value)) return false;
  try { encodeUtf8(value, NAME_BYTES); return true; }
  catch { return false; }
}

export function validateUserProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'displayName,error,uid,username,version' || value.version !== 1 ||
      value.uid !== null && !validUid(value.uid) ||
      typeof value.username !== 'string' || typeof value.displayName !== 'string' || typeof value.error !== 'string')
    throw new TypeError('Invalid local display profile snapshot.');
  if (value.error) {
    if (!boundedName(value.error) || value.username || value.displayName)
      throw new TypeError('Invalid unavailable local display profile snapshot.');
  } else if (!validUid(value.uid) || !boundedName(value.username) || !boundedName(value.displayName)) {
    throw new TypeError('Invalid available local display profile snapshot.');
  }
  return profile(value.uid, value.username, value.displayName, value.error);
}

// This snapshot is local display metadata, not an authentication or NSS result.
export function parseLocalUserProfile(text, uid) {
  if (!validUid(uid)) return unavailable(null, 'Current user ID is invalid.');
  try { encodeUtf8(text, MAX_BYTES); }
  catch { return unavailable(uid, 'Local passwd database is not bounded valid UTF-8 text.'); }
  if (/[\x00-\x09\x0b-\x1f\x7f-\x9f]/.test(text))
    return unavailable(uid, 'Local passwd database contains invalid control characters.');
  let selected = null;
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const fields = line.split(':');
    if (fields.length !== 7 || !numericId(fields[2]) || !numericId(fields[3]))
      return unavailable(uid, 'Local passwd database has a malformed record.');
    if (Number(fields[2]) !== uid) continue;
    if (selected) return unavailable(uid, 'Current user ID has multiple local passwd records.');
    // Password, home and shell fields never become part of the display snapshot.
    const username = fields[0], displayName = fields[4].split(',')[0] || username;
    if (!boundedName(username) || !boundedName(displayName))
      return unavailable(uid, 'Current local user has invalid or oversized display metadata.');
    selected = { username, displayName };
  }
  return selected ? profile(uid, selected.username, selected.displayName) :
    unavailable(uid, 'Current user ID has no local passwd record.');
}

function trusted(entry) {
  return entry?.type === 'file' && entry.uid === 0 &&
    typeof entry.permissions === 'string' && entry.permissions.length === 4 && /^[0-7]{4}$/.test(entry.permissions) &&
    !(Number.parseInt(entry.permissions, 8) & 0o022) &&
    Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && entry.bytes <= MAX_BYTES &&
    typeof entry.identity === 'string' && entry.identity.length > 0 && entry.identity.length <= 191 &&
    !/[\x00-\x1f\x7f-\x9f\uD800-\uDFFF]/u.test(entry.identity);
}
function sameObservation(a, b) {
  return trusted(b) && a.identity === b.identity && a.bytes === b.bytes &&
    a.uid === b.uid && a.permissions === b.permissions;
}

export function readUserProfile({ uid: readUid, euid: readEffectiveUid, fileSystem } = {}) {
  if (typeof readUid !== 'function' || typeof readEffectiveUid !== 'function' ||
      typeof fileSystem?.stat !== 'function' || typeof fileSystem?.readText !== 'function')
    throw new TypeError('User profile requires explicit user-ID and readonly filesystem providers.');
  let uid, effectiveUid;
  try { uid = readUid(); }
  catch { return unavailable(null, 'Current user ID could not be read.'); }
  if (!validUid(uid)) return unavailable(null, 'Current user ID is invalid.');
  try { effectiveUid = readEffectiveUid(); }
  catch { return unavailable(uid, 'Effective user ID could not be read.'); }
  if (!validUid(effectiveUid)) return unavailable(uid, 'Effective user ID is invalid.');
  if (uid !== effectiveUid) return unavailable(uid, 'User IDs differ; local display profile is unavailable.');
  if (uid === 0) return unavailable(uid, 'Local display profile is unavailable for this privileged session.');
  let observed, read, after;
  try {
    observed = fileSystem.stat(PASSWD, false);
    if (!trusted(observed)) return unavailable(uid, 'Local passwd database is not a trusted bounded regular file.');
    read = fileSystem.readText(PASSWD, observed.identity);
    if (!sameObservation(observed, read))
      return unavailable(uid, 'Local passwd database observation changed during reading.');
    after = fileSystem.stat(PASSWD, false);
  } catch {
    return unavailable(uid, 'Local passwd database could not be read safely.');
  }
  if (!sameObservation(observed, after))
    return unavailable(uid, 'Local passwd database observation changed during reading.');
  let currentUid, currentEffectiveUid;
  try { currentUid = readUid(); }
  catch { return unavailable(null, 'Current user ID could not be confirmed after reading.'); }
  if (!validUid(currentUid)) return unavailable(null, 'Current user ID is invalid after reading.');
  try { currentEffectiveUid = readEffectiveUid(); }
  catch { return unavailable(currentUid, 'Effective user ID could not be confirmed after reading.'); }
  if (currentUid !== uid || currentEffectiveUid !== effectiveUid)
    return unavailable(currentUid, 'User identity changed while reading the local display profile.');
  try {
    if (encodeUtf8(read.text, MAX_BYTES).length !== observed.bytes)
      return unavailable(uid, 'Local passwd database text does not match its complete observation.');
  } catch {
    return unavailable(uid, 'Local passwd database is not bounded valid UTF-8 text.');
  }
  return parseLocalUserProfile(read.text, uid);
}
