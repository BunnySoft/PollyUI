import { pathValue, childPath, parentPath, fileEntry, directorySnapshot, fileError } from './desktop/files/model.mjs';

const immutable = value => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
};
const copy = value => JSON.parse(JSON.stringify(value));
const failure = (code, message) => Object.assign(new Error(message), { code });
const same = (left, right) => left.path === right.path && left.identity === right.identity;

function options(value) {
  const allowed = ['mode', 'initialDirectory', 'suggestedName', 'defaultExtension', 'filters'];
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key)))
    throw new TypeError('Unknown file dialog option');
  const { mode = 'open', initialDirectory = null, suggestedName = '', defaultExtension = '',
    filters = [{ label: 'All files', extensions: [] }] } = value;
  if (!['open', 'save'].includes(mode)) throw new TypeError('File dialog mode must be open or save');
  if (initialDirectory !== null) pathValue(initialDirectory);
  if (typeof suggestedName !== 'string') throw new TypeError('suggestedName must be text');
  if (suggestedName) childPath('/', suggestedName);
  if (typeof defaultExtension !== 'string' || (defaultExtension && !/^[a-z0-9]{1,16}$/i.test(defaultExtension)))
    throw new TypeError('defaultExtension must be an extension without a dot');
  if (!Array.isArray(filters) || !filters.length || filters.length > 8)
    throw new TypeError('File dialog requires 1-8 extension filters');
  const normalized = filters.map(filter => {
    if (!filter || typeof filter !== 'object' || Object.keys(filter).some(key => !['label', 'extensions'].includes(key)) ||
        typeof filter.label !== 'string' || !filter.label || filter.label.length > 80 ||
        !Array.isArray(filter.extensions) || filter.extensions.length > 16 ||
        filter.extensions.some(extension => typeof extension !== 'string' || !/^[a-z0-9]{1,16}$/i.test(extension)))
      throw new TypeError('Invalid extension filter');
    return { label: filter.label, extensions: [...new Set(filter.extensions.map(extension => extension.toLowerCase()))] };
  });
  return immutable({ mode, initialDirectory, suggestedName, defaultExtension, filters: normalized });
}

const entry = value => copy(fileEntry(value));

