import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const checksum = /^[0-9a-f]{64}$/;
const revision = /^[0-9a-f]{40}$/;
function requireValue(value, message) { if (!value) throw new Error(message); }
function relative(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 &&
    !/[\\:\u0000-\u001f\u007f]/.test(value) &&
    !value.split('/').some(part => !part || part === '.' || part === '..');
}
async function file(root, name) {
  requireValue(relative(name), 'Invalid release-relative path: ' + String(name));
  let current = root;
  const parts = name.split('/');
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const info = await lstat(current);
    requireValue(!info.isSymbolicLink() && (index + 1 === parts.length ? info.isFile() : info.isDirectory()),
      'Release paths must contain only directories and regular files: ' + name);
  }
  return current;
}
async function json(root, name) {
  const filename = await file(root, name);
  requireValue((await lstat(filename)).size <= 8 * 1024 * 1024, 'Release metadata exceeds 8 MiB: ' + name);
  return JSON.parse(await readFile(filename, 'utf8'));
}
async function digest(filename) {
  const hash = createHash('sha256');
  for await (const block of createReadStream(filename)) hash.update(block);
  return hash.digest('hex');
}
function packageList(text) {
  const result = [];
  const seen = new Set();
  for (const line of text.trim().split('\n')) {
    const parsed = /^([a-z0-9][a-z0-9+_.-]*(?::[a-z0-9-]+)?)=([A-Za-z0-9._+~:-]+)$/.exec(line);
    requireValue(parsed && !seen.has(parsed[1]), 'Invalid or duplicate package pin: ' + line);
    seen.add(parsed[1]); result.push({ name: parsed[1], version: parsed[2] });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

export async function inspectRelease(directory) {
  const root = path.resolve(directory);
  requireValue((await lstat(root)).isDirectory(), 'Release root is not a directory');
  const sumsFile = await file(root, 'SHA256SUMS');
  requireValue((await lstat(sumsFile)).size <= 65536, 'Artifact checksum list exceeds 64 KiB');
  const entries = [];
  const seen = new Set();
  for (const line of (await readFile(sumsFile, 'utf8')).trim().split('\n')) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9._-]+)$/.exec(line);
    requireValue(match && !seen.has(match[2]), 'Invalid or duplicate checksum line');
    seen.add(match[2]);
    const filename = await file(root, match[2]);
    requireValue(await digest(filename) === match[1], 'Artifact checksum mismatch: ' + match[2]);
    entries.push({ name: match[2], sha256: match[1], bytes: (await lstat(filename)).size });
  }
  const live = seen.has('live-manifest.json');
  requireValue(live !== seen.has('manifest.json'), 'Expected exactly one runtime or Live manifest');
  const manifest = await json(root, live ? 'live-manifest.json' : 'manifest.json');
  const source = live ? manifest.sourceRevision : manifest.revision;
  const dirty = live ? manifest.sourceDirty : manifest.dirty;
  requireValue(revision.test(source) && typeof dirty === 'boolean', 'Missing source revision or explicit dirty state');
  requireValue(typeof manifest.version === 'string' && /^\d+\.\d+\.\d+-alpha\.\d+$/.test(manifest.version),
    'Invalid development version');
  requireValue(manifest.architecture === 'x86_64', 'Unsupported release architecture');
  let packages, payloadBytes, files, groups;
  let inputs;
  if (seen.has('build-inputs.json')) {
    inputs = await json(root, 'build-inputs.json');
    requireValue(inputs.schemaVersion === 1 && inputs.revision === source && inputs.dirty === dirty &&
      Array.isArray(inputs.recipes) && Array.isArray(inputs.dependencies), 'Build input provenance differs from manifest');
    for (const item of inputs.recipes)
      requireValue(relative(item.path) && checksum.test(item.sha256), 'Invalid recipe fingerprint');
    for (const item of inputs.dependencies)
      requireValue(typeof item.name === 'string' && revision.test(item.revision) &&
        checksum.test(item.trackedDiffSha256), 'Invalid dependency source fingerprint');
  }
  if (live) {
    requireValue(manifest.stage === 'development-live-image' && manifest.root === 'initramfs, memory only',
      'Unexpected Live artifact contract');
    for (const medium of [manifest.iso, manifest.usb].filter(Boolean)) {
      requireValue(typeof medium.name === 'string' && checksum.test(medium.sha256), 'Invalid boot media identity');
      const actual = entries.find(entry => entry.name === medium.name);
      requireValue(actual && actual.bytes === medium.size && actual.sha256 === medium.sha256, 'Media does not match manifest');
    }
    requireValue(manifest.iso, 'Live image requires optical artifact metadata');
    requireValue(Array.isArray(manifest.packages) && manifest.packages.length > 0, 'Missing Live package inventory');
    packages = manifest.packages.map(entry => {
      requireValue(entry && typeof entry.name === 'string' && entry.name.length > 0 &&
        typeof entry.version === 'string' && entry.version.length > 0, 'Invalid Live package record');
      return { name: entry.name, version: entry.version };
    }).sort((a, b) => a.name.localeCompare(b.name));
    requireValue(new Set(packages.map(pkg => pkg.name)).size === packages.length, 'Duplicate Live package record');
    requireValue(Number.isSafeInteger(manifest.uncompressedPayloadBytes) && manifest.uncompressedPayloadBytes >= 0 &&
      Number.isSafeInteger(manifest.files) && manifest.files > 0, 'Invalid Live payload totals');
    payloadBytes = manifest.uncompressedPayloadBytes; files = manifest.files;
  } else {
    requireValue(manifest.stage === 'development-runtime-bundle' && manifest.bootable === false &&
      Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= 100000,
      'Invalid runtime payload manifest');
    for (const name of ['runtime-packages.txt', 'sbom.spdx.json', 'Containerfile'])
      requireValue(seen.has(name), 'Required artifact is not checksummed: ' + name);
    requireValue(entries.filter(entry => /^pollydesktop-.*-x86_64\.tar\.gz$/.test(entry.name)).length === 1,
      'Runtime requires one checksummed archive');
    const payloadNames = new Set(); payloadBytes = 0; groups = {};
    for (const entry of manifest.files) {
      requireValue(entry && relative(entry.path) && !payloadNames.has(entry.path) && checksum.test(entry.sha256) &&
        Number.isSafeInteger(entry.size) && entry.size >= 0 && ['0644', '0755'].includes(entry.mode),
        'Invalid or duplicate runtime payload entry');
      payloadNames.add(entry.path);
      const filename = await file(root, 'rootfs/' + entry.path);
      requireValue((await lstat(filename)).size === entry.size && await digest(filename) === entry.sha256,
        'Payload differs from manifest: ' + entry.path);
      payloadBytes += entry.size;
      const group = entry.path.split('/').slice(0, 2).join('/');
      groups[group] = (groups[group] || 0) + entry.size;
    }
    requireValue(Number.isSafeInteger(payloadBytes), 'Payload total overflow');
    files = manifest.files.length;
    const packageFile = await file(root, 'runtime-packages.txt');
    requireValue((await lstat(packageFile)).size <= 1024 * 1024, 'Package list exceeds 1 MiB');
    packages = packageList(await readFile(packageFile, 'utf8'));
    const sbom = await json(root, 'sbom.spdx.json');
    requireValue(sbom.spdxVersion === 'SPDX-2.3' && Array.isArray(sbom.packages), 'Missing SPDX package inventory');
    const listed = new Set(sbom.packages.map(pkg => pkg.name + '=' + pkg.versionInfo));
    requireValue(packages.every(pkg => listed.has(pkg.name + '=' + pkg.version)), 'SBOM omits pinned runtime packages');
  }
  return { schemaVersion: 1, kind: live ? 'live' : 'runtime', version: manifest.version,
    distribution: manifest.distribution || (manifest.debian ? 'debian13' : 'alpine3.24'),
    architecture: manifest.architecture, source: { revision: source, dirty },
    artifacts: entries, packages, payload: { bytes: payloadBytes, files, ...(groups ? { groups } : {}) },
    ...(inputs ? { buildInputs: inputs } : {}),
    ...(live ? { minimumGuestMemoryMiB: manifest.minimumGuestMemoryMiB, runtimeImage: manifest.runtimeImage } : {}),
    limits: [
      'Local integrity/provenance report, not a trusted signature or automatic release approval.',
      'Runtime archive extraction metadata must also pass package-modes.py; no files are extracted here.',
      'Hardware acceptance, sanitizer results, package-source availability and redistribution compliance are separate gates.',
    ] };
}

