export const DISPLAY_PROFILE_KEY = 'desktop.displays.v1';
const identityFields = ['name', 'make', 'model', 'serialNumber'];
const geometryFields = ['enabled', 'width', 'height', 'refresh', 'scale', 'transform', 'x', 'y', 'adaptiveSync'];
const fields = [...identityFields, ...geometryFields];
const byteLength = text => encodeURIComponent(text).replace(/%[0-9A-F]{2}/g, 'x').length;
const select = (source, names) => Object.fromEntries(names.map(name => [name, source[name]]));
function keys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}
function validate(profile) {
  if (!keys(profile, ['version', 'heads']) || profile.version !== 1 ||
      !Array.isArray(profile.heads) || !profile.heads.length)
    throw new TypeError('Invalid display profile');
  const names = new Set();
  for (const head of profile.heads) {
    if (!keys(head, fields) || identityFields.some(field => typeof head[field] !== 'string' ||
        head[field].includes('\0') || head[field].length > 256 || byteLength(head[field]) > 256) ||
        names.has(head.name) || typeof head.enabled !== 'boolean' || typeof head.adaptiveSync !== 'boolean')
      throw new TypeError('Invalid or duplicate display profile identity');
    names.add(head.name);
    for (const [field, min, max, integer] of [
      ['width', 0, 16384, true], ['height', 0, 16384, true], ['refresh', 0, 1000000, true],
      ['scale', 0.25, 4, false], ['transform', 0, 7, true], ['x', -32768, 32768, true], ['y', -32768, 32768, true],
    ]) {
      if (typeof head[field] !== 'number' || !Number.isFinite(head[field]) || head[field] < min || head[field] > max ||
          (integer && !Number.isInteger(head[field]))) throw new RangeError('Invalid saved display field: ' + field);
    }
    if (head.enabled && (!head.width || !head.height || head.width * head.height > 32 * 1024 * 1024 ||
        head.width / head.scale > 32700 || head.height / head.scale > 32700))
      throw new RangeError('Saved display dimensions exceed rendering bounds');
  }
  if (!profile.heads.some(head => head.enabled)) throw new Error('A saved layout must leave a display enabled');
  return { version: 1, heads: profile.heads.map(head => select(head, fields)).sort((a, b) => a.name.localeCompare(b.name)) };
}
export function readDisplayProfile(text) {
  if (typeof text !== 'string' || text.length > 65536 || byteLength(text) > 65536)
    throw new RangeError('Display profiles must fit in 64 KiB');
  return validate(JSON.parse(text));
}
export function displayProfile(snapshot) {
  if (snapshot.pendingToken) throw new Error('Unconfirmed display settings cannot be saved');
  const heads = snapshot.heads.map(head => ({ ...select(head, geometryFields),
    ...Object.fromEntries(identityFields.map(field => [field, head[field] ?? ''])) }));
  return readDisplayProfile(JSON.stringify({ version: 1, heads }));
}
function hardware(head) { return JSON.stringify(identityFields.slice(1).map(field => head[field])); }
function unambiguous(profile) {
  return profile.heads.every(head => identityFields.every(field =>
    head[field].trim() && !/^(unknown|none|0+|0x0+)$/i.test(head[field].trim()))) &&
    new Set(profile.heads.map(hardware)).size === profile.heads.length;
}
export function displayRestorePlan(profile, snapshot) {
  profile = validate(profile);
  const current = displayProfile(snapshot);
  if (!unambiguous(profile) || !unambiguous(current))
    return { message: 'Saved layout not applied: display identity is missing or ambiguous.' };
  if (profile.heads.length !== current.heads.length || profile.heads.some((head, index) =>
      identityFields.some(field => head[field] !== current.heads[index][field])))
    return { message: 'Saved layout not applied: the connected display combination has changed.' };
  if (profile.heads.every((head, index) => head.enabled === current.heads[index].enabled &&
      (!head.enabled || geometryFields.every(field => head[field] === current.heads[index][field]))))
    return { message: 'Saved display layout already matches; no confirmation needed.' };
  return { message: 'Saved layout restored provisionally; confirm within 15 seconds.',
    draft: { serial: snapshot.serial, heads: snapshot.heads.map(head => ({
      ...head, ...profile.heads.find(saved => saved.name === head.name),
    })) } };
}
export function createDisplayPersistence({ native, storage, failure }) {
  let status = 'Only confirmed display changes are saved for the next session.';
  let restoredToken = 0;
  return {
    start() {
      if (typeof native?.claimOutputStartup !== 'function') return;
      try {
        if (!native.claimOutputStartup()) return;
        const stored = storage.getItem(DISPLAY_PROFILE_KEY);
        if (stored === null) return;
        const plan = displayRestorePlan(readDisplayProfile(stored), native.outputConfiguration());
        if (plan.draft) restoredToken = native.applyOutputConfiguration(plan.draft);
        status = plan.message;
      } catch (error) {
        status = 'Automatic display restore did not complete. Check display settings.';
        failure(error);
      }
    },
    observe(snapshot) {
      if (!restoredToken || snapshot.pendingToken) return;
      restoredToken = 0;
      status = snapshot.outcome === 2 ? 'Automatic display restore was reverted; the saved profile was not changed.' :
        snapshot.outcome === 1 ? 'Restored display layout confirmed.' : 'Automatic display restore ended; check the current layout.';
    },
    save(snapshot) {
      const profile = displayProfile(snapshot);
      storage.setItem(DISPLAY_PROFILE_KEY, JSON.stringify(profile));
      restoredToken = 0;
      status = unambiguous(profile) ? 'Confirmed layout saved for this exact display combination.' :
        'Layout saved, but missing or ambiguous display identity prevents automatic restoration.';
    },
    forget() {
      storage.removeItem(DISPLAY_PROFILE_KEY);
      status = 'Saved display layout removed. Current displays are unchanged.';
    },
    get status() { return status; },
  };
}
