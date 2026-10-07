// UI data only: no device access, Python selection token, OS authorization or writer.
const LIMIT = 2 * 1024 * 1024;
const MAX_ENTRIES = 256;
const RO = { readOnly: true, writeAuthorized: false };
export const issue = (code, message) => ({ code, message });

function requireValue(condition, message) {
  if (!condition) throw new TypeError('Invalid read-only target report: ' + message);
}
function object(value, keys, label, optional = []) {
  requireValue(value !== null && !Array.isArray(value) && typeof value === 'object', label);
  requireValue(keys.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => keys.includes(key) || optional.includes(key)), label + ' fields');
}
function text(value, label, nullable = false) {
  if (nullable && value === null) return;
  requireValue(typeof value === 'string' && value.length > 0 && value.length <= 4096 &&
    !/[\u0000-\u001f\u007f]/.test(value), label);
}
function integer(value, label, nullable = false, minimum = 0) {
  if (nullable && value === null) return;
  requireValue(Number.isSafeInteger(value) && value >= minimum, label + ' exact integer');
}
function flag(value, label) { requireValue(typeof value === 'boolean', label); }
function array(value, label, check, max = MAX_ENTRIES) {
  requireValue(Array.isArray(value) && value.length <= max, label + ' bounded array');
  value.forEach(check);
}
function major(value, nullable = false) {
  if (nullable && value === null) return;
  text(value, 'major:minor');
  requireValue(/^(0|[1-9][0-9]{0,6}):(0|[1-9][0-9]{0,6})$/.test(value), 'major:minor');
}
function reasons(value) {
  array(value, 'reasons', reason => {
    object(reason, ['code', 'message'], 'reason', ['detail']);
    text(reason.code, 'reason code'); text(reason.message, 'reason message');
  }, 2048);
}
export function freezeData(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freezeData);
    Object.freeze(value);
  }
  return value;
}
function copyData(value) {
  let count = 0, size = 0;
  function visit(item, depth) {
    requireValue(++count <= 100000 && depth <= 24, 'JSON complexity');
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'string') { size += item.length; requireValue(size <= LIMIT, 'text size'); return; }
    if (typeof item === 'number') {
      requireValue(Number.isFinite(item) && Math.abs(item) <= Number.MAX_SAFE_INTEGER, 'exact JSON number');
      return;
    }
    requireValue(typeof item === 'object' &&
      (Array.isArray(item) || Object.getPrototypeOf(item) === Object.prototype), 'plain JSON data');
    requireValue(!Object.getOwnPropertySymbols(item).length, 'JSON symbols');
    const fields = Object.getOwnPropertyDescriptors(item);
    for (const [key, field] of Object.entries(fields)) {
      if (Array.isArray(item) && key === 'length') continue;
      requireValue(field.enumerable && 'value' in field &&
        !['__proto__', 'constructor', 'prototype'].includes(key), 'JSON field');
      size += key.length;
      visit(field.value, depth + 1);
    }
  }
  visit(value, 0);
  const json = JSON.stringify(value);
  // UTF-8 is at most three bytes per UTF-16 code unit; escaped JSON is bounded too.
  let bytes = 0;
  for (let i = 0; i < json.length; i++) {
    const code = json.charCodeAt(i);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
  }
  requireValue(bytes <= LIMIT, 'JSON byte size');
  return JSON.parse(json);
}
export function sameData(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' ||
    Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length &&
    keys.every(key => Object.hasOwn(right, key) && sameData(left[key], right[key]));
}
function partition(part) {
  object(part, ['path', 'majorMinor', 'capacityBytes', 'number', 'startSector512',
    'filesystem', 'uuid', 'partuuid', 'mountpoints'], 'partition');
  text(part.path, 'partition path', true); major(part.majorMinor, true);
  integer(part.capacityBytes, 'partition bytes', true, 1);
  integer(part.number, 'partition number', true, 1);
  integer(part.startSector512, 'partition start', true);
  for (const key of ['filesystem', 'uuid', 'partuuid']) text(part[key], key, true);
  array(part.mountpoints, 'partition mounts', value => text(value, 'mountpoint'));
}
function kernel(value) {
  if (value === null) return;
  object(value, ['sysfsPath', 'dev', 'sizeSectors512', 'logicalSectorBytes', 'readOnly',
    'removable', 'diskseq', 'partition', 'startSector512', 'parent', 'holders', 'slaves',
    'partitions'], 'kernel');
  text(value.sysfsPath, 'sysfs path'); major(value.dev);
  integer(value.sizeSectors512, 'kernel sectors', false, 1);
  integer(value.logicalSectorBytes, 'kernel logical sector', false, 512);
  integer(value.diskseq, 'diskseq', false, 1);
  integer(value.partition, 'kernel partition', true, 1);
  integer(value.startSector512, 'kernel start', true); major(value.parent, true);
  flag(value.readOnly, 'kernel readonly'); flag(value.removable, 'kernel removable');
  for (const key of ['holders', 'slaves', 'partitions']) array(value[key], key, item => major(item));
}
function device(entry) {
  object(entry, ['entryId', 'deviceType', 'model', 'capacityBytes', 'removable', 'identity',
    'partitions', 'clearingScope', 'observation', 'eligible', 'reasons', 'raw'], 'device');
  text(entry.entryId, 'entry ID'); text(entry.deviceType, 'device type', true);
  text(entry.model, 'model', true); integer(entry.capacityBytes, 'device bytes', true, 1);
  if (entry.removable !== null) flag(entry.removable, 'removable');
  flag(entry.eligible, 'eligible'); reasons(entry.reasons);
  object(entry.identity, ['serial', 'wwn', 'model', 'capacityBytes', 'logicalSectorBytes'], 'identity');
  for (const key of ['serial', 'wwn', 'model']) text(entry.identity[key], key, true);
  for (const key of ['serial', 'wwn']) {
    const id = entry.identity[key];
    if (id !== null) requireValue(id.trim() === id &&
      !/^(unknown|none|null|n\/a|na|not specified|[0 -]+)$/i.test(id) &&
      (key !== 'wwn' || /^[0-9a-f]{8,64}$/.test(id)), 'normalized stable ' + key);
  }
  integer(entry.identity.capacityBytes, 'identity bytes', true, 1);
  integer(entry.identity.logicalSectorBytes, 'logical sector', true, 512);
  array(entry.partitions, 'partitions', partition);
  object(entry.clearingScope, ['kind', 'startByte', 'endByteExclusive', 'partitionTable',
    'partitions', 'performed'], 'clearing scope');
  requireValue(entry.clearingScope.kind === 'hypothetical-whole-disk' &&
    entry.clearingScope.startByte === 0 && entry.clearingScope.performed === false, 'hypothetical scope');
  integer(entry.clearingScope.endByteExclusive, 'scope end', true, 1);
  text(entry.clearingScope.partitionTable, 'partition table', true);
  array(entry.clearingScope.partitions, 'scope partitions', partition);
  requireValue(sameData(entry.partitions, entry.clearingScope.partitions) &&
    entry.capacityBytes === entry.clearingScope.endByteExclusive &&
    entry.capacityBytes === entry.identity.capacityBytes && entry.model === entry.identity.model,
  'consistent identity/scope');
  object(entry.observation, ['path', 'majorMinor', 'kname', 'kernel', 'parents',
    'descendants', 'transport'], 'observation');
  for (const key of ['path', 'kname', 'transport']) text(entry.observation[key], key, true);
  major(entry.observation.majorMinor, true); kernel(entry.observation.kernel);
  for (const key of ['parents', 'descendants']) array(entry.observation[key], key, item => major(item));
  requireValue(entry.raw && typeof entry.raw === 'object' && !Array.isArray(entry.raw), 'raw evidence');
  if (entry.eligible) {
    requireValue(!entry.reasons.length && entry.deviceType === 'disk' && entry.model &&
      entry.capacityBytes && entry.identity.logicalSectorBytes && entry.observation.path &&
      entry.observation.majorMinor && entry.observation.kname && entry.observation.kernel &&
      entry.observation.kernel.diskseq, 'qualified eligible entry');
    requireValue(entry.identity.serial || entry.identity.wwn, 'stable ID');
  }
}