export function compareReleases(previous, candidate) {
  requireValue(previous.kind === candidate.kind && previous.architecture === candidate.architecture,
    'Only same-kind and same-architecture release inventories can be compared');
  const old = new Map(previous.packages.map(pkg => [pkg.name, pkg.version]));
  const next = new Map(candidate.packages.map(pkg => [pkg.name, pkg.version]));
  const added = candidate.packages.filter(pkg => !old.has(pkg.name));
  const removed = previous.packages.filter(pkg => !next.has(pkg.name));
  const changed = candidate.packages.filter(pkg => old.has(pkg.name) && old.get(pkg.name) !== pkg.version)
    .map(pkg => ({ name: pkg.name, previous: old.get(pkg.name), candidate: pkg.version }));
  let buildInputs;
  if (previous.buildInputs && candidate.buildInputs) {
    const recipes = new Map(previous.buildInputs.recipes.map(item => [item.path, item.sha256]));
    const nextRecipes = new Map(candidate.buildInputs.recipes.map(item => [item.path, item.sha256]));
    buildInputs = {
      changedRecipes: [...new Set([...recipes.keys(), ...nextRecipes.keys()])].sort()
        .filter(name => recipes.get(name) !== nextRecipes.get(name))
        .map(name => ({ path: name, previous: recipes.get(name) ?? null, candidate: nextRecipes.get(name) ?? null })),
      dependenciesChanged: JSON.stringify(previous.buildInputs.dependencies) !== JSON.stringify(candidate.buildInputs.dependencies),
      configurationChanged: JSON.stringify(previous.buildInputs.configuration) !== JSON.stringify(candidate.buildInputs.configuration),
    };
  }
  const artifactSizes = release => new Map(release.artifacts.filter(item => /\.(iso|img|tar\.gz)$/.test(item.name))
    .map(item => [item.name.endsWith('.tar.gz') ? 'runtime-archive' : item.name.endsWith('.iso') ? 'iso' : 'usb', item.bytes]));
  const oldSizes = artifactSizes(previous), newSizes = artifactSizes(candidate);
  const artifacts = [...new Set([...oldSizes.keys(), ...newSizes.keys()])].sort().map(kind => ({
    kind, previousBytes: oldSizes.get(kind) ?? null, candidateBytes: newSizes.get(kind) ?? null,
    deltaBytes: oldSizes.has(kind) && newSizes.has(kind) ? newSizes.get(kind) - oldSizes.get(kind) : null,
  }));
  return { schemaVersion: 1, previous: { version: previous.version, distribution: previous.distribution, source: previous.source },
    candidate: { version: candidate.version, distribution: candidate.distribution, source: candidate.source },
    sameDistribution: previous.distribution === candidate.distribution,
    payloadBytesDelta: candidate.payload.bytes - previous.payload.bytes,
    artifacts,
    packages: { added, removed, changed },
    ...(buildInputs ? { buildInputs } : {}),
    limits: 'Version changes are not automatically upgrades or security fixes. Cross-distro names are not equivalent features.' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    requireValue(args.length === 1 || (args.length === 3 && args[1] === '--compare'),
      'Usage: node desktop/tools/release-report.mjs CANDIDATE_DIRECTORY [--compare BASELINE_DIRECTORY]');
    const candidate = await inspectRelease(args[0]);
    const comparison = args.length === 3 ? compareReleases(await inspectRelease(args[2]), candidate) : undefined;
    console.log(JSON.stringify({ ...candidate, ...(comparison ? { comparison } : {}) }, null, 2));
  } catch (error) {
    console.error('[release-report] ' + String(error));
    process.exitCode = 1;
  }
}
