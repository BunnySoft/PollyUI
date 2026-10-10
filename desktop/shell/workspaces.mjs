function utf8Bytes(value) {
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code >= 0xd800 && code <= 0xdfff) throw new TypeError('Workspace preferences must be valid Unicode');
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

export function workspaceName(value) {
  if (typeof value !== 'string' || !value.length || value.includes('\0'))
    throw new TypeError('Workspace names must be nonempty strings without NUL');
  if (utf8Bytes(value) > 128) throw new RangeError('Workspace names must fit in 128 UTF-8 bytes');
  return value;
}

export function readWorkspacePreferences(text) {
  if (typeof text !== 'string' || text.length > 1024 * 1024 || utf8Bytes(text) > 1024 * 1024)
    throw new RangeError('Workspace preferences exceed the 1 MiB limit');
  const value = JSON.parse(text);
  return validateWorkspacePreferences(value);
}
export function validateWorkspacePreferences(value) {
  if (utf8Bytes(JSON.stringify(value)) > 1024 * 1024)
    throw new RangeError('Workspace preferences exceed the 1 MiB limit');
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'active,names,version' ||
      value.version !== 1 || !Array.isArray(value.names) || !value.names.length ||
      !Number.isInteger(value.active) || value.active < 0 || value.active >= value.names.length)
    throw new TypeError('Invalid workspace preferences');
  return { version: 1, names: value.names.map(workspaceName), active: value.active };
}

export function workspacePreferences(workspaces) {
  const ordered = [...workspaces].sort((a, b) => a.order - b.order);
  if (ordered.filter(workspace => workspace.active).length !== 1)
    throw new Error('Workspace snapshot must have exactly one active workspace');
  return validateWorkspacePreferences({ version: 1,
    names: ordered.map(workspace => workspace.name),
    active: ordered.findIndex(workspace => workspace.active) });
}

export function createWorkspacePersistence({ native, configuration, failure }) {
  let enabled = false, saved = null;
  function sync(workspaces) {
    if (!enabled) return;
    try {
      const preferences = workspacePreferences(workspaces), text = JSON.stringify(preferences);
      if (text !== saved) {
        try { configuration.update({ workspace: preferences }); }
        catch (error) { if (error.committed) saved = text; throw error; }
        saved = text;
      }
    } catch (error) { failure(error); }
  }
  return {
    start() {
      if (typeof native?.restoreWorkspaces !== 'function') return;
      enabled = false;
      try {
        const preferences = configuration.snapshot.workspace;
        if (preferences !== null) {
          native.restoreWorkspaces(preferences.names, preferences.active);
        }
        enabled = true;
        sync(native.workspaces());
      } catch (error) { failure(error); }
    },
    sync,
    saveCurrent() {
      const preferences = workspacePreferences(native.workspaces());
      try { configuration.update({ workspace: preferences }); }
      catch (error) {
        if (error.committed) { enabled = true; saved = JSON.stringify(preferences); }
        throw error;
      }
      enabled = true; saved = JSON.stringify(preferences);
    },
  };
}
