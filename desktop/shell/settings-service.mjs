import { SETTINGS_INSTANCE_NAME, settingsPage, settingsThemeId, settingsTarget, daemonTarget } from './desktop/client/settings-contract.mjs';
import { waitSettingsReply, settingsPeer } from './desktop/client/settings.mjs';
import { parseSettingsNetwork, parseSettingsNetworkAction, parseSettingsNetworkAuthentication } from './desktop/client/settings-network-contract.mjs';

const denied = message => Object.assign(new Error(message), { dbusName: 'org.pollyui.Settings.Error.AccessDenied' });
export function createSettingsService({ service, client, pid, uid, spawn, activate, appearance, about,
  select, reload, restore, managed, network = null, domains = null, report = console.error }) {
  let owned = null, generation = 0, closed = false, fatal = null, opening = false, requestOrder = 0;
  const requests = new Set();
  function networkSnapshot(owner) {
    if (!network) throw new Error('Shell Wi-Fi service is unavailable');
    network.startNetwork();
    const state = network.networkState();
    if (state.operation !== 'connect' || state.operationId !== owner.networkOperation) owner.networkOperation = null;
    return { version: 1, ...state, authentication: owner.networkOperation ? state.authentication : null };
  }
  function ownsConnection(owner) {
    const state = network.networkState();
    return owner?.networkOperation && state.operation === 'connect' && state.operationId === owner.networkOperation;
  }
  function detachNetwork(owner) {
    if (network && owner?.networkOperation && ownsConnection(owner)) network.cancelNetworkConnection();
    if (owner) { owner.networkOperation = null; owner.networkGeneration = (owner.networkGeneration || 0) + 1; }
  }
  function networkReply(owner) { return JSON.stringify(parseSettingsNetwork(JSON.stringify(networkSnapshot(owner)))); }
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
    const order = ++requestOrder;
    if (member === 'Open') return [await open(settingsPage(request.args[0]))];
    const owner = owned;
    const networkGeneration = owner?.networkGeneration || 0;
    const pageGeneration = owner?.pageGeneration || 0;
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
    if (member === 'GetDisplays') return [JSON.stringify(domains.displays())];
    if (member === 'GetAudio') return [JSON.stringify(domains.audio())];
    if (member === 'GetKeyboard') return [JSON.stringify(domains.keyboard(owner))];
    if (member === 'DetachPage') {
      settingsPage(request.args[0]);
      if (order < (owner.domainOrder || 0)) return [];
      owner.domainOrder = order;
      owner.pageGeneration = (owner.pageGeneration || 0) + 1;
      if (request.args[0] === 'keyboard') domains?.detach(owner);
      return [];
    }
    if (['ApplyDisplays', 'ForgetDisplayProfile', 'AudioAction', 'RefreshAudio', 'ForgetAudio',
      'KeyboardAction', 'CancelShortcutRecording'].includes(member)) {
      if (!domains) throw new Error('Settings domain services are unavailable');
      if (pageGeneration !== (owner.pageGeneration || 0) || order < (owner.domainOrder || 0))
        throw denied('Settings page detached or a newer operation executed before this request');
      owner.domainOrder = order;
      if (member === 'ApplyDisplays') domains.applyDisplays(request.args[0]);
      else if (member === 'ForgetDisplayProfile') domains.forgetDisplays(request.args[0]);
      else if (member === 'AudioAction') domains.audioAction(request.args[0]);
      else if (member === 'RefreshAudio') domains.retryAudio();
      else if (member === 'ForgetAudio') domains.forgetAudio(request.args[0]);
      else if (member === 'KeyboardAction') domains.keyboardAction(owner, request.args[0]);
      else domains.cancelRecording(owner, request.args[0]);
      return [JSON.stringify(member.includes('Display') ? domains.displays() :
        member.includes('Audio') ? domains.audio() : domains.keyboard(owner))];
    }
    if (member === 'GetNetwork') return [networkReply(owner)];
    if (member === 'DetachNetwork') {
      if (order < (owner.networkOrder || 0)) return [];
      owner.networkOrder = order;
      detachNetwork(owner); return [];
    }
    if (['NetworkAction', 'RefreshNetwork', 'ReplyNetworkAuthentication', 'CancelNetworkConnection'].includes(member)) {
      if (!network) throw new Error('Shell Wi-Fi service is unavailable');
      if (networkGeneration !== (owner.networkGeneration || 0) || order < (owner.networkOrder || 0))
        throw denied('Settings network page was detached or superseded before execution');
      owner.networkOrder = order;
      if (member === 'NetworkAction') {
        const action = parseSettingsNetworkAction(request.args[0]);
        network.networkAction(action.revision, action.target, action.action);
        owner.networkOperation = action.action === 'connect' ? network.networkState().operationId : null;
      } else if (member === 'RefreshNetwork') network.refreshNetworks();
      else {
        if (!ownsConnection(owner)) throw denied('This pending connection does not belong to Settings');
        if (member === 'CancelNetworkConnection') detachNetwork(owner);
        else {
          const auth = parseSettingsNetworkAuthentication(request.args[0]);
          network.replyNetworkAuthentication(auth.token, auth.user, auth.password);
        }
      }
      return [networkReply(owner)];
    }
    if (member === 'OpenManagedPage') {
      await managed(settingsPage(request.args[0], true)); return [];
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
    try { detachNetwork(owned); } catch (error) { report('[settings] Cannot cancel owned Wi-Fi connection: ' + String(error)); }
    try { if (owned) domains?.detach(owned); } catch (error) { report('[settings] Cannot release owned shortcut recording: ' + String(error)); }
    closed = true; generation++;
    clearInterval(timer);
    for (const request of requests) request.close();
    requests.clear();
    try { service.close(); } finally { client.close(); }
  }
  return Object.freeze({
    open, close,
    exited(event) {
      if (owned?.pid === event.pid) {
        try { detachNetwork(owned); } catch (error) { report('[settings] Cannot cancel exited Settings Wi-Fi request: ' + String(error)); }
        try { domains?.detach(owned); } catch (error) { report('[settings] Cannot release exited Settings recording: ' + String(error)); }
        owned = null; generation++;
      }
    },
    getState: () => ({ pid: owned?.pid || 0, generation, page: owned?.page || null,
      connected: !!owned?.destination, error: fatal ? String(fatal) : '' }),
  });
}
