import { parseAppearance, parseAbout, settingsPage } from './desktop/client/settings-contract.mjs';

export function createSettingsController({ client, page = 'appearance', changed = () => {}, report = console.error }) {
  const state = { page: settingsPage(page), appearance: null, about: null, busy: false,
    error: '', unavailable: false, closed: false };
  let serial = 0, refreshing = false;
  function error(failure) {
    const message = String(failure.message || failure) +
      '\nA failed/timed-out request may already have committed. Settings never retries writes automatically.';
    if (['ERR_DBUS_CLOSED', 'ERR_DBUS_DISCONNECTED', 'ERR_DBUS_NAME_LOST'].includes(failure.code)) state.unavailable = true;
    if (state.error !== message) report('[settings] ' + message);
    state.error = message;
  }
  async function refresh() {
    if (state.closed || state.unavailable || state.busy || refreshing) return;
    const scope = serial;
    refreshing = true;
    try {
      const appearance = parseAppearance(await client.call('GetAppearance'));
      const about = state.page === 'about' ? parseAbout(await client.call('GetAbout')) : state.about;
      if (!state.closed && scope === serial) { state.appearance = appearance; state.about = about; }
    } catch (failure) { if (!state.closed && scope === serial) error(failure); }
    finally { refreshing = false; if (!state.closed && scope === serial) changed(); }
  }
  async function command(member, argument) {
    if (state.closed || state.unavailable || state.busy || !state.appearance) return;
    const scope = ++serial;
    state.busy = true; state.error = ''; changed();
    try {
      const reply = await client.call(member, argument);
      if (!state.closed && scope === serial && member !== 'OpenManagedPage') state.appearance = parseAppearance(reply);
    } catch (failure) {
      if (!state.closed && scope === serial) {
        error(failure);
        try { state.appearance = parseAppearance(await client.call('GetAppearance')); }
        catch (snapshotError) { state.error += '\nCurrent Shell state unavailable: ' + String(snapshotError); }
      }
    } finally { if (!state.closed && scope === serial) { state.busy = false; changed(); } }
  }
  return Object.freeze({
    getState: () => ({ ...state }),
    refresh,
    navigate(page) { if (state.closed) return; state.page = settingsPage(page); changed(); return refresh(); },
    select: id => command('SelectTheme', id), reload: () => command('ReloadThemes'), restore: () => command('RestoreThemes'),
    managed: page => command('OpenManagedPage', settingsPage(page, true)),
    fail: failure => { if (!state.closed) { state.unavailable = true; error(failure); changed(); } },
    close() { if (!state.closed) { state.closed = true; serial++; client.close(); } },
  });
}
