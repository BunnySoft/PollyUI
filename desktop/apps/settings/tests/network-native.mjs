import { openDbusClient, openDbusService } from './sysrt/sdk/js/dbus.mjs';
import { createNetworkService } from './desktop/services/network.mjs';
import { createSettingsService } from './desktop/shell/settings-service.mjs';
import { createSettingsClient } from './desktop/client/settings.mjs';
import { parseSettingsNetwork } from './desktop/client/settings-network-contract.mjs';
import { SETTINGS_BUS_NAME, SETTINGS_INSTANCE_NAME, SETTINGS_PATH, SETTINGS_INTERFACE, SETTINGS_METHODS } from './desktop/client/settings-contract.mjs';
import { check, pause, print, dispose, monotonicNanoseconds } from './sysrt/tests/dbus-endpoint-support.mjs';

const original = { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval,
  setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, console: globalThis.console };
const timers = new Set(), reports = [];
function schedule(callback, milliseconds, repeat) {
  const timer = { callback, interval: BigInt(milliseconds) * 1000000n, at: monotonicNanoseconds(), repeat };
  timer.at += timer.interval; timers.add(timer); return timer;
}
globalThis.setInterval = (callback, milliseconds) => schedule(callback, milliseconds, true);
globalThis.setTimeout = (callback, milliseconds) => schedule(callback, milliseconds, false);
globalThis.clearInterval = globalThis.clearTimeout = timer => timers.delete(timer);
globalThis.console = { error: value => reports.push(String(value)) };
const address = processChild;
const service = openDbusService(address, { name: SETTINGS_BUS_NAME, path: SETTINGS_PATH,
  interface: SETTINGS_INTERFACE, methods: SETTINGS_METHODS });
const presentation = openDbusService(address, { name: SETTINGS_INSTANCE_NAME, path: SETTINGS_PATH,
  interface: SETTINGS_INTERFACE, methods: { Present: { signature: 's', replySignature: '' } } });
const network = createNetworkService(() => {});
const bridge = createSettingsService({ service, client: openDbusClient(address), pid: expectedProcessId, uid: 1000,
  spawn: () => expectedProcessId, activate() {}, network, report: value => reports.push(String(value)) });
let client = null;
async function step() {
  for (const timer of [...timers]) {
    const now = monotonicNanoseconds();
    if (!timers.has(timer) || now < timer.at) continue;
    if (timer.repeat) timer.at = now + timer.interval;
    else timers.delete(timer);
    timer.callback();
  }
  const request = presentation.poll();
  if (request) { request.reply([]); request.close(); }
  await pause();
}
async function settle(promise) {
  let done = false, value, failure;
  promise.then(result => { done = true; value = result; }, error => { done = true; failure = error; });
  const deadline = monotonicNanoseconds() + 8000000000n;
  while (!done) {
    check(monotonicNanoseconds() < deadline, 'Settings private service deadline');
    await step();
  }
  if (failure) throw failure;
  return value;
}
const read = async () => parseSettingsNetwork(await settle(client.call('GetNetwork')));
async function until(predicate) {
  const deadline = monotonicNanoseconds() + 8000000000n;
  for (;;) {
    const state = await read();
    if (predicate(state)) return state;
    check(monotonicNanoseconds() < deadline, 'Actual iwd result deadline');
    await step();
  }
}
async function connect() {
  client = createSettingsClient(openDbusClient(address));
  const opening = bridge.open('network');
  await settle(client.call('Connect')); await settle(opening);
}
async function action(action, target) {
  const state = await until(state => state.ready && state.registered && !state.operation && !state.refreshing);
  return settle(client.call('NetworkAction', JSON.stringify({ revision: state.revision,
    target: target || state.devices[0].id, action })));
}
try {
  await connect();
  let state = await until(state => state.ready && state.registered);
  const id = state.networks[0].id;
  await action('power-off');
  await until(state => !state.operation && !state.refreshing && !state.devices[0].powered);
  client.close(); bridge.exited({ pid: expectedProcessId });
  await connect();
  check(!(await read()).devices[0].powered, 'Reopened Settings reads actual retained radio state');
  await action('power-on'); await until(state => state.devices[0].powered && !state.operation && !state.refreshing);
  await action('scan'); await until(state => !state.operation && !state.refreshing);
  await action('connect', id); state = await until(state => state.authentication !== null);
  await settle(client.call('ReplyNetworkAuthentication', JSON.stringify({ token: state.authentication.id, user: null, password: null })));
  await until(state => !state.operation && !state.refreshing);
  await action('connect', id); state = await until(state => state.authentication !== null);
  await settle(client.call('ReplyNetworkAuthentication', JSON.stringify({
    token: state.authentication.id, user: '', password: 'testpass' })));
  await until(state => !state.operation && state.networks[0].connected && state.networks[0].known);
  await settle(client.call('DetachNetwork'));
  check((await read()).networks[0].connected, 'Detaching Settings does not disconnect an established network');
  await action('disconnect'); await until(state => !state.operation && !state.networks[0].connected && !state.refreshing);
  await action('forget', id); await until(state => !state.operation && !state.networks[0].known && !state.refreshing);
  check(!reports.some(value => value.includes('testpass')), 'Credentials never enter diagnostics');
  print('PASS: Settings scalar IPC + real root-owned synthetic iwd, radio/reopen/scan/auth-cancel/connect/disconnect/forget');
} finally {
  client?.close(); bridge.close(); presentation.close(); network.stopNetwork();
  timers.clear(); Object.assign(globalThis, original); dispose();
}
