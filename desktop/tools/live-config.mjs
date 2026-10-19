import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { hardwareProfile } from './live-profiles.mjs';

const release = new URL('../release/debian/', import.meta.url);
const read = name => JSON.parse(fs.readFileSync(new URL(name, release), 'utf8'));
export const standardRuntimePackages = read('runtime-packages.json').install;
const bootPins = read('boot-dependencies.json').packages;
export const standardCapabilities = Object.freeze({
  renderer: 'raster', webgl2: true, vulkan: true, fonts: 'wide', ime: 'luna-pinyin', audio: 'standard',
});
export const requiredCapabilities = Object.freeze([
  'shell', 'files', 'settings', 'processes', 'chinese-text-and-candidates', 'chinese-filenames',
  'wayland-kms', 'usb-input-storage', 'wired-ipv4-dhcp', 'pam-uid1000', 'ready-diagnostics',
  'early-plymouth', 'ram-root-bootstrap-64mib',
]);
const minimalCapabilities = { ...standardCapabilities, webgl2: false, vulkan: false, fonts: 'zh-common' };
const variants = {
  'standard-effects4': { available: true, capabilities: standardCapabilities,
    recipe: 'desktop/release/debian/Containerfile.sdk',
    requirements: ['Frozen standard runtime with original package pins, SDL patch and wlroots effects ABI 4.'] },
  'minimal-zh-cpu': { available: false, capabilities: minimalCapabilities, recipe: null,
    requirements: [
      'Unavailable: verified CPU-only wlroots/DRM allocator variant without the GBM -> Gallium -> LLVM package closure.',
      'Unavailable: paired application/SDL/Skia GL capability gates and native ABI receipt; PU_WEBGL2=OFF alone is insufficient.',
      'Unavailable: WQY Micro Hei font fallback, Chinese candidates and arbitrary user text qualification.',
      'Standard audio intentionally retains SPA -> ONNX -> DNNL; Debian Luna retains its hard dependency on stroke.',
    ] },
};
const packageName = /^[a-z0-9][a-z0-9+.-]*$/;
const version = /^[A-Za-z0-9.+:~_-]+$/;
const spec = /^[a-z0-9][a-z0-9+.-]*(?:=[A-Za-z0-9.+:~_-]+)?$/;
const shaPattern = /^[0-9a-f]{64}$/;
const fail = message => { throw new Error(message); };
export const canonical = value => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])]));
  return value;
}
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const objectHash = value => sha256(canonical(value));
function fields(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort())) fail('Invalid fields: ' + label);
}
function list(value, pattern, label, empty = false) {
  if (!Array.isArray(value) || !empty && !value.length || value.length > 4096 ||
      new Set(value).size !== value.length || value.some(item => typeof item !== 'string' || !pattern.test(item)))
    fail('Invalid/empty/duplicate list: ' + label);
}
function text(value, label, max = 512) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x08\x0b-\x1f]/.test(value))
    fail('Invalid text: ' + label);
}
export function normalizeConfig(value) {
  fields(value, ['schemaVersion', 'name', 'description', 'target', 'hardware', 'media', 'nativeVariant',
    'capabilities', 'packageGroups', 'policy'], 'configuration');
  if (value.schemaVersion !== 1 || typeof value.name !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(value.name))
    fail('Unsupported configuration version/name');
  text(value.description, 'description');
  fields(value.target, ['distribution', 'architecture'], 'target');
  if (value.target.distribution !== 'debian13' || value.target.architecture !== 'x86_64' ||
      value.media !== 'live-iso-usb') fail('Unsupported target/media');
  const hardware = hardwareProfile(value.hardware);
  const variant = variants[value.nativeVariant];
  if (!variant) fail('Unknown native variant');
  fields(value.capabilities, Object.keys(standardCapabilities), 'capabilities');
  if (!isDeepStrictEqual(value.capabilities, variant.capabilities))
    fail('Capabilities conflict with the declared native variant');
  fields(value.policy, ['noRecommends', 'forbidden', 'pins'], 'policy');
  if (value.policy.noRecommends !== true) fail('Only noRecommends=true is supported');
  list(value.policy.forbidden, packageName, 'forbidden', true);
  list(value.policy.pins, /^[a-z0-9][a-z0-9+.-]*=[A-Za-z0-9.+:~_-]+$/, 'pins', true);
  if (new Set(value.policy.pins.map(pin => pin.split('=')[0])).size !== value.policy.pins.length)
    fail('Conflicting package pins');
  if (!Array.isArray(value.packageGroups) || !value.packageGroups.length || value.packageGroups.length > 32)
    fail('Invalid/empty package groups');
  const installed = new Set(), stages = { runtime: [], platform: [], boot: [] }, requests = new Map();
  const descriptions = new Set();
  for (const group of value.packageGroups) {
    fields(group, ['description', 'stage', 'install'], 'package group');
    text(group.description, 'package group description');
    if (descriptions.has(group.description) || !Object.hasOwn(stages, group.stage))
      fail('Duplicate group description/unknown stage');
    descriptions.add(group.description);
    list(group.install, spec, 'install');
    for (const item of group.install) {
      const name = item.split('=')[0];
      if (stages[group.stage].some(item => item.split('=')[0] === name))
        fail('Duplicate package in stage: ' + name);
      const previous = requests.get(name);
      if (previous && previous !== item) fail('Conflicting cross-stage package request: ' + name);
      requests.set(name, item);
      installed.add(name);
      stages[group.stage].push(item);
    }
  }
  if (Object.values(stages).some(items => !items.length)) fail('Each runtime/platform/boot stage needs packages');
  for (const name of value.policy.forbidden)
    if (installed.has(name)) fail('Requested package is forbidden: ' + name);
  const pins = new Map(value.policy.pins.map(pin => pin.split('=')));
  for (const items of Object.values(stages))
    for (const item of items) {
      const [name, pin] = item.split('=');
      if (pin && pins.has(name) && pins.get(name) !== pin) fail('Conflicting requested/policy pin: ' + name);
    }
  for (const [name, pin] of Object.entries(bootPins))
    if (!stages.boot.includes(name + '=' + pin)) fail('Missing exact early boot pin: ' + name);
  for (const item of hardware.requiredPackages)
    if (!stages.platform.includes(item)) fail('Missing hardware package: ' + item);
  for (const item of hardware.forbiddenPackages)
    if (installed.has(item)) fail('Hardware/package conflict: ' + item);
  for (const item of installed)
    if (item.startsWith('firmware-') && !hardware.requiredPackages.includes(item))
      fail('Undeclared hardware firmware: ' + item);
  if (value.nativeVariant === 'standard-effects4' &&
      !isDeepStrictEqual([...stages.runtime].sort(), [...standardRuntimePackages].sort()))
    fail('Standard native runtime package selection cannot be relabelled or trimmed');
  if (value.nativeVariant === 'minimal-zh-cpu') {
    for (const name of ['fonts-wqy-microhei', 'fonts-dejavu-core', 'fontconfig', 'librime-data',
      'rime-data-luna-pinyin', 'pipewire-bin', 'libspa-0.2-modules', 'libwayland-client0',
      'libxkbcommon0', 'libinput-bin', 'xkb-data'])
      if (!stages.runtime.some(item => item.split('=')[0] === name)) fail('Missing minimal baseline package: ' + name);
    for (const name of ['fonts-noto-core', 'fonts-noto-cjk', 'fonts-noto-color-emoji',
      'mesa-vulkan-drivers', 'mesa-libgallium', 'libllvm19'])
      if (!value.policy.forbidden.includes(name)) fail('Missing minimal forbidden package: ' + name);
    if (!stages.runtime.includes('fonts-wqy-microhei=0.2.0-beta-4'))
      fail('Minimal Chinese font must use the declared Debian WQY version');
  }
  return structuredClone(value);
}

