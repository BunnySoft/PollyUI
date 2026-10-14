import { parseSettingsNetwork } from './desktop/client/settings-network-contract.mjs';

const empty = () => ({ ready: false, registered: false, refreshing: false, revision: 1, operationId: 0,
  error: '', operation: '', target: '', networkConfiguration: null, devices: [], networks: [], authentication: null });
export function createSettingsNetworkClient(client, report = console.error) {
  let state = empty(), active = false, closed = false, timer = null, serial = 0, reading = false, busy = false;
  const notify = () => { if (active && !closed) adapter.onNetworkChanged?.(); };
  function failure(error) {
    const message = String(error.message || error) + '\nRequest outcome may be uncertain; no automatic write retry.';
    report('[settings-network] ' + message);
    state = { ...state, ready: false, authentication: null, operation: '', target: '', error: message }; notify();
  }
  async function refresh() {
    if (!active || closed || busy || reading) return;
    const scope = serial;
    reading = true;
    try {
      const next = parseSettingsNetwork(await client.call('GetNetwork'));
      if (active && !closed && scope === serial) { state = next; notify(); }
    } catch (error) { if (active && !closed && scope === serial) failure(error); }
    finally { reading = false; }
  }
  function command(member, value) {
    if (!active || closed || busy) throw new Error('Settings Wi-Fi request is unavailable or already pending');
    const scope = ++serial;
    busy = true;
    let pending;
    try { pending = client.call(member, value); }
    catch (error) { busy = false; failure(error); return false; }
    Promise.resolve(pending).then(reply => {
      if (active && !closed && scope === serial) { state = parseSettingsNetwork(reply); }
    }).catch(error => { if (active && !closed && scope === serial) failure(error); })
      .finally(() => { if (scope === serial) { busy = false; notify(); } });
    return true;
  }
  const adapter = {
    onNetworkChanged: null,
    startNetwork() {
      if (closed) throw new Error('Settings network client is closed');
      if (active) return;
      active = true; serial++; refresh(); timer = setInterval(refresh, 250);
    },
    stopNetwork() {
      if (!active) return;
      active = false; serial++; busy = false;
      if (timer !== null) clearInterval(timer);
      timer = null; state = empty();
      client.call('DetachNetwork').catch(error => report('[settings-network] Detach outcome not confirmed: ' + String(error.message || error)));
    },
    networkState() { return { ...state, devices: state.devices.map(item => ({ ...item })),
      networks: state.networks.map(item => ({ ...item })), authentication: state.authentication ? { ...state.authentication } : null,
      operation: busy ? state.operation || 'request' : state.operation }; },
    refreshNetworks: () => command('RefreshNetwork'),
    networkAction: (revision, target, action) => command('NetworkAction', JSON.stringify({ revision, target, action })),
    cancelNetworkConnection: () => command('CancelNetworkConnection'),
    replyNetworkAuthentication: (token, user, password) =>
      command('ReplyNetworkAuthentication', JSON.stringify({ token, user, password })),
    close() { if (closed) return; adapter.stopNetwork(); closed = true; },
    refresh,
  };
  return adapter;
}
