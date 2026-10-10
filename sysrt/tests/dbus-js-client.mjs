import { alloc, allocPointers } from 'sysrt:ffi';
import { openDbusClient, openDbusService, createDbusApi, shutdownDbus } from './sysrt/sdk/js/dbus.mjs';
import { loadNativeApi } from './sysrt/sdk/js/native.mjs';
import { encodeUtf8 } from './sysrt/sdk/js/encoding.mjs';
import {
  check, refuses, descriptorCount, pause, result, monotonicNanoseconds, dispose,
} from './sysrt/tests/dbus-endpoint-support.mjs';

const name = 'org.polly.JSService', path = '/org/polly/JSService';
const target = member => ({ destination: name, path, interface: name, member });
const baseline = descriptorCount(), clients = [];
let raw, peer, signalApi;
function client() { const connection = openDbusClient(processChild); clients.push(connection); return connection; }
async function call(connection, member, signature = '', args = [], replySignature = '') {
  const outcome = await result(connection.call(target(member), signature, args, replySignature));
  check(outcome.state === 'reply', member + ': ' + outcome.error);
  return outcome.value;
}
async function until(deadline, action) {
  while (monotonicNanoseconds() < deadline) { await action(); await pause(); }
}
try {
  const connection = client();
  refuses(() => openDbusService(processChild, {
    name, path, interface: name, methods: {},
  }), 'ERR_DBUS_NAME_OWNED');
  const headers = await call(connection, 'Headers', '', [], 'usssss');
  check(headers[0] !== expectedProcessId && headers[0] > 0, 'Service and client are real separate processes');
  check(headers[1].startsWith(':') && headers[2] === name && headers[3] === path &&
    headers[4] === name && headers[5] === 'Headers', 'Native destination/path/interface/member/sender');
  const owner = await result(connection.call({
    destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus',
    interface: 'org.freedesktop.DBus', member: 'GetNameOwner',
  }, 's', [headers[1]], 's'));
  check(owner.value === headers[1], 'Copied sender is the actual private-bus unique peer name');
  const initial = await call(connection, 'Count', '', [], 'u');
  check(await call(connection, 'Increment', 'u', [41], 'u') === 42, 'JS -> native -> JS scalar reply');
  check(await call(connection, 'Increment', 'u', [0xffffffff], 'u') === 0, 'Uint32 wire boundary');
  check(await call(connection, 'Toggle', 'b', [true], 'b') === false &&
    await call(connection, 'Toggle', 'b', [false], 'b') === true, 'Canonical boolean');
  for (const text of ['', 'Hello \u4e16\u754c \ud83d\udc07', 'x'.repeat(8192)])
    check(await call(connection, 'Echo', 's', [text], 's') === text, 'Copied UTF-8 scalar round trip');
  check(await call(connection, 'EchoPath', 'o', [path], 'o') === path, 'Object path scalar');
  check(await call(connection, 'Empty') === undefined, 'Empty method/reply');
  const tuple = await call(connection, 'Tuple', '', [], 'ubso');
  check(Object.isFrozen(tuple) && tuple.length === 4 &&
    tuple[0] === 7 && tuple[1] === true && tuple[2] === 'tuple \u20ac' && tuple[3] === path,
    'Fixed scalar tuple');
  await call(connection, 'Once');
  const validated = await call(connection, 'Validate', '', [], 'ubso');
  check(validated[0] === 7 && validated[1] === false && validated[2] === '' && validated[3] === path,
    'Invalid responses are rejected before consuming the request');
  const error = await result(connection.call(target('Fail'), '', [], ''));
  check(error.error?.code === 'ERR_DBUS_REMOTE' &&
    error.error.dbusName === name + '.Failed' && error.error.dbusMessage === 'Explicit JS failure \u20ac',
    'Real JS error response preserves native diagnostic');
  const dropped = await result(connection.call(target('CloseRequest'), '', [], '', 30));
  check(dropped.error?.code === 'ERR_DBUS_TIMEOUT', 'Request close drops the message without a default response');
  for (const [changed, signature, args, errorName] of [
    [{ ...target('Increment'), path: '/unknown' }, 'u', [1], 'UnknownObject'],
    [{ ...target('Increment'), interface: 'org.polly.Unknown' }, 'u', [1], 'UnknownInterface'],
    [target('Unknown'), '', [], 'UnknownMethod'],
    [target('Increment'), 's', ['wrong'], 'InvalidArgs'],
  ]) {
    const invalid = await result(connection.call(changed, signature, args, ''));
    check(invalid.error?.dbusName === 'org.freedesktop.DBus.Error.' + errorName,
      'Native protocol rejection: ' + errorName);
  }
  check(await call(connection, 'Count', '', [], 'u') === initial + 2,
    'Invalid target/signature never reaches the business handler');
  const delay = connection.call(target('Delay'), 'u', [17], 'u');
  const before = monotonicNanoseconds();
  check(delay.poll().state === 'pending' && monotonicNanoseconds() - before < 100000000n,
    'Client poll does not wait for the JS service delay');
  let timerTicks = 0;
  const timer = (async () => { for (let i = 0; i < 10; i++) { await pause(); timerTicks++; } })();
  check(await call(connection, 'Count', '', [], 'u') === initial + 3,
    'Other RPCs progress with a retained JS request');
  const delayed = await result(delay);
  await timer;
  check(delayed.value === 18 && timerTicks === 10, 'Delayed reply and client application timers progress');
  const cancelled = connection.call(target('Delay'), 'u', [50], 'u');
  cancelled.poll();
  check(await call(connection, 'Count', '', [], 'u') === initial + 4, 'Cancellation follows a server side effect');
  const cancellation = cancelled.cancel();
  check(cancellation.state === 'cancelled', 'Client cancellation');
  await until(monotonicNanoseconds() + 350000000n, () => call(connection, 'Count', '', [], 'u'));
  check(cancelled.poll() === cancellation &&
    await call(connection, 'Count', '', [], 'u') === initial + 4, 'Late response cannot revive/replay cancellation');
  const timeout = connection.call(target('Delay'), 'u', [70], 'u', 30);
  timeout.poll();
  check(await call(connection, 'Count', '', [], 'u') === initial + 5, 'Timeout follows a server side effect');
  const timed = await result(timeout);
  check(timed.error?.code === 'ERR_DBUS_TIMEOUT' && timed.error.dbusName === null, 'Local monotonic deadline');
  await until(monotonicNanoseconds() + 350000000n, () => call(connection, 'Count', '', [], 'u'));
  check(timeout.poll() === timed && await call(connection, 'Count', '', [], 'u') === initial + 5,
    'Late response cannot revive/replay timeout');
  const transient = client(), gone = transient.call(target('Delay'), 'u', [90], 'u');
  gone.poll();
  check(await call(transient, 'Count', '', [], 'u') === initial + 6, 'Disconnect follows a server side effect');
  transient.close();
  const closed = gone.poll();
  await until(monotonicNanoseconds() + 350000000n, () => call(connection, 'Count', '', [], 'u'));
  check(closed.error?.code === 'ERR_DBUS_CLOSED' && gone.poll() === closed &&
    await call(connection, 'Count', '', [], 'u') === initial + 6, 'Reply to disconnected caller causes no replay');

  if (fixtureRun === 0) {
    raw = createDbusApi();
    peer = raw.dbus_connection_open_private(processChild, null).value;
    check(peer !== null, 'Independent native peer for no-reply flag');
    raw.dbus_connection_set_exit_on_disconnect(peer, 0);
    check(raw.dbus_bus_register(peer, null).value, 'Native no-reply peer Hello');
    signalApi = loadNativeApi({
      library: 'libdbus-1.so.3',
      functions: {
        newSignal: { symbol: 'dbus_message_new_signal', result: 'pointer', parameters: ['cstring', 'cstring', 'cstring'] },
        setDestination: { symbol: 'dbus_message_set_destination', result: 'u32', parameters: ['pointer', 'cstring'] },
      },
    });
    const spoof = signalApi.dbus_message_new_signal('/org/freedesktop/DBus', 'org.freedesktop.DBus', 'NameLost').value;
    check(spoof !== null, 'Real peer NameLost signal');
    const bytes = encodeUtf8(name), input = alloc(bytes.length + 1);
    let slot, iter;
    try {
      input.write(bytes.buffer); slot = allocPointers([input]); iter = raw.createRecord('messageIter');
      raw.dbus_message_iter_init_append(spoof, iter.pointer);
      check(raw.dbus_message_iter_append_basic(iter.pointer, 115, slot).value, 'Native signal name argument');
      check(signalApi.dbus_message_set_destination(spoof, name).value, 'Signal destination');
      check(raw.dbus_connection_send(peer, spoof, null).value, 'Native peer signal send');
    } finally {
      iter?.close(); slot?.close(); input.close(); raw.dbus_message_unref(spoof); spoof.close();
    }
    for (const member of ['NoReply', 'NoReplyError', 'Unknown', 'Increment']) {
      const message = raw.dbus_message_new_method_call(name, path, name, member).value;
      check(message !== null, 'Native no-reply method allocation');
      try {
        raw.dbus_message_set_no_reply(message, 1);
        check(raw.dbus_connection_send(peer, message, null).value, 'Native no-reply send');
      } finally { raw.dbus_message_unref(message); message.close(); }
    }
    const delivered = monotonicNanoseconds() + 10000000000n;
    while (await call(connection, 'Count', '', [], 'u') < initial + 8) {
      check(monotonicNanoseconds() < delivered, 'No-reply methods delivered');
      raw.dbus_connection_read_write(peer, 0); await pause();
    }
    for (let index = 0; index < 16; index++) {
      raw.dbus_connection_read_write(peer, 0);
      const message = raw.dbus_connection_pop_message(peer).value;
      if (message !== null) {
        try {
          const type = raw.dbus_message_get_type(message).value;
          check(type !== 2 && type !== 3, 'No return/error was sent to the no-reply caller');
        } finally { raw.dbus_message_unref(message); message.close(); }
      }
      await pause();
    }
    const held = connection.call({ ...target('Hold'), destination: name + '.Secondary' },
      's', ['retained \u20ac'], 'u', 1000);
    held.poll();
    const admitted = monotonicNanoseconds() + 10000000000n;
    while (await call(connection, 'HeldCount', '', [], 'u') !== 1) {
      check(monotonicNanoseconds() < admitted, 'Secondary retained request is admitted');
      await pause();
    }
    await call(connection, 'CloseSecondary');
    const dropped = await result(held);
    check(dropped.state === 'error' &&
      (dropped.error.code === 'ERR_DBUS_TIMEOUT' ||
       dropped.error.dbusName === 'org.freedesktop.DBus.Error.NoReply'),
      'Service close yields local timeout or actual daemon NoReply, never a success fallback');
    const missing = await result(connection.call({ ...target('Hold'), destination: name + '.Secondary' },
      's', ['retained \u20ac'], ''));
    check(missing.error?.dbusName === 'org.freedesktop.DBus.Error.ServiceUnknown',
      'Service close releases the well-known name');
  }
  if (fixtureRun === 1) await call(connection, 'Finish');
} finally {
  if (peer) {
    raw.dbus_connection_close(peer); raw.dbus_connection_unref(peer); peer.close();
  }
  signalApi?.dispose();
  raw?.dispose();
  for (const connection of clients) connection.close();
  check(descriptorCount() === baseline, 'JS client native descriptors return to baseline');
  shutdownDbus(); shutdownDbus(); dispose();
}
