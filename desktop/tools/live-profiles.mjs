import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

const manifestBytes = readFileSync(new URL('../release/debian/live-profiles.json', import.meta.url));
export const profileManifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
const names = ['full', 'vm', 'intel', 'nvidia'];
const fail = message => { throw new Error(message); };
const keys = (value, expected) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort()))
    fail('Invalid hardware profile manifest fields');
};
const strings = (value, pattern) => {
  if (!Array.isArray(value) || !value.length || new Set(value).size !== value.length ||
      value.some(item => typeof item !== 'string' || !item || pattern && !pattern.test(item)))
    fail('Invalid/duplicate hardware profile list');
};
export function validateProfileManifest(value) {
  keys(value, ['schemaVersion', 'distribution', 'architecture', 'defaultSku', 'packageGroups', 'shared', 'profiles']);
  if (value.schemaVersion !== 1 || value.distribution !== 'debian13' ||
      value.architecture !== 'x86_64' || value.defaultSku !== 'full')
    fail('Unsupported hardware profile manifest');
  keys(value.packageGroups, ['common', 'intelGraphics', 'nvidiaGraphics', 'physicalNetworkAudio']);
  const packages = [];
  for (const group of Object.values(value.packageGroups)) {
    strings(group, /^[a-z0-9][a-z0-9+.-]*(?:=[A-Za-z0-9.+:~_-]+)?$/);
    packages.push(...group.map(pkg => pkg.split('=')[0]));
  }
  if (new Set(packages).size !== packages.length) fail('Duplicate package across hardware groups');
  strings(value.shared);
  keys(value.profiles, names);
  for (const profile of Object.values(value.profiles)) {
    keys(profile, ['packageGroups', 'requiredModules', 'support']);
    strings(profile.packageGroups);
    strings(profile.requiredModules, /^[a-z][a-z0-9_]*$/);
    strings(profile.support);
    if (!profile.packageGroups.includes('common') ||
        profile.packageGroups.some(group => !Object.hasOwn(value.packageGroups, group)))
      fail('Unknown/missing hardware package group');
  }
  return value;
}
const manifest = validateProfileManifest(JSON.parse(manifestBytes));
export function parseSkus(text = manifest.defaultSku) {
  if (typeof text !== 'string' || !text) fail('Empty hardware SKU selection');
  const result = text.split(',');
  if (new Set(result).size !== result.length || result.some(name => !names.includes(name)))
    fail('Unknown, empty or duplicate hardware SKU');
  return result;
}
export function hardwareProfile(sku) {
  if (parseSkus(sku).length !== 1) fail('Expected exactly one hardware SKU');
  const selected = manifest.profiles[sku];
  return { sku, manifestSha256: profileManifestSha256,
    requiredPackages: selected.packageGroups.flatMap(group => manifest.packageGroups[group]),
    forbiddenPackages: Object.entries(manifest.packageGroups)
      .filter(([name]) => !selected.packageGroups.includes(name)).flatMap(([, group]) => group.map(pkg => pkg.split('=')[0])),
    requiredModules: selected.requiredModules, support: selected.support, shared: manifest.shared };
}
export const hardwareMarker = sku => JSON.stringify({
  schemaVersion: 1, sku, manifestSha256: profileManifestSha256,
}, null, 2) + '\n';

export function validateHardwareMedia(value) {
  if (!Object.hasOwn(value, 'sku')) {
    if (value.hardwareProfile !== undefined || value.nativeRuntime !== undefined || value.sizeReport !== undefined)
      fail('Unlabelled hardware profile receipt');
    return null;
  }
  const expected = hardwareProfile(value.sku);
  if (value.distribution !== 'debian13' || !isDeepStrictEqual(value.hardwareProfile, expected))
    fail('Hardware profile differs from source manifest');
  const native = value.nativeRuntime;
  if (!native || !/^(?:sha256:)?[0-9a-f]{64}$/.test(native.imageID) ||
      !/^[0-9a-f]{40}$/.test(native.sourceRevision) || !/^[0-9a-f]{64}$/.test(native.manifestSha256) ||
      value.runtimeImage !== native.imageID || !/^(?:sha256:)?[0-9a-f]{64}$/.test(value.imageToolsID))
    fail('Missing immutable common native runtime/tools identity');
  for (const [key, suffix] of [['iso', 'uefi-live.iso'], ['usb', 'uefi-usb.img']])
    if (value[key]?.name !== `pollydesktop-${value.version}-debian13-${value.sku}-x86_64-${suffix}`)
      fail('Media filename does not match hardware SKU');
  const report = value.sizeReport;
  if (!report || report.sku !== value.sku || report.manifestSha256 !== expected.manifestSha256 ||
      !Array.isArray(report.packages) || !report.packages.length || !Array.isArray(report.limits))
    fail('Missing actual hardware package size report');
  const installed = new Map();
  for (const record of report.packages) {
    if (!record || !/^[a-z0-9][a-z0-9+.-]*$/.test(record.name) || installed.has(record.name) ||
        typeof record.version !== 'string' || !record.version ||
        ![record.installedSizeBytes, record.regularFileBytes].every(n => Number.isSafeInteger(n) && n >= 0))
      fail('Invalid hardware package size record');
    installed.set(record.name, record.version);
  }
  for (const spec of expected.requiredPackages) {
    const [name, pin] = spec.split('=');
    if (!installed.has(name) || pin && installed.get(name) !== pin) fail('Missing/wrong hardware profile package: ' + spec);
  }
  if (expected.forbiddenPackages.some(name => installed.has(name))) fail('Forbidden hardware profile package');
  const allowed = new Set(expected.requiredPackages.map(spec => spec.split('=')[0]));
  if ([...installed.keys()].some(name => name.startsWith('firmware-') && !allowed.has(name)))
    fail('Undeclared hardware firmware package');
  const inventory = new Map();
  if (!Array.isArray(value.packages)) fail('Missing hardware media package inventory');
  for (const pkg of value.packages) {
    if (!pkg || typeof pkg.name !== 'string' || typeof pkg.version !== 'string' || !pkg.version)
      fail('Invalid hardware media package');
    const name = pkg.name.replace(/:amd64$/, '');
    if (inventory.has(name)) fail('Duplicate hardware media package: ' + name);
    inventory.set(name, pkg.version);
  }
  if (inventory.size !== installed.size ||
      [...inventory].some(([name, version]) => !installed.has(name) || installed.get(name) !== version))
    fail('Hardware size report differs from media package inventory');
  const measured = report.media;
  if (!measured || measured.isoBytes !== value.iso.size || measured.usbBytes !== value.usb.size ||
      measured.rootBytes !== value.root?.size || measured.bootstrapBytes !== value.root?.bootstrap?.size ||
      measured.bootstrapUncompressedBytes !== value.root?.bootstrap?.uncompressedBytes ||
      measured.rootUncompressedBytes !== value.uncompressedPayloadBytes)
    fail('Hardware size report differs from actual media totals');
  return expected;
}