/** readReport() returns an object envelope, not JSON text or an executable path.
 * report is unchanged targets.inventory schema 1; source is separately supplied
 * by the future trusted server. This parser validates shape, not that server's
 * authority. Unknown source mapping stays visible and blocks UI confirmation.
 */
export function parseTargetEnvelope(input) {
  const envelope = copyData(input);
  object(envelope, ['schemaVersion', 'readOnly', 'writeAuthorized', 'generation', 'source', 'report'], 'envelope');
  requireValue(envelope.schemaVersion === 1 && envelope.readOnly === true &&
    envelope.writeAuthorized === false, 'read-only envelope');
  text(envelope.generation, 'report acquisition generation');
  const { report, source } = envelope;
  object(report, ['schemaVersion', 'readOnly', 'writeAuthorized', 'capacity', 'devices',
    'errors', 'limitations'], 'inventory');
  requireValue(report.schemaVersion === 1 && report.readOnly === true &&
    report.writeAuthorized === false, 'read-only inventory');
  object(report.capacity, ['layout', 'requiredBytes', 'partitions'], 'capacity');
  requireValue(report.capacity.layout === 'single-system-independent-recovery', 'capacity layout');
  integer(report.capacity.requiredBytes, 'required bytes', false, 1);
  array(report.capacity.partitions, 'capacity plan', part => {
    object(part, ['name', 'startSector', 'sectors', 'sizeMiB', 'payloadBytes',
      'filesystemOverheadMiB', 'reserveMiB', 'type', 'filesystem'], 'capacity partition');
    text(part.name, 'capacity role'); integer(part.payloadBytes, 'payload bytes', false, 1);
    integer(part.sizeMiB, 'planned MiB', false, 1);
    integer(part.startSector, 'planned start', false, 1);
    integer(part.sectors, 'planned sectors', false, 1);
    integer(part.filesystemOverheadMiB, 'filesystem overhead', false, 1);
    integer(part.reserveMiB, 'reserve', false, 1);
    text(part.type, 'partition type'); text(part.filesystem, 'filesystem');
  }, 4);
  requireValue(sameData(report.capacity.partitions.map(part => part.name),
    ['EFI', 'SYSTEM', 'PERSISTENT', 'RECOVERY']), 'four capacity roles');
  reasons(report.errors);
  array(report.limitations, 'limitations', value => text(value, 'limitation'));
  array(report.devices, 'devices', device);
  const ids = report.devices.map(entry => entry.entryId);
  requireValue(new Set(ids).size === ids.length, 'unique entry IDs');
  requireValue(!report.errors.length || report.devices.every(entry => !entry.eligible), 'errors cannot qualify targets');
  for (const entry of report.devices.filter(value => value.eligible)) {
    for (const key of ['serial', 'wwn']) {
      const id = entry.identity[key]?.toLowerCase();
      if (id) requireValue(report.devices.filter(other => other.deviceType === 'disk' &&
        other.identity[key]?.toLowerCase() === id).length === 1, 'duplicate stable ID');
    }
  }
  object(source, ['kind', 'description', 'downloadedBytes', 'memoryLogicalBytes',
    'exactSourceMapping', 'kernelBasis', 'reasons'], 'source');
  requireValue(['downloaded', 'memory', 'unknown'].includes(source.kind), 'source kind');
  text(source.description, 'source description');
  integer(source.downloadedBytes, 'downloaded bytes', true);
  integer(source.memoryLogicalBytes, 'memory logical bytes', true);
  flag(source.exactSourceMapping, 'source mapping'); reasons(source.reasons);
  array(source.kernelBasis, 'source kernel basis', item => major(item));
  if (source.exactSourceMapping) {
    requireValue(source.kind !== 'unknown' && source.kernelBasis.length && !source.reasons.length &&
      source.kernelBasis.every(dev => report.devices.some(entry =>
        entry.observation.majorMinor === dev && entry.reasons.some(reason => reason.code === 'active-source'))),
    'exact source mapping needs reported active-source kernel basis');
  }
  return freezeData(envelope);
}

