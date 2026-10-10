import { SETTINGS_INSTANCE_NAME, settingsPage, settingsThemeId, settingsTarget, daemonTarget } from './desktop/client/settings-contract.mjs';
import { waitSettingsReply, settingsPeer } from './desktop/client/settings.mjs';

const denied = message => Object.assign(new Error(message), { dbusName: 'org.pollyui.Settings.Error.AccessDenied' });
export function createSettingsService({ service, client, pid, uid, spawn, activate, appearance, about,
  select, reload, restore, managed, report = console.error }) {
  let owned = null, generation = 0, closed = false, fatal = null, opening = false;
  const requests = new Set();
  const current = owner => !closed && owner && owned === owner && owner.generation === generation;
  async function authorize(request, owner) {
    if (!current(owner)) throw denied('Settings owned process is no longer current');
    const peer = await settingsPeer(client, request.sender);
    if (!current(owner) || peer.pid !== owner.pid || peer.uid !== uid)
      throw denied('Only the current Shell-owned Settings PID may use this method');
  }
  async function present(owner, page) {
    if (!current(owner) || !owner.destination) throw new Error('Settings is still starting');
    const peer = await settingsPeer(client, owner.destination);
    if (!current(owner) || peer.pid !== owner.pid || peer.uid !== uid) throw denied('Settings presentation peer changed');
    await waitSettingsReply(client.call(settingsTarget('Present', owner.destination), 's', [page], '', 3000));
    if (!current(owner)) throw denied('Settings exited during presentation');
    owner.page = page;
    activate();
    return owner.pid;
  }
  async function open(page) {
    settingsPage(page);
    if (closed || fatal) throw fatal || new Error('Settings service is closed');
    if (opening) throw new Error('Settings is already opening; no duplicate launch was performed');
    opening = true;
    try {
      if (!owned) {
        const child = spawn(page);
        if (!Number.isInteger(child) || child <= 0) throw new Error('Settings spawn did not return a valid PID');
        owned = { pid: child, generation: ++generation, page, destination: null };
      }
      const owner = owned, deadline = Date.now() + 5000;
      while (current(owner) && !owner.destination) {
        if (Date.now() >= deadline) throw new Error('Settings startup timed out; process retained, no automatic relaunch');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      return await present(owner, page);
    } finally { opening = false; }
  }
  async function dispatch(request) {
    const member = request.target.member;
    if (member === 'Open') return [await open(settingsPage(request.args[0]))];
    const owner = owned;
    await authorize(request, owner);
    if (member === 'Connect') {
      const destination = await waitSettingsReply(client.call(daemonTarget('GetNameOwner'), 's', [SETTINGS_INSTANCE_NAME], 's', 3000));
      const peer = await settingsPeer(client, destination);
      if (!current(owner) || peer.pid !== owner.pid || peer.uid !== uid)
        throw denied('Settings presentation service does not belong to the owned PID');
      owner.destination = destination;
      return [pid, owner.generation, owner.page];
    }
    // No awaits between the final owned-generation check and a Shell operation.
    if (!current(owner)) throw denied('Settings generation changed before execution');
    if (member === 'GetAppearance') return [JSON.stringify(appearance())];
    if (member === 'GetAbout') return [JSON.stringify(about())];
    if (member === 'OpenManagedPage') {
      managed(settingsPage(request.args[0], true)); return [];
    }
    let success;
    if (member === 'SelectTheme') success = select(settingsThemeId(request.args[0]));
    else if (member === 'ReloadThemes') success = reload();
    else if (member === 'RestoreThemes') success = restore();
    else throw new TypeError('Unknown Settings operation');
    if (success !== true) throw Object.assign(new Error(appearance().error ||
      'Shell did not acknowledge the change; do not retry automatically'), { dbusName: 'org.pollyui.Settings.Error.ApplyFailed' });
    return [JSON.stringify(appearance())];
  }
  function fail(error) {
    fatal = error;
    report('[settings] ' + String(error));
    close();
  }
  function poll() {
    if (closed) return;
    let request;
    try { request = service.poll(); } catch (error) { fail(error); return; }
    if (!request) return;
    if (request.noReply) { request.close(); return; }
    if (requests.size >= 8) {
      request.error('org.pollyui.Settings.Error.Busy', 'Settings request limit reached'); return;
    }
    requests.add(request);
    dispatch(request).then(args => { if (!closed) request.reply(args); }, error => {
      if (!closed) request.error(error.dbusName || 'org.pollyui.Settings.Error.Failed', String(error.message));
    }).catch(fail).finally(() => { requests.delete(request); request.close(); });
  }
  const timer = setInterval(poll, 10);
  function close() {
    if (closed) return;
    closed = true; generation++;
    clearInterval(timer);
    for (const request of requests) request.close();
    requests.clear();
    try { service.close(); } finally { client.close(); }
  }
  return Object.freeze({
    open, close,
    exited(event) { if (owned?.pid === event.pid) { owned = null; generation++; } },
    getState: () => ({ pid: owned?.pid || 0, generation, page: owned?.page || null,
      connected: !!owned?.destination, error: fatal ? String(fatal) : '' }),
  });
}
