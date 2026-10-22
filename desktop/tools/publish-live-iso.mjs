import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateLiveRootReceipt } from './live-layout.mjs';
import { resolvePlan, configIdentity, objectHash } from './live-config.mjs';
import { configurationLabel } from './configuration-receipt.mjs';

export const DEFAULT_DESTINATION = String.raw`D:\temp\PollyOS`;
export const ALIAS = 'PollyOS.iso';
export function digest(file) {
  const fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(1024 * 1024), hash = createHash('sha256');
  try {
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count));
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}
function regular(file) {
  const info = fs.lstatSync(file);
  if (!info.isFile()) throw new Error('Expected a regular artifact, not a symbolic link: ' + file);
  return info;
}
export function verifyBundle(directory) {
  regular(path.join(directory, 'SHA256SUMS'));
  const checksums = new Map();
  for (const line of fs.readFileSync(path.join(directory, 'SHA256SUMS'), 'utf8').trimEnd().split(/\r?\n/)) {
    const match = line.match(/^([0-9a-f]{64})  (.+)$/);
    if (!match) throw new Error('Invalid SHA256SUMS record');
    const [, sha, name] = match;
    if (path.posix.isAbsolute(name) || /[\\:<>"|?*\x00-\x1f]/.test(name) ||
        name.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) ||
        checksums.has(name.toLowerCase()))
      throw new Error('Unsafe or duplicate checksum path: ' + name);
    let parent = directory;
    for (const part of name.split('/').slice(0, -1)) {
      parent = path.join(parent, part);
      if (!fs.lstatSync(parent).isDirectory() || fs.lstatSync(parent).isSymbolicLink())
        throw new Error('Linked artifact directory: ' + name);
    }
    const file = path.join(directory, name);
    regular(file);
    if (digest(file) !== sha) throw new Error('Artifact checksum mismatch: ' + name);
    checksums.set(name.toLowerCase(), { name, sha });
  }
  for (const name of ['live-manifest.json', 'candidate-origin.json'])
    if (!checksums.has(name)) throw new Error('Missing verified media receipt: ' + name);
  const read = name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
  const manifest = read('live-manifest.json'), origin = read('candidate-origin.json'), iso = manifest.iso;
  const layout = validateLiveRootReceipt(manifest, origin);
  if (manifest.configuration !== undefined) {
    for (const name of ['resolved-plan.json', 'packages.lock.json', 'configuration-sbom.spdx.json'])
      if (!checksums.has(name)) throw new Error('Missing configured build input: ' + name);
    const plan = read('resolved-plan.json'), lock = read('packages.lock.json');
    const expected = resolvePlan(plan.configuration, lock);
    if (objectHash(expected) !== objectHash(plan) ||
        objectHash(configIdentity(plan)) !== objectHash(manifest.configuration) ||
        plan.configuration.hardware !== manifest.sku ||
        lock.runtimeImageID !== manifest.runtimeImage ||
        lock.runtimeManifestSha256 !== manifest.nativeRuntime.manifestSha256 ||
        objectHash(plan.resolution.packages.map(({ name, version, architecture }) => ({ name, version, architecture }))
          .sort((a, b) => a.name.localeCompare(b.name))) !==
        objectHash(manifest.sizeReport.packages.map(({ name, version, architecture }) => ({ name, version, architecture }))
          .sort((a, b) => a.name.localeCompare(b.name))))
      throw new Error('Configured media differs from resolved plan/native runtime/actual package inventory');
    const sbom = read('configuration-sbom.spdx.json');
    if (sbom.spdxVersion !== 'SPDX-2.3' || objectHash(sbom.configuration) !== objectHash(manifest.configuration) ||
        sbom.nativeRuntimeManifestSha256 !== manifest.nativeRuntime.manifestSha256 ||
        objectHash(sbom.packages?.map(({ name, versionInfo, architecture }) => ({ name, versionInfo, architecture }))) !==
        objectHash(lock.packages.map(item => ({
          name: item.name, versionInfo: item.version, architecture: item.architecture,
        })))) throw new Error('Configured SBOM differs from actual locked native/package inputs');
  } else if (['resolved-plan.json', 'packages.lock.json', 'configuration-sbom.spdx.json']
    .some(name => checksums.has(name) || fs.existsSync(path.join(directory, name))))
    throw new Error('Unlabelled configured media inputs');
  if (layout === 'squashfs-ram-overlay' &&
      (checksums.get(manifest.usb?.name?.toLowerCase())?.sha !== manifest.usb?.sha256 ||
       !Number.isSafeInteger(manifest.usb.size) || manifest.usb.size <= 0 ||
       regular(path.join(directory, manifest.usb.name)).size !== manifest.usb.size ||
       checksums.get('grub.cfg')?.sha !== manifest.grub.embeddedSha256))
    throw new Error('Compressed RAM root USB/config receipt is missing or mismatched');
  if (typeof iso?.name !== 'string' || /[/\\]/.test(iso.name) || !iso.name.endsWith('.iso') ||
      checksums.get(iso.name.toLowerCase())?.sha !== iso.sha256 ||
      !Number.isSafeInteger(iso.size) || iso.size <= 0 || regular(path.join(directory, iso.name)).size !== iso.size)
    throw new Error('Actual ISO does not match the Live manifest');
  for (const revision of [manifest.sourceRevision, origin.runtimeSourceRevision, origin.mediaProducerRevision])
    if (typeof revision !== 'string' || !/^[0-9a-f]{40}$/.test(revision)) throw new Error('Missing source revision');
  if (manifest.sourceDirty !== false || origin.runtimeSourceDirty !== false || origin.fixtureOnly === true ||
      origin.isoSha256 !== iso.sha256 || origin.mediaProducerRevision !== manifest.sourceRevision ||
      origin.runtimeImageID !== manifest.runtimeImage ||
      !Number.isSafeInteger(origin.isoPayloadFilesVerified) || origin.isoPayloadFilesVerified <= 0 ||
      manifest.architecture !== 'x86_64')
    throw new Error('ISO payload/source verification receipt does not match this clean Live bundle');
  if (Object.hasOwn(manifest, 'sku') &&
      (manifest.nativeRuntime.sourceRevision !== origin.runtimeSourceRevision ||
       manifest.nativeRuntime.manifestSha256 !== origin.runtimeManifestSha256))
    throw new Error('Common native runtime source/manifest differs from actual verification receipt');
  for (const value of [manifest.version, manifest.distribution])
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/.test(value))
      throw new Error('Unsafe version or distribution');
  return { manifest, origin, checksums: [...checksums.values()] };
}
const sameFile = (a, b) => {
  const left = fs.statSync(a, { bigint: true }), right = fs.statSync(b, { bigint: true });
  return left.dev === right.dev && left.ino === right.ino && left.ino !== 0n;
};
const identity = file => {
  const info = fs.statSync(file, { bigint: true });
  return { device: String(info.dev), inode: String(info.ino), links: Number(info.nlink) };
};
export function publish(directory, destination = DEFAULT_DESTINATION, options = {}) {
  if (process.platform !== 'win32' && destination === DEFAULT_DESTINATION)
    throw new Error('The default is a Windows path; non-Windows hosts must pass --destination');
  directory = fs.realpathSync(directory);
  destination = path.resolve(destination);
  const { manifest, origin, checksums } = verifyBundle(directory);
  const updateAlias = options.updateAlias ?? !Object.hasOwn(manifest, 'sku');
  if (typeof updateAlias !== 'boolean') throw new Error('updateAlias must be an explicit boolean');
  if (updateAlias && Object.hasOwn(manifest, 'sku') && manifest.sku !== 'standard')
    throw new Error('Only the explicit standard hardware SKU may update PollyOS.iso; publish reduced SKUs versioned-only');
  if (updateAlias && manifest.configuration && !manifest.configuration.stableAliasEligible)
    throw new Error('Only the exact standard capability/package contract may update PollyOS.iso');
  const relative = path.relative(directory, destination);
  if (!relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
    throw new Error('Publication destination must not be inside its source bundle');
  fs.mkdirSync(destination, { recursive: true });
  const alias = path.join(destination, ALIAS);
  const aliasInfo = fs.lstatSync(alias, { throwIfNoEntry: false });
  if (updateAlias && aliasInfo && !aliasInfo.isFile())
    throw new Error('Refusing to replace a non-regular ISO alias');
  const release = path.join(destination, `pollydesktop-${manifest.version}-${manifest.distribution}-` +
    (Object.hasOwn(manifest, 'sku') ? `${manifest.sku}-` : '') +
    (manifest.configuration ? configurationLabel(manifest.configuration) + '-' : '') +
    `${origin.runtimeSourceRevision.slice(0, 7)}-${origin.mediaProducerRevision.slice(0, 7)}-${manifest.iso.sha256.slice(0, 12)}`);
  if (fs.existsSync(release)) {
    if (fs.lstatSync(release).isSymbolicLink() ||
        JSON.stringify(verifyBundle(release).checksums) !== JSON.stringify(checksums))
      throw new Error('Existing versioned release differs; refusing to overwrite: ' + release);
  } else {
    const staging = fs.mkdtempSync(path.join(destination, '.polly-publish-'));
    try {
      for (const { name } of checksums) {
        const target = path.join(staging, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(directory, name), target, fs.constants.COPYFILE_EXCL);
      }
      fs.copyFileSync(path.join(directory, 'SHA256SUMS'), path.join(staging, 'SHA256SUMS'));
      if (JSON.stringify(verifyBundle(staging).checksums) !== JSON.stringify(checksums))
        throw new Error('Copied Live bundle differs from the verified source');
      fs.renameSync(staging, release);
    } finally { if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true }); }
  }
  const iso = path.join(release, manifest.iso.name);
  if (!updateAlias) return {
    schemaVersion: 1, releaseDirectory: release, iso, sku: manifest.sku,
    ...(manifest.configuration ? { configuration: manifest.configuration } : {}),
    alias: null, aliasType: 'not-updated', bytes: regular(iso).size, sha256: manifest.iso.sha256,
    runtimeSourceRevision: origin.runtimeSourceRevision, mediaProducerRevision: manifest.sourceRevision,
    runtimeImageID: manifest.runtimeImage, isoFileIdentity: identity(iso),
    limits: ['Versioned SKU publication only; stable alias was not changed. Not boot/hardware qualification.'],
  };
  const temporary = path.join(destination, '.PollyOS-' + randomUUID() + '.iso');
  try {
    fs.linkSync(iso, temporary);
    if (!sameFile(temporary, iso)) throw new Error('Temporary alias is not a hard link to the versioned ISO');
    fs.renameSync(temporary, alias);
  } catch (cause) {
    throw new Error('ISO alias update failed; versioned release retained at ' + release +
      '. The old alias was not overwritten in place. If Windows reports a sharing violation, ' +
      'close its optical-media handle yourself; no VM was changed.', { cause });
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  if (!sameFile(iso, alias) || identity(iso).links < 2 || digest(alias) !== manifest.iso.sha256)
    throw new Error('Published alias identity verification failed');
  return {
    schemaVersion: 1, releaseDirectory: release, iso, alias, aliasType: 'hardlink',
    ...(manifest.configuration ? { configuration: manifest.configuration } : {}),
    bytes: regular(iso).size, sha256: manifest.iso.sha256,
    runtimeSourceRevision: origin.runtimeSourceRevision, mediaProducerRevision: manifest.sourceRevision,
    runtimeImageID: manifest.runtimeImage, isoFileIdentity: identity(iso), aliasFileIdentity: identity(alias),
    limits: ['Integrity and hard-link publication only; not UEFI/Hyper-V or physical acceptance.',
      'An already-open optical handle may still refer to the previous ISO inode.'],
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const directory = args.shift();
  let destination, updateAlias;
  const seen = new Set();
  while (args.length) {
    const option = args.shift();
    if (seen.has(option)) throw new Error('Duplicate publication option: ' + option);
    seen.add(option);
    if (option === '--destination' && args[0] && !args[0].startsWith('--')) destination = args.shift();
    else if (option === '--update-alias') updateAlias = true;
    else if (option === '--no-alias') updateAlias = false;
    else throw new Error('Invalid publication option: ' + option);
  }
  if (!directory || directory.startsWith('--') || seen.has('--update-alias') && seen.has('--no-alias'))
    throw new Error('Usage: node publish-live-iso.mjs VERIFIED_MEDIA [--destination DIRECTORY] [--update-alias|--no-alias]');
  console.log(JSON.stringify(publish(directory, destination, { updateAlias }), null, 2));
}
