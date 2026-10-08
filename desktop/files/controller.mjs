import { pathValue, childPath, parentPath, directorySnapshot, fileEntry, fileError } from './desktop/files/model.mjs';

export function createFilesController({ api, launcher = null, onChange = () => {},
  reportError = message => console.error('[files] ' + message) } = {}) {
  let disposed = false, serial = 0, history = [], position = -1;
  let state = { phase: 'idle', generation: 0, path: '', snapshot: null, selection: null,
    locations: null, error: '', message: '', dialog: null, openWith: null, page: 0,
    applications: [], applicationError: '', canBack: false, canForward: false };
  function update(fields) {
    if (disposed) return;
    state = { ...state, ...fields, canBack: position > 0, canForward: position < history.length - 1 };
    onChange();
  }
  function failure(error) {
    const message = fileError(error);
    reportError(message); update({ phase: 'error', error: message, dialog: null, openWith: null });
    return false;
  }
  const valid = generation => !disposed && generation === state.generation;
  function selected(generation, identity) {
    if (!valid(generation) || state.phase !== 'ready' || !state.selection ||
        state.selection.identity !== identity) return null;
    return state.selection;
  }
  function observed(entry) {
    const fresh = fileEntry(api.stat(entry.path, false));
    if (fresh.identity !== entry.identity) throw new Error('Selected entry changed. Refresh and select it again.');
    return fresh;
  }
  async function navigate(path, { expectedIdentity = null, targetPosition = null, refresh = false } = {}) {
    if (disposed) return false;
    const request = ++serial;
    update({ phase: 'loading', generation: state.generation + 1, path, snapshot: null,
      selection: null, dialog: null, openWith: null, error: '', message: '', page: 0 });
    try {
      pathValue(path);
      // Native v1 is synchronous; awaiting also permits explicitly injected test providers.
      const snapshot = directorySnapshot(await api.listDirectory(path, expectedIdentity));
      if (disposed || request !== serial) return false;
      if (targetPosition !== null) position = targetPosition;
      else if (!refresh) {
        history = history.slice(0, position + 1);
        if (history.at(-1) !== snapshot.path) history.push(snapshot.path);
        position = history.length - 1;
      }
      update({ phase: 'ready', path: snapshot.path, snapshot, error: '' });
      return true;
    } catch (error) {
      if (!disposed && request === serial) return failure(error);
      return false;
    }
  }
  const controller = {
    getState: () => state,
    async start(path = null) {
      if (disposed) return false;
      if (!api) return failure(new Error('Native ordinary-user file API is unavailable'));
      try {
        const locations = api.locations();
        for (const key of ['home', 'documents', 'downloads', 'desktop']) pathValue(locations[key]);
        update({ locations: Object.freeze({ ...locations }) });
        if (launcher) {
          try { update({ applications: launcher.refresh(), applicationError: '' }); }
          catch (error) {
            const message = fileError(error); reportError(message);
            update({ applicationError: 'Applications catalog: ' + message });
          }
        }
        return navigate(path ?? locations.home);
      } catch (error) { return failure(error); }
    },
    navigate,
    refresh(generation = state.generation) {
      if (!valid(generation) || !state.path) return false;
      return navigate(state.path, { refresh: true });
    },
    back(generation = state.generation) {
      if (!valid(generation) || position <= 0) return false;
      return navigate(history[position - 1], { targetPosition: position - 1 });
    },
    forward(generation = state.generation) {
      if (!valid(generation) || position >= history.length - 1) return false;
      return navigate(history[position + 1], { targetPosition: position + 1 });
    },
    parent(generation = state.generation) {
      if (!valid(generation) || !state.path || state.path === '/') return false;
      return navigate(parentPath(state.path));
    },
    select(path, identity, generation = state.generation) {
      if (!valid(generation) || state.phase !== 'ready') return false;
      const entry = state.snapshot.entries.find(item => item.path === path && item.identity === identity);
      if (!entry) return false;
      update({ selection: entry, dialog: null, openWith: null, error: '', message: '' });
      return true;
    },
    async open(generation = state.generation, identity = state.selection?.identity, followLink = false) {
      let entry = selected(generation, identity);
      let openingRequest = null;
      if (!entry) return false;
      try {
        entry = observed(entry);
        if (entry.type === 'symlink') {
          if (!followLink) {
            update({ dialog: { kind: 'link', entry, name: '', generation } }); return false;
          }
          const target = fileEntry(api.stat(entry.path, true));
          if (target.identity !== entry.targetIdentity)
            throw new Error('Symbolic-link target changed. Refresh and choose the link again.');
          entry = target;
        }
        const managed = state.applications.find(app => app.id.startsWith('bundle:') && app.path === entry.path);
        if (managed) {
          if (!launcher) throw new Error('Managed application launcher is unavailable');
          const request = ++serial;
          openingRequest = request;
          update({ phase: 'opening', dialog: null, openWith: null });
          await launcher.launch(managed.id);
          if (!disposed && request === serial) update({ phase: 'ready', message: 'Launch requested: ' + managed.name });
          return true;
        }
        if (entry.type === 'directory') return navigate(entry.path, { expectedIdentity: entry.identity });
        if (entry.type !== 'file') throw new Error('This entry is not a regular file or folder');
        if (!launcher) throw new Error('Desktop MIME document opening is unavailable in this engine');
        const handlers = launcher.documentApplications(entry.path);
        update({ dialog: null, openWith: { entry, ...handlers } });
        return controller.openWith(handlers.defaultApplication, generation, identity);
      } catch (error) {
        if (disposed || (openingRequest !== null && openingRequest !== serial)) return false;
        const message = 'Open With / open unavailable: ' + fileError(error);
        reportError(message); update({ phase: 'ready', error: message, dialog: null, openWith: null });
        return false;
      }
    },
    showOpenWith(generation = state.generation, identity = state.selection?.identity) {
      const entry = selected(generation, identity);
      if (!entry) return false;
      try {
        observed(entry);
        if (entry.type !== 'file') throw new Error('Open With requires an explicitly selected regular file');
        if (!launcher) throw new Error('Open With is unavailable in this engine');
        update({ openWith: { entry, ...launcher.documentApplications(entry.path) }, dialog: null, error: '' });
        return true;
      } catch (error) {
        const message = 'Open With unavailable: ' + fileError(error);
        reportError(message); update({ error: message, openWith: null }); return false;
      }
    },
    async openWith(id, generation = state.generation, identity = state.selection?.identity) {
      if (!valid(generation) || !state.openWith || !state.selection || state.selection.identity !== identity ||
          !state.openWith.applications.some(app => app.id === id)) return false;
      const request = ++serial, entry = state.openWith.entry;
      try {
        observed(entry);
        update({ phase: 'opening', error: '', dialog: null });
        await launcher.openDocuments([entry.path], id);
        if (disposed || request !== serial) return false;
        update({ phase: 'ready', openWith: null, message: 'Open requested: ' + entry.name });
        return true;
      } catch (error) {
        if (!disposed && request === serial) {
          const message = 'Open With unavailable: ' + fileError(error);
          reportError(message); update({ phase: 'ready', error: message, openWith: null });
        }
        return false;
      }
    },
    beginCreate(generation = state.generation) {
      if (!valid(generation) || state.phase !== 'ready') return false;
      update({ dialog: { kind: 'create', name: '', generation }, openWith: null, error: '' });
      return true;
    },
    beginRename(generation = state.generation, identity = state.selection?.identity) {
      const entry = selected(generation, identity);
      if (!entry) return false;
      if (state.applications.some(app => app.id.startsWith('bundle:') && app.path === entry.path)) {
        update({ error: 'Managed application packages must be changed using the application manager' });
        return false;
      }
      update({ dialog: { kind: 'rename', name: entry.name, entry, generation }, openWith: null, error: '' });
      return true;
    },
    editName(name, generation = state.generation) {
      if (!valid(generation) || !state.dialog || !['create', 'rename'].includes(state.dialog.kind)) return false;
      update({ dialog: { ...state.dialog, name }, error: '' }); return true;
    },
    async confirm(generation = state.generation) {
      if (!valid(generation) || state.phase !== 'ready' || state.dialog?.generation !== generation) return false;
      const dialog = state.dialog, snapshot = state.snapshot;
      if (dialog.kind === 'link') return controller.open(generation, dialog.entry.identity, true);
      const request = ++serial;
      try {
        childPath(snapshot.path, dialog.name);
        if (dialog.kind === 'rename' && (!selected(generation, dialog.entry.identity) ||
            dialog.entry.path !== state.selection.path)) return false;
        update({ phase: 'working', error: '' });
        const entry = fileEntry(await (dialog.kind === 'create' ?
          api.createDirectory(snapshot.path, dialog.name, snapshot.identity) :
          api.rename(dialog.entry.path, dialog.name, dialog.entry.identity, snapshot.identity)));
        if (disposed || request !== serial) return false;
        await navigate(snapshot.path, { refresh: true });
        if (disposed || state.phase !== 'ready') return false;
        controller.select(entry.path, state.snapshot.entries.find(item => item.path === entry.path)?.identity);
        update({ message: (dialog.kind === 'create' ? 'Created folder: ' : 'Renamed to: ') + entry.name });
        return true;
      } catch (error) {
        if (!disposed && request === serial) {
          const message = fileError(error); reportError(message);
          update({ phase: 'ready', error: message, dialog: null, selection: null });
        }
        return false;
      }
    },
    cancel(generation = state.generation) {
      if (!valid(generation)) return false;
      update({ dialog: null, openWith: null, error: '' }); return true;
    },
    page(index, generation = state.generation) {
      if (!valid(generation) || state.phase !== 'ready' || !Number.isInteger(index) || index < 0 ||
          index > Math.max(0, Math.ceil(state.snapshot.entries.length / 64) - 1)) return false;
      update({ page: index }); return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true; serial++;
      state = { ...state, phase: 'disposed', selection: null, snapshot: null, dialog: null, openWith: null };
    },
  };
  return controller;
}
