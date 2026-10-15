import { parseDisplays, parseAudio, parseKeyboard } from './desktop/client/settings-domains-contract.mjs';

const snapshots = { displays: ['GetDisplays', parseDisplays], audio: ['GetAudio', parseAudio], keyboard: ['GetKeyboard', parseKeyboard] };
export function createSettingsPages({ client, changed = () => {}, report = console.error }) {
  let active = null, serial = 0, reading = null, closed = false;
  let state = { snapshot: null, busy: false, error: '', unavailable: false };
  function failure(error) {
    state = { ...state, error: String(error.message || error) +
      '\nRequest effects may already have occurred; no automatic mutation retry.',
      unavailable: ['ERR_DBUS_CLOSED', 'ERR_DBUS_DISCONNECTED', 'ERR_DBUS_NAME_LOST'].includes(error.code) };
    report('[settings] ' + state.error);
  }
  async function refresh() {
    if (!active || closed || reading === serial || state.busy || state.unavailable) return;
    const scope = serial, page = active;
    reading = scope;
    try {
      const [member, parse] = snapshots[page], snapshot = parse(await client.call(member));
      if (scope === serial && !closed) state = { ...state, snapshot };
    } catch (error) { if (scope === serial && !closed) failure(error); }
    finally { if (reading === scope) reading = null; if (scope === serial && !closed) changed(); }
  }
  function detach() {
    if (!active) return;
    const page = active; active = null; serial++; state = { snapshot: null, busy: false, error: '', unavailable: false };
    client.call('DetachPage', page).catch(error => report('[settings] Page detach not confirmed: ' + String(error)));
  }
  return Object.freeze({
    getState: () => state,
    refresh,
    activate(page) {
      if (page === active) return;
      detach();
      if (snapshots[page] && !closed) { active = page; refresh(); }
    },
    detach,
    async command(member, argument) {
      if (!active || state.busy || state.unavailable || closed || !state.snapshot) return false;
      const scope = ++serial, page = active;
      state = { ...state, busy: true, error: '' }; changed();
      try {
        const pending = client.call(member, argument);
        const snapshot = snapshots[page][1](await pending);
        if (scope !== serial || closed) return false;
        state = { ...state, snapshot }; return true;
      } catch (error) {
        if (scope === serial && !closed) failure(error);
        return false;
      } finally {
        if (scope === serial && !closed) { state = { ...state, busy: false }; changed(); }
      }
    },
    close() { if (!closed) { detach(); closed = true; } },
  });
}
