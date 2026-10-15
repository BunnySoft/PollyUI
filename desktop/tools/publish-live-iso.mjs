import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  if (typeof iso?.name !== 'string' || /[/\\]/.test(iso.name) || !iso.name.endsWith('.iso') ||
      checksums.get(iso.name.toLowerCase())?.sha !== iso.sha256 ||
      !Number.isSafeInteger(iso.size) || iso.size <= 0 || regular(path.join(directory, iso.name)).size !== iso.size)
    throw new Error('Actual ISO does not match the Live manifest');
  for (const revision of [manifest.sourceRevision, origin.runtimeSourceRevision, origin.mediaProducerRevision])
    if (typeof revision !== 'string' || !/^[0-9a-f]{40}$/.test(revision)) throw new Error('Missing full source revision');
  if (manifest.sourceDirty !== false || origin.runtimeSourceDirty !== false ||
      origin.isoSha256 !== iso.sha256 || origin.mediaProducerRevision !== manifest.sourceRevision ||
      origin.runtimeImageID !== manifest.runtimeImage ||
      !Number.isSafeInteger(origin.isoPayloadFilesVerified) || origin.isoPayloadFilesVerified <= 0 ||
      manifest.root !== 'initramfs, memory only' || manifest.architecture !== 'x86_64')
    throw new Error('ISO payload/source verification receipt does not match this clean Live bundle');
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
export function publish(directory, destination = DEFAULT_DESTINATION) {
  if (process.platform !== 'win32' && destination === DEFAULT_DESTINATION)
    throw new Error('The default is a Windows path; non-Windows hosts must pass --destination');
  directory = fs.realpathSync(directory);
  destination = path.resolve(destination);
  const { manifest, origin, checksums } = verifyBundle(directory);
  const relative = path.relative(directory, destination);
  if (!relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
    throw new Error('Publication destination must not be inside its source bundle');
  fs.mkdirSync(destination, { recursive: true });
  const alias = path.join(destination, ALIAS);
  const aliasInfo = fs.lstatSync(alias, { throwIfNoEntry: false });
  if (aliasInfo && !aliasInfo.isFile())
    throw new Error('Refusing to replace a non-regular ISO alias');
  const release = path.join(destination, `pollydesktop-${manifest.version}-${manifest.distribution}-` +
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
    bytes: regular(iso).size, sha256: manifest.iso.sha256,
    runtimeSourceRevision: origin.runtimeSourceRevision, mediaProducerRevision: manifest.sourceRevision,
    runtimeImageID: manifest.runtimeImage, isoFileIdentity: identity(iso), aliasFileIdentity: identity(alias),
    limits: ['Integrity and hard-link publication only; not UEFI/Hyper-V or physical acceptance.',
      'An already-open optical handle may still refer to the previous ISO inode.'],
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 1 && !(args.length === 3 && args[1] === '--destination'))
    throw new Error('Usage: node publish-live-iso.mjs VERIFIED_MEDIA [--destination DIRECTORY]');
  console.log(JSON.stringify(publish(args[0], args[2]), null, 2));
}