// YAML is a build-time dependency only. Legacy CLI and --help do not import it.
export async function parseConfig(textValue) {
  if (typeof textValue !== 'string' || Buffer.byteLength(textValue) > 64 * 1024)
    fail('Configuration exceeds 64 KiB');
  const { parseDocument, visit, isAlias } = await import('yaml');
  const document = parseDocument(textValue, { version: '1.2', schema: 'core', uniqueKeys: true,
    strict: true, merge: false, prettyErrors: false });
  if (document.errors.length || document.warnings.length)
    fail('Invalid YAML: ' + [...document.errors, ...document.warnings].map(error => error.message).join('; '));
  visit(document, (_, node) => {
    if (isAlias(node) || node.anchor || node.tag) fail('YAML tags, anchors and aliases are not supported');
  });
  return normalizeConfig(document.toJS({ maxAliasCount: 0 }));
}
export const loadConfig = async file => parseConfig(fs.readFileSync(file, 'utf8'));
export function legacyConfig(sku) {
  return normalizeConfig({
    schemaVersion: 1, name: 'standard-' + sku, description: 'Unchanged standard desktop and hardware selection.',
    target: { distribution: 'debian13', architecture: 'x86_64' }, hardware: sku, media: 'live-iso-usb',
    nativeVariant: 'standard-effects4', capabilities: { ...standardCapabilities },
    packageGroups: [
      { description: 'Native runtime roots', stage: 'runtime', install: [...standardRuntimePackages] },
      { description: 'Hardware and system services', stage: 'platform', install: hardwareProfile(sku).requiredPackages },
      { description: 'Early splash', stage: 'boot', install: Object.entries(bootPins).map(([name, pin]) => name + '=' + pin) },
    ],
    policy: { noRecommends: true, forbidden: [], pins: [] },
  });
}
export function packageStages(config) {
  const stages = { runtime: [], platform: [], boot: [] }, pins = new Map(config.policy.pins.map(pin => pin.split('=')));
  for (const group of config.packageGroups)
    stages[group.stage].push(...group.install.map(item => {
      const name = item.split('=')[0];
      return pins.has(name) ? name + '=' + pins.get(name) : item;
    }));
  for (const items of Object.values(stages)) items.sort();
  return stages;
}
export function resolvePlan(value, lock = null) {
  const config = normalizeConfig(value), stages = packageStages(config), variant = variants[config.nativeVariant];
  const nativeInputs = { nativeVariant: config.nativeVariant, capabilities: config.capabilities,
    runtimePackages: stages.runtime, recipe: variant.recipe, requiredCapabilities,
    wlrootsEffects: read('wlroots-effects.json'),
    compileOptions: config.nativeVariant === 'standard-effects4' ?
      { PU_WEBGL2: 'ON', PU_WEBGPU: 'OFF', wlrootsEffectsAbi: 4, compositorDefault: 'pixman' } :
      { PU_WEBGL2: 'OFF', PU_WEBGPU: 'OFF', compositorDefault: 'pixman',
        dependencyVariant: 'unavailable-cpu-drm-allocator' } };
  const request = { target: config.target, stages, forbidden: [...config.policy.forbidden].sort(),
    noRecommends: true, hardware: hardwareProfile(config.hardware) };
  const plan = {
    schemaVersion: 1, kind: 'polly-live-build-plan', configuration: config,
    configSha256: objectHash(config), nativeVariantInputSha256: objectHash(nativeInputs),
    packageRequestSha256: objectHash(request), native: { ...nativeInputs, available: variant.available,
      requirements: variant.requirements }, hardwareProfile: request.hardware, stages,
    constraints: { requiredCapabilities, bootstrapMaxBytes: 64 * 1024 * 1024, copyToRam: true,
      kernelPrerequisite: config.hardware === 'basic' ? 'explicit verified dedicated basic kernel pack' : 'stock Debian kernel',
      root: 'squashfs-ram-overlay', nativeRebuild: false },
    status: variant.available ? 'unresolved' : 'blocked',
    blockers: variant.available ? [] : [...variant.requirements.filter(item => item.startsWith('Unavailable:'))],
    archiveTrust: read('archive-trust.json'),
    resolution: { status: 'unresolved', packages: null,
      explanation: 'Top-level requests only; no APT dependency/provider/architecture solution has been supplied.' },
    stableAliasEligible: isDeepStrictEqual(stages, packageStages(legacyConfig('full'))) &&
      config.hardware === 'full' && isDeepStrictEqual(config.capabilities, standardCapabilities) &&
      config.nativeVariant === 'standard-effects4' && config.policy.forbidden.length === 0 &&
      config.policy.pins.length === 0,
    size: { kind: 'unmeasured', isoBytes: null, archiveBytesProxy: null },
  };
  if (lock) {
    validateLock(lock, plan);
    plan.resolution = { status: 'resolved-unverified', lockSha256: objectHash(lock),
      source: lock.solver, runtimeManifestSha256: lock.runtimeManifestSha256,
      runtimeImageID: lock.runtimeImageID, packages: lock.packages,
      explanation: 'Saved APT result, not authentication. Build must reverify signatures, archives, base inventory and APT simulation.' };
    plan.size.archiveBytesProxy = lock.archives.reduce((sum, item) => sum + item.bytes, 0);
    if (variant.available) plan.status = 'resolved-unverified';
  }
  plan.planSha256 = objectHash(plan);
  return plan;
}
export function validatePlan(plan) {
  if (!plan) fail('Missing build plan');
  const expected = resolvePlan(plan.configuration);
  if (!isDeepStrictEqual(expected, { ...plan, status: expected.status,
    resolution: expected.resolution, size: expected.size, planSha256: expected.planSha256 }))
    fail('Build plan differs from normalized configuration');
  const { planSha256, ...content } = plan;
  if (objectHash(content) !== planSha256) fail('Build plan hash mismatch');
  return plan;
}
export function validateLock(lock, plan) {
  fields(lock, ['schemaVersion', 'kind', 'packageRequestSha256', 'runtimeManifestSha256', 'runtimeImageID',
    'solver', 'packages', 'archives', 'sources'], 'APT lock');
  if (lock.schemaVersion !== 1 || lock.kind !== 'polly-apt-resolution' ||
      lock.packageRequestSha256 !== plan.packageRequestSha256 || !shaPattern.test(lock.runtimeManifestSha256) ||
      !/^(?:sha256:)?[0-9a-f]{64}$/.test(lock.runtimeImageID)) fail('Lock request/runtime identity mismatch');
  fields(lock.solver, ['name', 'version', 'note'], 'solver');
  if (lock.solver.name !== 'apt-get') fail('Only an APT solution is supported');
  text(lock.solver.version, 'APT version'); text(lock.solver.note, 'solver provenance');
  const packages = new Map();
  if (!Array.isArray(lock.packages) || !lock.packages.length || lock.packages.length > 4096)
    fail('Invalid resolved packages');
  for (const item of lock.packages) {
    fields(item, ['name', 'version', 'architecture', 'reason'], 'resolved package');
    if (typeof item.name !== 'string' || typeof item.version !== 'string' ||
        !packageName.test(item.name) || !version.test(item.version) ||
        !['amd64', 'all'].includes(item.architecture) || packages.has(item.name)) fail('Invalid/duplicate resolved package');
    text(item.reason, 'package reason');
    packages.set(item.name, item.version);
  }
  for (const item of Object.values(plan.stages).flat()) {
    const [name, pin] = item.split('=');
    if (!packages.has(name) || pin && packages.get(name) !== pin) fail('Lock omits requested package/pin: ' + item);
  }
  if ([...plan.configuration.policy.forbidden, ...plan.hardwareProfile.forbiddenPackages]
    .some(name => packages.has(name))) fail('Lock contains forbidden package');
  for (const item of plan.configuration.policy.pins) {
    const [name, pin] = item.split('=');
    if (packages.get(name) !== pin) fail('Lock violates policy pin: ' + item);
  }
  if (!Array.isArray(lock.sources) || !lock.sources.length || lock.sources.length > 32 ||
      !Array.isArray(lock.archives) || lock.archives.length > 4096) fail('Invalid lock sources/archives');
  const file = value => {
    fields(value, ['path', 'sha256'], 'locked file');
    if (typeof value.path !== 'string' || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value.path) ||
        value.path.split('/').some(part => part === '.' || part === '..') || !shaPattern.test(value.sha256))
      fail('Unsafe locked file');
  };
  const sources = new Set();
  for (const source of lock.sources) {
    fields(source, ['id', 'inRelease', 'index', 'releasePath'], 'APT source');
    if (typeof source.id !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(source.id) || sources.has(source.id) ||
        !/^(?:main|non-free-firmware)\/binary-amd64\/Packages$/.test(source.releasePath)) fail('Invalid APT source');
    sources.add(source.id); file(source.inRelease); file(source.index);
  }
  const archives = new Set();
  for (const archive of lock.archives) {
    fields(archive, ['name', 'version', 'architecture', 'path', 'sha256', 'bytes', 'source', 'stage'], 'archive');
    file({ path: archive.path, sha256: archive.sha256 });
    if (archive.path !== 'packages/' + archive.sha256 + '.deb' || archives.has(archive.name) ||
        !packageName.test(archive.name) || packages.get(archive.name) !== archive.version ||
        !['amd64', 'all'].includes(archive.architecture) || !sources.has(archive.source) ||
        !['platform', 'boot'].includes(archive.stage) ||
        !Number.isSafeInteger(archive.bytes) || archive.bytes <= 0 || archive.bytes > 512 * 1024 * 1024)
      fail('Invalid locked archive');
    archives.add(archive.name);
  }
  return lock;
}
export function configIdentity(plan) {
  validatePlan(plan);
  if (plan.status !== 'resolved-unverified') fail('Configuration has no buildable resolution');
  return { schemaVersion: 1, name: plan.configuration.name, configSha256: plan.configSha256,
    nativeVariantInputSha256: plan.nativeVariantInputSha256, planSha256: plan.planSha256,
    packageRequestSha256: plan.packageRequestSha256, lockSha256: plan.resolution.lockSha256,
    nativeVariant: plan.configuration.nativeVariant, capabilities: plan.configuration.capabilities,
    stableAliasEligible: plan.stableAliasEligible };
}
export const configMediaLabel = identity => `${identity.name}-${identity.planSha256.slice(0, 12)}`;
export function verifyLockFiles(directory, lock) {
  const entries = [...lock.sources.flatMap(source => [source.inRelease, source.index]), ...lock.archives];
  for (const entry of entries) {
    let current = directory;
    for (const segment of entry.path.split('/')) {
      current = path.join(current, segment);
      if (fs.lstatSync(current).isSymbolicLink()) fail('Linked lock input: ' + entry.path);
    }
    const info = fs.lstatSync(current);
    if (!info.isFile() || entry.bytes !== undefined && info.size !== entry.bytes ||
        info.size > (entry.bytes === undefined ? 128 * 1024 * 1024 : 512 * 1024 * 1024))
      fail('Lock input changed or is oversize: ' + entry.path);
    const handle = fs.openSync(current, 'r'), buffer = Buffer.alloc(1024 * 1024), hash = createHash('sha256');
    try {
      let count;
      while ((count = fs.readSync(handle, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count));
    } finally { fs.closeSync(handle); }
    if (hash.digest('hex') !== entry.sha256) fail('Lock input changed: ' + entry.path);
  }
}
