const PATH_BYTES = 4095, DOCUMENT_LIMIT = 32, URI_BYTES = 8192;

export function utf8Bytes(value) {
  return encodeURIComponent(value).replace(/%[0-9A-F]{2}|./g, 'x').length;
}

export function localDocument(value) {
  if (typeof value !== 'string' || !value || value.includes('\0'))
    throw new Error('Document must be a nonempty local absolute path or file URI without NUL');
  if (value.length > (value.startsWith('file:') ? PATH_BYTES * 3 + 7 : PATH_BYTES))
    throw new Error('Document path/file URI exceeds bounded input size');
  let path = value;
  if (value.startsWith('file:')) {
    if (!value.startsWith('file:///') || /[?#\s\\]/.test(value) || /[^\x21-\x7e]/.test(value))
      throw new Error('Only encoded local file:/// URIs without authority, query or fragment are supported');
    try { path = decodeURIComponent(value.slice(7)); }
    catch { throw new Error('Malformed document file URI'); }
  }
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\0'))
    throw new Error('Document path must be local and absolute without NUL');
  if (utf8Bytes(path) > PATH_BYTES) throw new Error('Document path exceeds 4095 UTF-8 bytes');
  const uri = 'file://' + path.split('/').map(part => encodeURIComponent(part)
    .replace(/[!'()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase())).join('/');
  return { path, uri };
}

export function localDocuments(values, required = false) {
  if (!Array.isArray(values) || values.length > DOCUMENT_LIMIT || (required && !values.length))
    throw new Error('Documents must contain ' + (required ? '1' : '0') + '-32 local paths or file URIs');
  const documents = Array.from(values, localDocument);
  if (documents.reduce((size, item) => size + utf8Bytes(item.uri) + 1, 0) > URI_BYTES)
    throw new Error('Document URIs exceed 8192 UTF-8 bytes');
  return documents;
}

export function mimeType(value) {
  if (typeof value !== 'string' || value.length > 255 ||
      /[\s\0]/.test(value) || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(value))
    throw new Error('Invalid concrete MIME type');
  return value;
}

function desktopId(value) {
  if (value.length > 263 || !value.endsWith('.desktop') ||
      /[\0/\\;\s]/.test(value) || value.length === 8)
    throw new Error('Invalid MIME association desktop ID');
  return value;
}

export function parseMimeApps(file) {
  if (typeof file.contents !== 'string' || file.contents.includes('\0') ||
      utf8Bytes(file.contents) > 1024 * 1024)
    throw new Error('MIME associations must be a bounded text file without NUL');
  const sections = new Map(), seen = new Set();
  let section = '';
  for (const raw of file.contents.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      if (!line.endsWith(']')) throw new Error('Malformed mimeapps group');
      section = line.slice(1, -1);
      if (seen.has(section)) throw new Error('Duplicate mimeapps group');
      seen.add(section);
      sections.set(section, new Map());
      continue;
    }
    if (!['Default Applications', 'Added Associations', 'Removed Associations'].includes(section)) continue;
    const index = line.indexOf('=');
    if (index < 1) throw new Error('Malformed mimeapps key');
    const type = mimeType(line.slice(0, index).trim()), values = sections.get(section);
    if (values.has(type)) throw new Error('Duplicate mimeapps MIME key');
    const list = line.slice(index + 1).trim().split(';');
    if (list.at(-1) === '') list.pop();
    if (list.length > 256 || list.some(id => !id)) throw new Error('Invalid mimeapps application list');
    values.set(type, [...new Set(list.map(desktopId))]);
  }
  for (const [type, added] of sections.get('Added Associations') || []) {
    const removed = sections.get('Removed Associations')?.get(type) || [];
    if (added.some(id => removed.includes(id))) throw new Error('Conflicting added/removed MIME associations');
  }
  return sections;
}

// Files arrive in XDG priority order; directory markers place declared associations
// at their data-directory level rather than after all lower-priority removals.
export function resolveMimeApplications(type, entries, files) {
  mimeType(type);
  if (!Array.isArray(files) || files.length > 128) throw new Error('Invalid MIME association file count');
  const usable = entries.filter(entry => entry.mimeTypes?.includes(type) && !entry.unavailable &&
    (entry.documentField || entry.activation));
  const byId = new Map(usable.map(entry => [entry.id, entry]));
  const blocked = new Set(), associated = new Set(), defaults = [];
  let sourceBytes = 0;
  for (const file of files) {
    if (typeof file.path !== 'string' || !file.path.startsWith('/') ||
        typeof file.directory !== 'string' || (file.directory && !file.directory.startsWith('/')) ||
        typeof file.desktopSpecific !== 'boolean')
      throw new Error('Invalid MIME association source metadata');
    if (typeof file.contents !== 'string' || (sourceBytes += utf8Bytes(file.contents)) > 16 * 1024 * 1024)
      throw new Error('MIME association sources exceed 16 MiB of bounded text');
    const sections = parseMimeApps(file);
    defaults.push(...(sections.get('Default Applications')?.get(type) || []));
    if (file.desktopSpecific) continue;
    for (const id of sections.get('Added Associations')?.get(type) || [])
      if (!blocked.has(id) && byId.has(id)) associated.add(id);
    for (const id of sections.get('Removed Associations')?.get(type) || []) blocked.add(id);
    if (file.directory) {
      for (const entry of usable)
        if (entry.path.startsWith(file.directory + '/') && !blocked.has(entry.id)) associated.add(entry.id);
      for (const entry of entries)
        if (entry.path.startsWith(file.directory + '/')) blocked.add(entry.id);
    }
  }
  const ids = [...associated];
  const id = defaults.find(candidate => associated.has(candidate)) || ids[0];
  if (!id) throw new Error('No available document handler for ' + type);
  return { mimeType: type, defaultApplication: id, applications: ids.map(candidate => byId.get(candidate)) };
}
