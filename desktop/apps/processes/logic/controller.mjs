import { processRows } from './desktop/apps/processes/logic/model.mjs';

export function createProcessController({ provider, changed = () => {}, report = console.error }) {
  let previous = null, closed = false, request = 0;
  let state = { rows: [], loading: false, error: '', complete: true, skipped: 0, updated: null,
    sort: { key: 'memoryBytes', direction: -1 } };
  return Object.freeze({
    getState: () => state,
    async refresh() {
      if (closed || state.loading) return false;
      const scope = ++request;
      state = { ...state, loading: true }; changed();
      try {
        const snapshot = await (typeof provider.snapshotAsync === 'function' ?
          provider.snapshotAsync(() => !closed && scope === request) : provider.snapshot());
        if (closed || scope !== request) return false;
        const rows = processRows(snapshot, previous);
        previous = snapshot;
        state = { ...state, rows, complete: snapshot.complete, skipped: snapshot.skipped,
          updated: Date.now(), error: '' };
        return true;
      } catch (error) {
        if (!closed && scope === request) {
          report('[processes] ' + String(error));
          previous = null;
          state = { ...state, error: String(error.message || error) };
        }
        return false;
      } finally {
        if (!closed && scope === request) { state = { ...state, loading: false }; changed(); }
      }
    },
    sortBy(key) {
      if (closed || !['name', 'pid', 'state', 'memoryBytes', 'cpuPercent'].includes(key)) return false;
      state = { ...state, sort: { key, direction: state.sort.key === key ? -state.sort.direction :
        ['memoryBytes', 'cpuPercent'].includes(key) ? -1 : 1 } };
      changed(); return true;
    },
    close() { closed = true; request++; previous = null; },
  });
}
