import { alloc } from 'sysrt:ffi';
import { openDbusEndpoint, dbusSkipped } from './sysrt/sdk/js/dbus.mjs';
import { monotonicNanoseconds } from './sysrt/sdk/js/clock.mjs';
import { encodeUtf8, decodeUtf8 } from './sysrt/sdk/js/encoding.mjs';
import { raw, call } from './desktop/shared/native-files.mjs';

const IWD = 'net.connman.iwd', ROOT = '/net/connman/iwd', AGENT = '/org/pollyui/NetworkAgent';
const DBUS = 'org.freedesktop.DBus', DBUS_PATH = '/org/freedesktop/DBus';
const OM = DBUS + '.ObjectManager', PROPERTIES = DBUS + '.Properties';
const fields = {
  [IWD + '.Device']: { Name: ['s', 64], Address: ['s', 64], Powered: ['b'], Mode: ['s', 31] },
  [IWD + '.Station']: { State: ['s', 31], Scanning: ['b'], ConnectedNetwork: ['o', 512] },
  [IWD + '.Network']: { Name: ['s', 128], Type: ['s', 31], Device: ['o', 512], KnownNetwork: ['o', 512], Connected: ['b'] },
};
const projection = path => path.length === 2 ? Boolean(fields[path[1]]) :
  path.length === 3 ? Boolean(fields[path[1]]?.[path[2]]) : true;
const infoProjection = path => path.length !== 1 || path[0] === 'NetworkConfigurationEnabled';
const ignoredSignal = () => false;
const agentMethods = {
  Release: { signature: '', replySignature: '' }, Cancel: { signature: 's', replySignature: '' },
  RequestPassphrase: { signature: 'o', replySignature: 's' },
  RequestPrivateKeyPassphrase: { signature: 'o', replySignature: 's' },
  RequestUserNameAndPassword: { signature: 'o', replySignature: 'ss' },
  RequestUserPassword: { signature: 'os', replySignature: 's' },
};
const rules = [
  "type='signal',sender='org.freedesktop.DBus',path='/org/freedesktop/DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='net.connman.iwd'",
  "type='signal',sender='net.connman.iwd',interface='org.freedesktop.DBus.ObjectManager'",
  "type='signal',sender='net.connman.iwd',interface='org.freedesktop.DBus.Properties'",
];
const now = () => monotonicNanoseconds();
const next = value => (value + 1) >>> 0 || 1;
const integer = value => Number.isInteger(value) && value >= 1 && value <= 0xffffffff;
function bounded(value, limit, label) {
  if (typeof value !== 'string' || value.includes('\0')) throw new TypeError('Invalid ' + label);
  encodeUtf8(value, limit); return value;
}
function iwdPath(value) {
  bounded(value, 512, 'iwd object path');
  if (value !== ROOT && !value.startsWith(ROOT + '/')) throw new TypeError('Invalid iwd object path prefix');
  return value;
}
function pairs(value, limit, label) {
  if (!Array.isArray(value) || value.length > limit) throw new TypeError('Invalid ' + label);
  const result = new Map();
  for (const pair of value) {
    if (!Array.isArray(pair) || pair.length !== 2 || result.has(pair[0]))
      throw new TypeError('Duplicate or invalid ' + label);
    result.set(pair[0], pair[1]);
  }
  return result;
}
function variant(value, signature, limit, label) {
  if (!value || value === dbusSkipped || value.signature !== signature)
    throw new TypeError('Invalid iwd ' + label + ' type');
  return signature === 'b' ? value.value : bounded(value.value, limit, label);
}

export function systemBusAddress() {
  const pointer = raw('environment', 'DBUS_SYSTEM_BUS_ADDRESS').value;
  if (pointer === null) return 'unix:path=/run/dbus/system_bus_socket';
  try {
    const length = Number(call('stringLength', pointer, 4096));
    if (!length || length === 4096) throw new TypeError('Invalid explicit system D-Bus address');
    const buffer = alloc(length);
    try {
      raw('copy', buffer, pointer, length).value.close();
      return bounded(decodeUtf8(new Uint8Array(buffer.read(length))), 4095, 'system D-Bus address');
    } finally { buffer.close(); }
  } finally { pointer.close(); }
}

