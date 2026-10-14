export const NETWORK_ACTIONS = Object.freeze(['scan', 'disconnect', 'power-on', 'power-off', 'connect', 'forget']);
function fields(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length ||
      keys.some(key => !Object.hasOwn(value, key))) throw new TypeError('Invalid Settings network fields');
}
function text(value, maximum) {
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0'))
    throw new TypeError('Invalid Settings network text');
}
function integer(value, zero = false) {
  if (!Number.isInteger(value) || value < (zero ? 0 : 1) || value > 0xffffffff)
    throw new TypeError('Invalid Settings network token');
}
function path(value, empty = false) {
  text(value, 512);
  if (!(empty && value === '') && !/^\/net\/connman\/iwd(?:\/[A-Za-z0-9_]+)*$/.test(value))
    throw new TypeError('Invalid Settings iwd object path');
}
function payload(value, limit = 1024 * 1024) { text(value, limit); return JSON.parse(value); }
export function parseSettingsNetwork(source) {
  const value = payload(source);
  fields(value, ['version', 'ready', 'registered', 'refreshing', 'revision', 'operationId', 'error', 'operation',
    'target', 'networkConfiguration', 'devices', 'networks', 'authentication']);
  if (value.version !== 1 || ['ready', 'registered', 'refreshing'].some(key => typeof value[key] !== 'boolean') ||
      ![true, false, null].includes(value.networkConfiguration))
    throw new TypeError('Invalid Settings network state');
  integer(value.revision); integer(value.operationId, true); text(value.error, 16384); path(value.target, true);
  if (value.operation !== '' && !NETWORK_ACTIONS.includes(value.operation)) throw new TypeError('Invalid Wi-Fi operation');
  if (!Array.isArray(value.devices) || value.devices.length > 16 ||
      !Array.isArray(value.networks) || value.networks.length > 256) throw new TypeError('Invalid Wi-Fi list');
  const devices = new Set(), networks = new Set();
  for (const device of value.devices) {
    fields(device, ['id', 'name', 'address', 'state', 'mode', 'powered', 'scanning', 'station', 'connectedNetwork']);
    path(device.id); text(device.name, 64); text(device.address, 64); text(device.state, 31); text(device.mode, 31);
    path(device.connectedNetwork, true);
    if (devices.has(device.id) || ['powered', 'scanning', 'station'].some(key => typeof device[key] !== 'boolean'))
      throw new TypeError('Invalid Wi-Fi device');
    devices.add(device.id);
  }
  for (const network of value.networks) {
    fields(network, ['id', 'device', 'name', 'type', 'known', 'connected', 'signal', 'order']);
    path(network.id); path(network.device); text(network.name, 128); text(network.type, 31);
    if (networks.has(network.id) || !devices.has(network.device) ||
        typeof network.known !== 'boolean' || typeof network.connected !== 'boolean' ||
        (network.signal !== null && (!Number.isFinite(network.signal) || network.signal < -100 || network.signal > 0)) ||
        !Number.isInteger(network.order) || network.order < 0 || network.order > 2147483647)
      throw new TypeError('Invalid Wi-Fi network');
    networks.add(network.id);
  }
  for (const device of value.devices)
    if (device.connectedNetwork && !networks.has(device.connectedNetwork)) throw new TypeError('Unknown connected network');
  if (value.authentication !== null) {
    const auth = value.authentication;
    fields(auth, ['id', 'kind', 'network', 'username']);
    integer(auth.id); path(auth.network); text(auth.username, 256);
    if (!['passphrase', 'private-key', 'username-password', 'password'].includes(auth.kind) ||
        !networks.has(auth.network) || value.operation !== 'connect' || auth.network !== value.target)
      throw new TypeError('Invalid Wi-Fi authentication prompt');
  }
  return value;
}
export function parseSettingsNetworkAction(source) {
  const value = payload(source, 2048);
  fields(value, ['revision', 'target', 'action']);
  integer(value.revision); path(value.target);
  if (!NETWORK_ACTIONS.includes(value.action)) throw new TypeError('Invalid Settings Wi-Fi action');
  return value;
}
export function parseSettingsNetworkAuthentication(source) {
  const value = payload(source, 8192);
  fields(value, ['token', 'user', 'password']); integer(value.token);
  if (value.user === null && value.password === null) return value;
  text(value.user, 256); text(value.password, 1024);
  return value;
}
