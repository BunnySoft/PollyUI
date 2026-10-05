import { parseThemeFile, applyThemeOverrides } from './desktop/shell/theme-schema.mjs';

const connections = new WeakMap();

export function subscribeDesktopTheme(onChange, {
  native = typeof desktop === 'undefined' ? null : desktop,
  overrides = {},
  onError = error => console.error('[theme] ' + String(error)),
} = {}) {
  if (typeof onChange !== 'function' || typeof onError !== 'function')
    throw new TypeError('Theme subscription requires callbacks');
  if (typeof native?.startThemeSubscription !== 'function')
    throw new TypeError('Desktop theme subscription requires the native --desktop API');
  let local = JSON.parse(JSON.stringify(overrides));
  let entry = connections.get(native);
  if (!entry) {
    const owns = !native.desktopThemeState().available;
    native.startThemeSubscription();
    entry = { owns, previous: native.onDesktopThemeChanged, listeners: new Set() };
    entry.read = () => {
      const snapshot = native.desktopThemeState();
      if (snapshot.error) throw new Error(snapshot.error);
      return { ...snapshot, theme: snapshot.ready ? parseThemeFile(snapshot.document) : null };
    };
    entry.changed = () => {
      let snapshot;
      try { snapshot = entry.read(); }
      catch (error) {
        for (const listener of [...entry.listeners]) listener.fail(error);
        if (typeof entry.previous === 'function') entry.previous();
        return;
      }
      for (const listener of [...entry.listeners]) {
        try { listener.deliver(snapshot); } catch (error) { listener.fail(error); }
      }
      if (typeof entry.previous === 'function') entry.previous();
    };
    native.onDesktopThemeChanged = entry.changed;
    connections.set(native, entry);
  }
  let stopped = false, lastDocument, lastRevision;
  let state = Object.freeze({ available: false, ready: false, revision: 0, theme: null, error: '' });
  const listener = {
    fail(error) {
      state = Object.freeze({ ...state, error: String(error) });
      onError(error);
    },
    deliver(snapshot, force = false) {
      if (stopped || (!force && snapshot.revision === lastRevision && snapshot.document === lastDocument)) return;
      const theme = snapshot.theme ? applyThemeOverrides(
        { schemaVersion: 1, default: snapshot.theme.id, themes: [snapshot.theme] },
        JSON.stringify({ schemaVersion: 1, themes: { [snapshot.theme.id]: local } })).themes[0] : null;
      state = Object.freeze({ available: snapshot.available, ready: !!theme, revision: snapshot.revision,
        theme, error: '' });
      lastDocument = snapshot.document; lastRevision = snapshot.revision;
      onChange(state);
    },
  };
  function stop() {
    if (stopped) return;
    stopped = true;
    entry.listeners.delete(listener);
    if (!entry.listeners.size) {
      if (native.onDesktopThemeChanged === entry.changed) native.onDesktopThemeChanged = entry.previous;
      if (entry.owns) native.stopThemeSubscription();
      connections.delete(native);
    }
  }
  entry.listeners.add(listener);
  try { listener.deliver(entry.read()); } catch (error) { stop(); throw error; }
  return {
    stop,
    getState: () => state,
    setOverrides(value) {
      if (stopped) throw new Error('Theme subscription is stopped');
      const previous = local;
      local = JSON.parse(JSON.stringify(value));
      try { listener.deliver(entry.read(), true); }
      catch (error) { local = previous; throw error; }
    },
  };
}