// Authorization is captured from the real desktop.windows binding by the
// launcher. Neither an ambient session bus nor a second agent connection is used.
export function createNetworkService(authorize, address = systemBusAddress, service = {}) {
  if (typeof authorize !== 'function') throw new TypeError('Network service requires Shell authorization');
  let bus = null, timer = null, epoch = 1, revision = 1, promptId = 0;
  let owner = '', trusted = false, registered = false, ready = false, fatal = false;
  let refreshing = false, dirty = false, changed = false, error = '', configuration = null;
  let watching = false;
  let operation = '', target = '', operationDevice = '', canceled = false, operationId = 0;
  let devices = [], networks = [], authentication = null;
  const pending = new Set();
  const acceptIwd = (sender, header) => trusted && sender === owner &&
    (header.path === '/' || header.path === ROOT || header.path?.startsWith(ROOT + '/'));
  function setError(message) {
    error = message; changed = true; console.error('[network] ' + message);
  }
  function failed(label, outcome) {
    setError(label + ' failed: ' + (outcome?.error?.dbusName ?? outcome?.error?.code ?? 'invalid reply'));
  }
  function cancelAuthentication(reply = true) {
    const current = authentication; authentication = null; promptId = next(promptId); changed = true;
    if (current) {
      if (reply) current.request.error(IWD + '.Agent.Error.Canceled', 'Authentication canceled');
      else current.request.close();
    }
  }
  function reset(reply = true) {
    cancelAuthentication(reply);
    for (const item of pending) item.ticket.cancel();
    pending.clear(); devices = []; networks = [];
    trusted = registered = ready = refreshing = dirty = false;
    owner = operation = target = operationDevice = ''; canceled = false; configuration = null;
    epoch = next(epoch); revision = next(revision); changed = true;
  }
  function daemon(member) {
    return { destination: DBUS, path: DBUS_PATH, interface: DBUS, member };
  }
  function method(path, interfaceName, member) {
    return { destination: owner, path, interface: interfaceName, member };
  }
  function queue(type, destination, signature, args, reply, timeout, path = '', project) {
    if (pending.size >= 32) {
      setError('Network request queue is full'); throw new Error(error);
    }
    let ticket;
    try { ticket = bus.call(destination, signature, args, reply, timeout, project); }
    catch (cause) { failed('Network request', { error: cause }); throw new Error(error); }
    pending.add({ type, ticket, epoch, revision, path });
  }
  function discover() { queue('owner', daemon('GetNameOwner'), 's', [IWD], 's', 3000); }
  function refresh() {
    if (!trusted) return;
    if (refreshing) { dirty = true; return; }
    queue('model', method('/', OM, 'GetManagedObjects'), '', [], 'a{oa{sa{sv}}}', 5000, '', projection);
    refreshing = true; dirty = false;
  }
  function parseModel(input) {
    const nextDevices = new Map(), nextNetworks = [];
    for (const [path, interfaces] of pairs(input, 1024, 'iwd objects')) {
      iwdPath(path);
      for (const [interfaceName, properties] of pairs(interfaces, 16, 'iwd interfaces')) {
        const schema = fields[interfaceName];
        if (!schema) {
          if (properties !== dbusSkipped) throw new TypeError('Unprojected iwd interface');
          continue;
        }
        const values = pairs(properties, 64, 'iwd properties'), result = {};
        for (const [name, item] of values) {
          const field = schema[name];
          if (!field) {
            if (item !== dbusSkipped) throw new TypeError('Unprojected iwd property');
            continue;
          }
          result[name] = variant(item, field[0], field[1], name);
          if (field[0] === 'o') iwdPath(result[name]);
        }
        if (interfaceName === IWD + '.Network') {
          if (nextNetworks.length >= 256) throw new TypeError('Too many iwd networks');
          nextNetworks.push({ id: path, device: result.Device ?? '', knownPath: result.KnownNetwork ?? '',
            name: result.Name ?? '', type: result.Type ?? '', connected: result.Connected ?? false,
            signal: null, order: 2147483647 });
        } else {
          let device = nextDevices.get(path);
          if (!device) {
            if (nextDevices.size >= 16) throw new TypeError('Too many iwd devices');
            device = { id: path, name: '', address: '', state: '', mode: '', powered: false,
              scanning: false, station: false, connectedNetwork: '' };
            nextDevices.set(path, device);
          }
          if (interfaceName === IWD + '.Device') Object.assign(device, {
            name: result.Name ?? '', address: result.Address ?? '', powered: result.Powered ?? false,
            mode: result.Mode ?? '',
          });
          else Object.assign(device, { station: true, state: result.State ?? '',
            scanning: result.Scanning ?? false, connectedNetwork: result.ConnectedNetwork ?? '' });
        }
      }
    }
    for (const entry of nextNetworks) {
      if (!entry.name || !entry.type || !nextDevices.has(entry.device))
        throw new TypeError('Invalid iwd network/device relationship');
    }
    for (const device of nextDevices.values()) {
      if (device.connectedNetwork && !nextNetworks.some(entry =>
        entry.id === device.connectedNetwork && entry.device === device.id))
        throw new TypeError('Invalid iwd connected network relationship');
    }
    devices = [...nextDevices.values()]; networks = nextNetworks;
    revision = next(revision); ready = true; changed = true;
    if (operation === 'connect' && (!networks.some(entry => entry.id === target) ||
        !nextDevices.has(operationDevice))) {
      cancelAuthentication(); dropOperations(); operation = target = operationDevice = '';
      setError('Wi-Fi connection target disappeared');
    }
    for (const item of pending) if (item.type === 'order') {
      item.ticket.cancel(); pending.delete(item);
    }
    for (const device of devices) if (device.station)
      queue('order', method(device.id, IWD + '.Station', 'GetOrderedNetworks'), '', [], 'a(on)', 5000, device.id);
  }
  function parseOrder(input, path) {
    if (!Array.isArray(input) || input.length > 256) throw new TypeError('Invalid iwd network ordering');
    const seen = new Set(), updates = [];
    input.forEach(([id, signal], order) => {
      iwdPath(id);
      if (!Number.isInteger(signal) || signal < -10000 || signal > 0 || seen.has(id))
        throw new TypeError('Invalid iwd RSSI/order');
      seen.add(id);
      const entry = networks.find(item => item.id === id);
      if (entry) {
        if (entry.device !== path) throw new TypeError('Invalid iwd ordered device relationship');
        updates.push([entry, signal / 100, order]);
      }
    });
    for (const [entry, signal, order] of updates) Object.assign(entry, { signal, order });
    changed = true;
  }
  function completed(item, outcome) {
    if (item.epoch !== epoch) return;
    const ok = outcome.state === 'reply';
    if (item.type === 'match') {
      if (!ok) throw new Error('Cannot watch iwd: ' + (outcome.error?.dbusName ?? outcome.error?.code));
      if (![...pending].some(item => item.type === 'match')) { watching = true; discover(); }
    } else if (item.type === 'owner') {
      if (!ok || typeof outcome.value !== 'string' || !outcome.value.startsWith(':')) {
        failed('iwd discovery', outcome); return;
      }
      owner = bounded(outcome.value, 255, 'iwd owner');
      queue('uid', daemon('GetConnectionUnixUser'), 's', [owner], 'u', 3000);
    } else if (item.type === 'uid') {
      if (!ok || outcome.value !== 0) {
        owner = ''; setError('iwd must be owned by the root system service'); return;
      }
      trusted = true; error = '';
      queue('register', method(ROOT, IWD + '.AgentManager', 'RegisterAgent'), 'o', [AGENT], '', 5000);
      queue('info', method(ROOT, IWD + '.Daemon', 'GetInfo'), '', [], 'a{sv}', 5000, '', infoProjection);
      refresh();
    } else if (item.type === 'register') {
      registered = ok; if (!ok) failed('Network authentication registration', outcome); changed = true;
    } else if (item.type === 'info') {
      if (ok) {
        const values = pairs(outcome.value, 64, 'iwd configuration');
        if (values.has('NetworkConfigurationEnabled'))
          configuration = variant(values.get('NetworkConfigurationEnabled'), 'b', 0, 'network configuration status');
        changed = true;
      } else if (![DBUS + '.Error.UnknownMethod', DBUS + '.Error.UnknownInterface'].includes(outcome.error?.dbusName))
        failed('iwd configuration query', outcome);
    } else if (item.type === 'model') {
      refreshing = false;
      if (!ok) { ready = false; failed('Wi-Fi discovery', outcome); }
      else {
        try { parseModel(outcome.value); }
        catch (cause) { ready = false; failed('Wi-Fi discovery', { error: { code: 'ERR_IWD_MODEL' } }); }
      }
      if (dirty) refresh();
    } else if (item.type === 'order') {
      if (item.revision !== revision) return;
      if (!ok) failed('Wi-Fi network ordering', outcome);
      else {
        try { parseOrder(outcome.value, item.path); }
        catch (cause) { failed('Wi-Fi network ordering', { error: { code: 'ERR_IWD_ORDER' } }); }
      }
    } else {
      operation = target = operationDevice = ''; cancelAuthentication();
      if (!ok && !canceled) failed('Wi-Fi operation', outcome);
      canceled = false; refresh(); changed = true;
    }
  }
  function agent(request) {
    if (!trusted || request.sender !== owner) {
      request.error(DBUS + '.Error.AccessDenied', 'Only the authenticated iwd service may call this agent'); return;
    }
    const member = request.target.member;
    if (member === 'Release' || member === 'Cancel') {
      cancelAuthentication(false);
      if (member === 'Release') { registered = false; setError('iwd released the authentication agent'); }
      request.reply(); return;
    }
    const kind = { RequestPassphrase: 'passphrase', RequestPrivateKeyPassphrase: 'private-key',
      RequestUserNameAndPassword: 'username-password', RequestUserPassword: 'password' }[member];
    const [path, user = ''] = request.args;
    let validUser = true;
    try { bounded(user, 256, 'agent username'); } catch { validUser = false; }
    if (!kind || request.noReply || authentication || operation !== 'connect' || path !== target || !validUser) {
      request.error(IWD + '.Agent.Error.Canceled', 'No matching interactive connection request'); return;
    }
    promptId = next(promptId);
    authentication = { request, kind, username: user, deadline: now() + 120000000000n };
    changed = true;
  }
  function signal(message) {
    const { sender, target: header, args } = message;
    if (header.interface === DBUS && header.member === 'NameOwnerChanged') {
      if (sender !== DBUS || header.path !== DBUS_PATH) return;
      if (!watching) return;
      const [name, old, current] = args;
      if (name !== IWD || old === current) return;
      reset();
      if (current) discover(); else setError('iwd service is unavailable');
    } else if (trusted && sender === owner &&
        (header.path === '/' || header.path === ROOT || header.path?.startsWith(ROOT + '/'))) refresh();
  }
  function notifyChanged() {
    if (!changed) return;
    changed = false;
    const callback = service.onNetworkChanged;
    try {
      if (typeof callback === 'function') callback.call(service);
      else if (callback !== null && callback !== undefined) throw new TypeError('Network callback must be a function');
    } catch { console.error('[network] Callback failed'); }
  }
  function pump() {
    if (!bus || fatal) return;
    try {
      for (let count = 0; count < 64; count++) {
        const message = bus.poll();
        if (message?.kind === 'method') agent(message);
        else if (message?.kind === 'signal') signal(message);
      }
      for (const item of [...pending]) {
        if (!pending.has(item)) continue;
        const outcome = item.ticket.poll();
        if (outcome.state === 'pending') continue;
        pending.delete(item); completed(item, outcome);
      }
      if (authentication && now() >= authentication.deadline) {
        cancelAuthentication(); setError('Wi-Fi authentication timed out');
      }
    } catch (cause) {
      reset(false); fatal = true; bus.close(); setError('System bus service failed: ' + (cause.code ?? 'ERR_IWD_PROTOCOL'));
      if (timer !== null) { clearInterval(timer); timer = null; }
    }
    notifyChanged();
  }
  function dropOperations() {
    for (const item of pending) if (item.type === 'operation') {
      item.ticket.cancel(); pending.delete(item);
    }
  }
  Object.assign(service, {
    onNetworkChanged: null,
    startNetwork() {
      authorize();
      if (bus && !fatal && trusted && registered && ready) return;
      service.stopNetwork(); error = '';
      try {
        bus = openDbusEndpoint(address(), {
          objects: [{ path: AGENT, interface: IWD + '.Agent', methods: agentMethods,
            accept: sender => trusted && sender === owner }],
          signals: [
            { interface: DBUS, member: 'NameOwnerChanged', signature: 'sss',
              accept: (sender, header) => sender === DBUS && header.path === DBUS_PATH },
            { interface: OM, member: 'InterfacesAdded', signature: 'oa{sa{sv}}', projection: ignoredSignal, accept: acceptIwd },
            { interface: OM, member: 'InterfacesRemoved', signature: 'oas', projection: ignoredSignal, accept: acceptIwd },
            { interface: PROPERTIES, member: 'PropertiesChanged', signature: 'sa{sv}as', projection: ignoredSignal, accept: acceptIwd },
          ],
          limits: { receivedBytes: 4 * 1024 * 1024, messageBytes: 2 * 1024 * 1024,
            receivedFDs: 16, messageFDs: 0, outgoingBytes: 2 * 1024 * 1024 },
        });
        for (const rule of rules) queue('match', daemon('AddMatch'), 's', [rule], '', 3000);
        timer = setInterval(pump, 10);
      } catch (cause) {
        service.stopNetwork(); failed('System bus connection', { error: cause }); throw new Error(error);
      }
    },
    stopNetwork() {
      if (timer !== null) { clearInterval(timer); timer = null; }
      if (bus) {
        try {
          if (registered && trusted && !fatal)
            bus.notify(method(ROOT, IWD + '.AgentManager', 'UnregisterAgent'), 'o', [AGENT]);
        } catch (cause) { failed('Network unregistration', { error: cause }); }
        try {
          reset(!fatal);
          // One nonblocking I/O step attempts queued cancellation/unregistration;
          // send acceptance is not a claim of remote delivery or rollback.
          if (!fatal) bus.poll();
        } catch (cause) { reset(false); failed('Network shutdown', { error: cause }); }
        finally { bus.close(); bus = null; }
      }
      fatal = watching = false;
    },
    networkState() {
      return { ready: ready && trusted && !fatal, registered, refreshing, revision, operationId, error, operation, target,
        networkConfiguration: configuration, devices: devices.map(device => ({ ...device })),
        networks: networks.map(({ knownPath, ...entry }) => ({ ...entry, known: Boolean(knownPath) })),
        authentication: authentication ? { id: promptId, kind: authentication.kind,
          network: target, username: authentication.username } : null };
    },
    refreshNetworks() {
      if (!trusted || fatal) throw new TypeError('iwd is not ready');
      error = ''; refresh();
    },
    networkAction(currentRevision, path, action) {
      if (!bus || !trusted || !ready || fatal) throw new TypeError('iwd is not ready');
      if (operation) throw new TypeError('A Wi-Fi operation is already in progress');
      if (arguments.length !== 3 || !integer(currentRevision) || currentRevision !== revision ||
          typeof action !== 'string' || action.includes('\0'))
        throw new TypeError('Network action requires a current revision, target and action');
      iwdPath(path);
      const entry = networks.find(item => item.id === path), device = devices.find(item => item.id === path);
      const station = entry && devices.find(item => item.id === entry.device);
      let destination, signature = '', args = [], timeout = 15000;
      if (entry && action === 'connect' && registered && station?.powered && station.station &&
          (['open', 'psk'].includes(entry.type) || (entry.type === '8021x' && entry.knownPath))) {
        destination = method(path, IWD + '.Network', 'Connect'); timeout = 120000;
      } else if (entry && action === 'forget' && entry.knownPath)
        destination = method(entry.knownPath, IWD + '.KnownNetwork', 'Forget');
      else if (device?.station && ['scan', 'disconnect'].includes(action))
        destination = method(path, IWD + '.Station', action === 'scan' ? 'Scan' : 'Disconnect');
      else if (device && ['power-on', 'power-off'].includes(action)) {
        destination = method(path, PROPERTIES, 'Set'); signature = 'ssv';
        args = [IWD + '.Device', 'Powered', { signature: 'b', value: action === 'power-on' }];
      }
      if (!destination) throw new TypeError('Unsupported or unavailable Wi-Fi action');
      queue('operation', destination, signature, args, '', timeout, path);
      operation = action; target = path; operationDevice = entry?.device ?? device?.id ?? '';
      operationId = next(operationId);
      error = ''; canceled = false; changed = true;
    },
    cancelNetworkConnection() {
      if (!trusted || fatal || operation !== 'connect' || !operationDevice)
        throw new TypeError('No interactive Wi-Fi connection is in progress');
      const device = operationDevice;
      cancelAuthentication(); dropOperations(); operation = target = operationDevice = '';
      queue('operation', method(device, IWD + '.Station', 'Disconnect'), '', [], '', 15000, device);
      operation = 'disconnect'; target = operationDevice = device; canceled = false; changed = true;
      operationId = next(operationId);
    },
    replyNetworkAuthentication(token, user, password) {
      if (arguments.length !== 3 || !integer(token) || !authentication || token !== promptId || !trusted || fatal)
        throw new TypeError('Stale network authentication prompt');
      if (user === null && password === null) { canceled = true; cancelAuthentication(); return; }
      bounded(user, 256, 'authentication username'); bounded(password, 1024, 'authentication password');
      const length = encodeUtf8(password, 1024).length, both = authentication.kind === 'username-password';
      if (!length || (both && !user) || (authentication.kind === 'passphrase' &&
          !((length >= 8 && length <= 63) || (length === 64 && /^[0-9a-fA-F]{64}$/.test(password)))))
        throw new TypeError('Invalid authentication field length or format');
      try { authentication.request.reply(both ? [user, password] : [password]); }
      catch (cause) {
        cancelAuthentication(false); failed('Network authentication response', { error: cause }); throw new Error(error);
      }
      authentication = null; promptId = next(promptId); changed = true;
    },
  });
  return service;
}
