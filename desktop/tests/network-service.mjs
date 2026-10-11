import { libc } from 'sysrt:ffi';
import { createNetworkService, systemBusAddress } from './desktop/services/network.mjs';
import { loadBindings } from './sysrt/sdk/js/native.mjs';
import { shutdownDbus } from './sysrt/sdk/js/dbus.mjs';
import { check, refuses, descriptorCount, pause, print, dispose, monotonicNanoseconds } from './sysrt/tests/dbus-endpoint-support.mjs';

const environment = loadBindings({ library: libc === 'glibc' ? 'libc.so.6' : 'libc.musl-x86_64.so.1', functions: {
  set: { symbol: 'setenv', result: 'i32', parameters: ['cstring', 'cstring', 'i32'] },
  clear: { symbol: 'unsetenv', result: 'i32', parameters: ['cstring'] },
  uid: { symbol: 'getuid', result: 'u32', parameters: [] },
} });
const initial = descriptorCount(), original = systemBusAddress(), variable = 'DBUS_SYSTEM_BUS_ADDRESS';
const interval = globalThis.setInterval, clear = globalThis.clearInterval;
const originalConsole = globalThis.console, logs = [];
globalThis.console = { error: message => logs.push(message) };
const callbacks = new Set();
globalThis.setInterval = callback => { callbacks.add(callback); return callback; };
globalThis.clearInterval = callback => callbacks.delete(callback);
let service, verified = false;
try {
  check(environment.call('uid').value === 1000, 'Ordinary-user JS service process');
  check(environment.call('clear', variable).value === 0, 'Clear explicit fixture address');
  check(systemBusAddress() === 'unix:path=/run/dbus/system_bus_socket', 'System default address never uses the session bus or HOME');
  check(environment.call('set', variable, '', 1).value === 0, 'Set empty override');
  refuses(systemBusAddress);
  check(environment.call('set', variable, 'x'.repeat(4096), 1).value === 0, 'Set oversized override');
  refuses(systemBusAddress);
  check(environment.call('set', variable, processChild, 1).value === 0, 'Set real isolated fixture address');
  check(systemBusAddress() === processChild, 'Explicit system-bus fixture address preserved');
  let authorizations = 0;
  const denied = createNetworkService(() => { authorizations++; throw new TypeError('Shell authorization denied'); });
  refuses(() => denied.startNetwork());
  check(authorizations === 1 && !denied.networkState().ready && callbacks.size === 0,
    'Unauthorized start fails before bus admission or timer creation');
  service = createNetworkService(() => { authorizations++; });
  service.startNetwork();
  const deadline = monotonicNanoseconds() + 5000000000n;
  while (!service.networkState().error.includes('root system service')) {
    for (const callback of callbacks) callback();
    check(monotonicNanoseconds() < deadline, 'Real non-root owner rejection deadline');
    collect(); await pause();
  }
  const state = service.networkState();
  check(!state.ready && !state.registered && state.devices.length === 0 && state.authentication === null,
    'Real daemon UID lookup rejects the ordinary-user iwd owner');
  refuses(() => service.networkAction(state.revision, '/net/connman/iwd/0/1', 'scan'));
  service.stopNetwork();
  check(callbacks.size === 0 && !service.networkState().ready, 'Stop drops untrusted-owner connection and polling lifetime');
  check(authorizations === 2, 'Each start invokes captured authorization');
  check(logs.length === 1 && logs[0] === '[network] iwd must be owned by the root system service',
    'Domain diagnostics expose only the owner trust failure');
  verified = true;
} finally {
  service?.stopNetwork();
  shutdownDbus(); collect();
  check(descriptorCount() === initial, 'Domain service restores exact descriptor count');
  check(environment.call('set', variable, original, 1).value === 0, 'Restore process fixture address');
  environment.close(); globalThis.setInterval = interval; globalThis.clearInterval = clear; globalThis.console = originalConsole;
  if (verified) print('PASS: real non-root iwd owner rejection, Shell admission, explicit system address and domain close/GC/fd lifecycle');
  dispose();
}