export function createFileDialogController({ files = null, settings = {}, onChange = () => {},
  onFinish = () => {}, reportError = message => console.error('[file-dialog] ' + message),
  initialError = '' } = {}) {
  const config = options(settings);
  let disposed = false, revision = 0;
  let state = immutable({ phase: files ? 'idle' : 'unavailable', revision,
    mode: config.mode, filters: config.filters, filterIndex: 0, locations: null,
    directory: null, entries: [], complete: true, selection: null, name: config.suggestedName,
    error: initialError || (files ? '' : 'Native ordinary-user filesystem API is unavailable.'),
    confirmation: null });
  if (files && (files.version !== 1 || files.implementation !== 'posix-ordinary-v1' ||
      !['locations', 'listDirectory', 'stat'].every(key => typeof files[key] === 'function')))
    throw new TypeError('File dialog requires the shared ordinary-user fileSystem version 1');

  const active = expected => !disposed && state.phase !== 'finished' &&
    (expected === undefined || expected === state.revision);
  function publish(patch) {
    state = immutable({ ...state, ...patch, revision: ++revision });
    onChange(state);
    return revision;
  }
  function error(value, patch = {}) {
    const message = fileError(value);
    reportError(message);
    publish({ phase: state.directory ? 'ready' : 'error', error: message, confirmation: null, ...patch });
  }
  const pending = token => active(token);
  function matches(name) {
    const extensions = config.filters[state.filterIndex].extensions;
    return !extensions.length || extensions.some(extension => name.toLowerCase().endsWith('.' + extension));
  }
  function finish(result) {
    if (!active()) return;
    publish({ phase: 'finished', selection: null, confirmation: null, error: '' });
    onFinish(immutable(result));
  }
  async function navigate(path, expected) {
    if (!active(expected) || !files) return;
    const token = publish({ phase: 'loading', selection: null, confirmation: null, error: '' });
    try {
      const reply = directorySnapshot(await files.listDirectory(pathValue(path)));
      if (!pending(token)) return;
      publish({ phase: 'ready', directory: { path: reply.path, identity: reply.identity },
        entries: copy(reply.entries), complete: reply.complete, selection: null, confirmation: null });
    } catch (value) {
      if (pending(token)) error(value, { entries: [], selection: null });
      else reportError('Discarded directory request: ' + fileError(value));
    }
  }
  function visibleEntries() {
    return state.entries.filter(item => item.type === 'directory' ||
      (item.type === 'symlink' && item.targetType === 'directory') || matches(item.name));
  }
  function select(path, expected) {
    if (!active(expected) || !state.directory || state.phase === 'loading') return;
    const selected = visibleEntries().find(item => item.path === path);
    if (!selected || !['file', 'directory', 'symlink'].includes(selected.type)) return;
    publish({ phase: 'ready', selection: selected, confirmation: null, error: '',
      ...(config.mode === 'save' && selected.type === 'file' ? { name: selected.name } : {}) });
  }
  async function selectedTarget(selected, token) {
    const observed = entry(await files.stat(selected.path, false));
    if (!pending(token)) return null;
    if (!same(observed, selected)) throw failure('ESTALE', 'Selected entry changed. Refresh and select again.');
    if (observed.type !== 'symlink') return observed;
    const target = entry(await files.stat(selected.path, true));
    if (!pending(token)) return null;
    if (target.identity !== selected.targetIdentity || target.type !== selected.targetType)
      throw failure('ESTALE', 'Link target changed. Refresh and select the marked link again.');
    const linkNow = entry(await files.stat(selected.path, false));
    if (!same(linkNow, selected)) throw failure('ESTALE', 'Selected link changed. Refresh and select again.');
    return target;
  }
  async function openSelection(expected) {
    if (!active(expected) || !files || !state.selection || state.phase !== 'ready') return;
    const selected = state.selection, token = publish({ phase: 'validating', error: '', confirmation: null });
    try {
      const observed = await selectedTarget(selected, token);
      if (!pending(token)) return;
      if (observed.type === 'directory') return navigate(observed.path, token);
      if (observed.type !== 'file' || !observed.readable)
        throw failure('EACCES', 'Choose an existing readable regular file.');
      if (!matches(selected.name)) throw failure('EINVAL', 'Selected file does not match this filter.');
      finish({ status: 'selected', mode: 'open', path: observed.path, identity: observed.identity,
        selectedPath: selected.path });
    } catch (value) {
      if (pending(token)) error(value, { selection: null });
      else reportError('Discarded selection request: ' + fileError(value));
    }
  }
  function setName(name, expected) {
    if (!active(expected) || typeof name !== 'string') return;
    publish({ phase: state.directory ? 'ready' : state.phase, name, selection: null,
      confirmation: null, error: '' });
  }
  function setFilter(index, expected) {
    if (!active(expected) || !Number.isInteger(index) || !config.filters[index]) return;
    publish({ phase: state.directory ? 'ready' : state.phase, filterIndex: index,
      selection: null, confirmation: null, error: '' });
  }
  async function saveSelection(expected) {
    if (!active(expected) || !files || !state.directory || state.phase !== 'ready') return;
    const directory = state.directory;
    let name = state.name;
    const token = publish({ phase: 'validating', error: '', confirmation: null });
    try {
      if (config.defaultExtension && name && !name.includes('.')) name += '.' + config.defaultExtension;
      const path = childPath(directory.path, name);
      if (!matches(name)) throw failure('EINVAL', 'Filename does not match the selected extension filter.');
      const parent = entry(await files.stat(directory.path, false));
      if (!pending(token)) return;
      if (!same(parent, directory)) throw failure('ESTALE', 'Destination directory changed. Refresh before saving.');
      if (parent.type !== 'directory' || !parent.writable)
        throw failure('EACCES', 'Destination must be an existing writable directory.');
      let target;
      try { target = entry(await files.stat(path, false)); }
      catch (value) { if (value.code !== 'ENOENT') throw value; }
      if (!pending(token)) return;
      if (target) {
        if (target.type !== 'file') throw failure('EEXIST', 'This name belongs to a directory, link or non-regular file.');
        if (files.overwrite !== true || typeof files.replaceText !== 'function')
          throw failure('EEXIST', 'This file already exists. Conditional replacement is unavailable; choose a new name.');
        if (!target.writable) throw failure('EACCES', 'Existing file is not writable.');
        publish({ phase: 'overwrite', name, confirmation: { path, name, parent, target }, error: '' });
        return;
      }
      finish({ status: 'selected', mode: 'save', path, parentPath: parent.path,
        parentIdentity: parent.identity, name, expectedIdentity: null, overwrite: false });
    } catch (value) {
      if (pending(token)) error(value);
      else reportError('Discarded save-target request: ' + fileError(value));
    }
  }
  async function confirmOverwrite(expected) {
    if (!active(expected) || state.phase !== 'overwrite' || !state.confirmation || !files.overwrite) return;
    const confirmation = state.confirmation;
    const token = publish({ phase: 'validating', error: '' });
    try {
      const parent = entry(await files.stat(confirmation.parent.path, false));
      if (!pending(token)) return;
      const target = entry(await files.stat(confirmation.path, false));
      if (!pending(token)) return;
      if (parent.path !== confirmation.parent.path || parent.type !== 'directory' || !parent.writable)
        throw failure('ESTALE', 'Destination directory changed. Refresh before saving.');
      if (target.type !== 'file' || !target.writable)
        throw failure('ESTALE', 'Destination is no longer a writable regular file.');
      if (!same(parent, confirmation.parent) || !same(target, confirmation.target)) {
        publish({ phase: 'overwrite', directory: { path: parent.path, identity: parent.identity },
          confirmation: { ...confirmation, parent, target },
          error: 'File or directory changed after the last question. Review and explicitly confirm again.' });
        return;
      }
      finish({ status: 'selected', mode: 'save', path: target.path, parentPath: parent.path,
        parentIdentity: parent.identity, name: confirmation.name, expectedIdentity: target.identity,
        overwrite: true });
    } catch (value) {
      if (pending(token)) error(value);
      else reportError('Discarded replacement request: ' + fileError(value));
    }
  }
  return {
    getState: () => state, visibleEntries,
    async start() {
      if (!active() || !files || state.phase !== 'idle') return;
      const token = publish({ phase: 'loading', error: '' });
      try {
        const locations = await files.locations();
        if (!pending(token)) return;
        if (!locations || typeof locations !== 'object') throw failure('INVALID_REPLY', 'Invalid home locations');
        for (const path of Object.values(locations)) pathValue(path);
        if (!locations.home) throw failure('INVALID_REPLY', 'Filesystem did not provide a home directory');
        publish({ locations: copy(locations) });
        await navigate(config.initialDirectory || locations.home);
      } catch (value) {
        if (pending(token)) error(value);
        else reportError('Discarded home-location request: ' + fileError(value));
      }
    },
    navigate, select, setName, setFilter, openSelection, saveSelection, confirmOverwrite,
    up(expected) { if (active(expected) && state.directory) return navigate(parentPath(state.directory.path), expected); },
    activate(expected) {
      return config.mode === 'open' || state.selection?.type === 'directory' ||
        (state.selection?.type === 'symlink' && state.selection.targetType === 'directory') ?
        openSelection(expected) : saveSelection(expected);
    },
    dismissOverwrite(expected) {
      if (active(expected) && state.phase === 'overwrite')
        publish({ phase: 'ready', confirmation: null, error: '' });
    },
    cancel(reason = 'cancelled', expected) { if (active(expected)) finish({ status: 'cancelled', reason }); },
    dispose() {
      if (disposed) return;
      if (active()) finish({ status: 'cancelled', reason: 'disposed' });
      disposed = true;
    },
  };
}