export function selectable(envelope, entry) {
  return !!envelope && !!entry && entry.eligible && !entry.reasons.length &&
    !envelope.report.errors.length && envelope.source.exactSourceMapping &&
    envelope.source.kind !== 'unknown';
}
export function bindTarget(envelope, entryId, generation) {
  const entry = envelope.report.devices.find(value => value.entryId === entryId);
  if (!selectable(envelope, entry)) throw new Error('Explicit selection requires a qualified entry and exact source mapping');
  return freezeData({
    schemaVersion: 1, kind: 'ui-only-target-binding', ...RO, generation,
    reportGeneration: envelope.generation, entryId,
    identity: entry.identity, observation: entry.observation, clearingScope: entry.clearingScope,
    capacity: envelope.report.capacity, source: envelope.source,
  });
}
/** Structural UI re-identification mirrors the existing observation binding,
 * but intentionally emits no Python SHA fingerprint or private broker token.
 */
export function reidentifyTarget(binding, fresh) {
  const failures = [];
  if (fresh.generation === binding.reportGeneration)
    failures.push(issue('stale-report', 'The provider reused an acquisition generation; independently refresh and reselect.'));
  const candidates = fresh.report.devices.filter(entry => entry.deviceType === 'disk' &&
    ['serial', 'wwn'].some(key => binding.identity[key] &&
      binding.identity[key].toLowerCase() === entry.identity[key]?.toLowerCase()));
  if (candidates.length !== 1)
    failures.push(issue(candidates.length ? 'duplicate-stable-id' : 'identity-missing',
      'The selected stable identity is missing or ambiguous; refresh and explicitly reselect.'));
  const entry = candidates.length === 1 ? candidates[0] : null;
  if (entry) {
    failures.push(...entry.reasons);
    if (!selectable(fresh, entry))
      failures.push(issue('target-ineligible', 'Fresh target/source evidence is not qualified for confirmation.'));
    if (!sameData(binding.identity, entry.identity) || !sameData(binding.clearingScope, entry.clearingScope) ||
      !sameData(binding.capacity, fresh.report.capacity))
      failures.push(issue('identity-changed', 'Identity, capacity or exact clearing scope changed; explicitly reselect.'));
    if (!sameData(binding.observation, entry.observation))
      failures.push(issue('observation-changed', 'Node, topology or diskseq changed; possible hotplug requires reselection.'));
  }
  if (!sameData(binding.source, fresh.source))
    failures.push(issue('source-changed', 'Installation source evidence changed; confirmation is invalid.'));
  return freezeData({ matches: !failures.length, ...RO, device: failures.length ? null : entry,
    reasons: failures });
}

export function formatBytes(value) {
  return value === null ? 'Unknown (not zero)' : String(value) + ' bytes (' +
    (value / (1024 ** 3)).toFixed(3) + ' GiB)';
}
