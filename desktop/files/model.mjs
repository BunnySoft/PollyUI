import { utf8Bytes } from './desktop/shell/documents.mjs';

export const FILE_SYSTEM_VERSION = 1;

export function pathValue(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0') ||
      utf8Bytes(value) > 4095 || (value !== '/' && value.split('/').slice(1).some(part =>
        !part || part === '.' || part === '..' || utf8Bytes(part) > 255)))
    throw new Error('Use an absolute local path without empty, dot or parent components (4095 UTF-8 bytes maximum)');
  return value;
}

export function childPath(parent, name) {
  pathValue(parent);
  if (typeof name !== 'string' || !name || name.includes('/') || name.includes('\0') ||
      name === '.' || name === '..' || utf8Bytes(name) > 255)
    throw new Error('Name must be one local filename component (1-255 UTF-8 bytes), not "." or ".."');
  return pathValue((parent === '/' ? '' : parent) + '/' + name);
}

export function parentPath(path) {
  pathValue(path);
  return path.slice(0, path.lastIndexOf('/')) || '/';
}

export function requireFileSystem(native) {
  const api = native?.fileSystem;
  if (api?.version !== FILE_SYSTEM_VERSION || api.implementation !== 'posix-ordinary-v1' ||
      api.maxEntries !== 1024 || api.maxTextBytes !== 1048576 || api.overwrite !== true ||
      api.textObservation !== 'sha256-v1' ||
      ['locations', 'listDirectory', 'stat', 'readText', 'observeText', 'writeText', 'replaceText', 'createDirectory', 'rename']
        .some(name => typeof api[name] !== 'function'))
    throw new Error('Files requires the ordinary-user native fileSystem v1 API; this engine is missing or incompatible');
  return api;
}

export function fileEntry(value) {
  if (!value || typeof value !== 'object' || !['directory', 'file', 'symlink', 'other'].includes(value.type) ||
      typeof value.identity !== 'string' || !value.identity || value.identity.length >= 256 ||
      typeof value.name !== 'string' || typeof value.permissions !== 'string' ||
      !/^[0-7]{4}$/.test(value.permissions) || !Number.isFinite(value.bytes) || value.bytes < 0 ||
      !Number.isFinite(value.mtimeMs) || !Number.isInteger(value.uid) || !Number.isInteger(value.gid) ||
      typeof value.readable !== 'boolean' || typeof value.writable !== 'boolean')
    throw new Error('Invalid native file observation');
  pathValue(value.path);
  if (value.type === 'symlink' && (typeof value.linkTarget !== 'string' ||
      typeof value.targetType !== 'string' || typeof value.targetIdentity !== 'string'))
    throw new Error('Invalid native symbolic-link observation');
  return Object.freeze({ ...value });
}

export function directorySnapshot(value) {
  if (!value || value.version !== 1 || typeof value.identity !== 'string' || !value.identity ||
      value.identity.length >= 192 || typeof value.complete !== 'boolean' ||
      !Array.isArray(value.entries) || value.entries.length > 1024)
    throw new Error('Invalid native directory snapshot');
  pathValue(value.path);
  const seen = new Set();
  const entries = value.entries.map(fileEntry);
  for (const entry of entries) {
    if (entry.path !== childPath(value.path, entry.name) || seen.has(entry.path))
      throw new Error('Directory snapshot contains duplicate or unrelated entries');
    seen.add(entry.path);
  }
  entries.sort((a, b) => (a.type === 'directory' ? 0 : 1) - (b.type === 'directory' ? 0 : 1) ||
    a.name.localeCompare(b.name));
  return Object.freeze({ ...value, entries: Object.freeze(entries) });
}

export function textObservation(value) {
  const entry = fileEntry(value);
  if (entry.type !== 'file' || entry.bytes > 1048576 || typeof entry.metadataIdentity !== 'string' ||
      !entry.metadataIdentity || entry.metadataIdentity.length >= 192 ||
      !entry.identity.startsWith('sha256:' + entry.metadataIdentity + ':') ||
      !/^[0-9a-f]{64}$/.test(entry.identity.slice(('sha256:' + entry.metadataIdentity + ':').length)))
    throw new Error('Overwrite requires a bounded native text observation with exact SHA256 content identity');
  return entry;
}

export function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KiB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MiB';
}

export function fileError(error) {
  return (error?.code ? error.code + ': ' : '') + String(error?.message ?? error);
}
