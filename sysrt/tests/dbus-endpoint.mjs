import { alloc, allocPointers } from 'sysrt:ffi';
import { openDbusEndpoint, createDbusApi, dbusSkipped, shutdownDbus } from './sysrt/sdk/js/dbus.mjs';
import { dbusConstants as C } from './sysrt/bindings/dbus.mjs';
import { loadBindings } from './sysrt/sdk/js/native.mjs';
import { encodeUtf8 } from './sysrt/sdk/js/encoding.mjs';
import { check, refuses, descriptorCount, pause, print, dispose, monotonicNanoseconds } from './sysrt/tests/dbus-endpoint-support.mjs';

const oracle = loadBindings({ library: fixtureLibrary, functions: {
  size: { symbol: 'sr_dbus_size', result: 'size', parameters: ['i32'] },
  constant: { symbol: 'sr_dbus_constant', result: 'i32', parameters: ['i32'] },
} });
const raw = createDbusApi(), initial = descriptorCount(), endpoints = [];
const name = 'org.polly.Test', path = '/org/polly/Test', agentPath = '/org/polly/Agent';
const target = (destination, member, object = path) => ({ destination, path: object, interface: name, member });
let retained, connecting, credential, registeredOwner, observedSignal = false, noReply = false;
let projectionReply = null;
const model = [
  ['/net/connman/iwd/0/1', [[
    'net.connman.iwd.Device', [['Powered', { signature: 'b', value: true }]],
  ]]],
  ['/net/connman/iwd/0/1/net', [[
    'net.connman.iwd.Network', [['Device', { signature: 'o', value: '/net/connman/iwd/0/1' }]],
  ]]],
];
function open(options) { const endpoint = openDbusEndpoint(processChild, options); endpoints.push(endpoint); return endpoint; }
async function wait(ticket, predicate = () => true) {
  const deadline = monotonicNanoseconds() + 10000000000n;
  for (;;) {
    pump();
    const outcome = ticket.poll();
    if (outcome.state !== 'pending' && predicate()) return outcome;
    check(monotonicNanoseconds() < deadline, 'Endpoint fixture deadline');
    collect(); await pause();
  }
}
const provider = open({ objects: [{ path, interface: name, methods: {
  Register: { signature: 'o', replySignature: 's' },
  Connect: { signature: '', replySignature: '' }, Echo: { signature: 'ssv', replySignature: 'ssv' },
  Model: { signature: '', replySignature: 'a{oa{sa{sv}}}' }, Order: { signature: '', replySignature: 'a(on)' },
  Project: { signature: '', replySignature: 'a{sv}' }, Hold: { signature: 's', replySignature: 's' },
  Notify: { signature: '', replySignature: '' },
} }] });
const consumer = open({ objects: [{ path: agentPath, interface: name, accept: sender => sender === provider.uniqueName, methods: {
  Request: { signature: 'os', replySignature: 'ss' },
} }], signals: [{ interface: name, member: 'Changed', signature: 'ssv' },
  { interface: name, member: 'Owner', signature: 'sss', accept: sender => sender === provider.uniqueName }] });
// A native peer supplies a variant outside the deliberately finite JS codec.
// Its measured primitive storage is fixture-only; message ownership remains opaque.
const peer = raw.dbus_connection_open_private(processChild, null).value;
raw.dbus_connection_set_exit_on_disconnect(peer, 0);
check(raw.dbus_bus_register(peer, null).value, 'Native signal peer Hello');
const nativeSignal = loadBindings({ library: 'libdbus-1.so.3', functions: {
  signal: { symbol: 'dbus_message_new_signal', result: 'pointer', parameters: ['cstring', 'cstring', 'cstring'] },
  destination: { symbol: 'dbus_message_set_destination', result: 'u32', parameters: ['pointer', 'cstring'] },
} });
function basic(iter, type, argument) {
  const input = alloc(type === 's' ? argument.length + 1 : 8);
  let slot;
  try {
    if (type === 's') { input.write(encodeUtf8(argument).buffer); slot = allocPointers([input]); }
    else {
      const bytes = new ArrayBuffer(8), view = new DataView(bytes);
      if (type === 't') view.setBigUint64(0, argument, true);
      else view.setUint32(0, Number(argument), true);
      input.write(bytes);
    }
    check(raw.dbus_message_iter_append_basic(iter, type.charCodeAt(0), slot ?? input).value, 'Native basic append');
  } finally { slot?.close(); input.close(); }
}
function container(iter, type, signature, append) {
  const child = raw.createRecord('messageIter');
  let signatureBuffer;
  try {
    if (signature !== null) {
      signatureBuffer = alloc(signature.length + 1); signatureBuffer.write(encodeUtf8(signature).buffer);
    }
    check(raw.dbus_message_iter_open_container(iter, type, signatureBuffer ?? null, child.pointer).value, 'Native container open');
    append(child.pointer);
    check(raw.dbus_message_iter_close_container(iter, child.pointer).value, 'Native container close');
  } finally { signatureBuffer?.close(); child.close(); }
}
function sendProjection(request) {
  // Read the request on a native peer, so no JS request wrapper is bypassed.
  const message = raw.dbus_message_new_method_return(request).value, iter = raw.createRecord('messageIter');
  try {
    raw.dbus_message_iter_init_append(message, iter.pointer);
    container(iter.pointer, C.TYPE_ARRAY, '{sv}', array => {
      for (const [key, type, arg] of [['Wanted', 'b', true], ['Ignored', 't', 42n]]) {
        container(array, C.TYPE_DICT_ENTRY, null, entry => {
          basic(entry, 's', key); container(entry, C.TYPE_VARIANT, type, variant => basic(variant, type, arg));
        });
      }
    });
    check(raw.dbus_connection_send(peer, message, null).value, 'Native projection reply send');
  } finally { iter.close(); raw.dbus_message_unref(message); message.close(); }
}
function pump() {
  for (let i = 0; i < 16; i++) {
    const request = provider.poll();
    if (request) {
      check(request.kind === 'method' && request.sender === consumer.uniqueName, 'Provider sees actual caller unique name');
      switch (request.target.member) {
        case 'Register':
          check(request.args[0] === agentPath, 'Exact agent path');
          registeredOwner = request.sender; request.reply([registeredOwner]); break;
        case 'Connect':
          check(request.sender === registeredOwner, 'Connect uses registered agent connection');
          connecting = request;
          credential = provider.call(target(registeredOwner, 'Request', agentPath), 'os', [agentPath, 'fixture-user'], 'ss', 3000);
          break;
        case 'Echo': request.reply(request.args); break;
        case 'Model': request.reply([model]); break;
        case 'Order': request.reply([[['/net/connman/iwd/0/1/net', -4500], ['/net/connman/iwd/0/1/net2', -10000]]]); break;
        case 'Hold': retained = request; break;
        case 'Notify': noReply = request.noReply; check(request.reply().state === 'suppressed', 'NoReply suppresses response'); break;
        default: throw new Error('Unexpected provider method');
      }
    }
    const incoming = consumer.poll();
    for (const other of endpoints.slice(2)) other.poll();
    if (incoming?.kind === 'signal') {
      check(incoming.args[0] === 'native' && incoming.args[2].signature === 'b' && incoming.args[2].value,
        'Real signal copied with variant tuple');
      observedSignal = true;
    } else if (incoming) {
      check(incoming.sender === provider.uniqueName && incoming.args[1] === 'fixture-user', 'Agent sender and os request');
      incoming.reply(['fixture-user', 'fixture-value']);
      refuses(() => incoming.reply(['again', 'again']), 'ERR_DBUS_REQUEST_CLOSED');
    }
    if (credential) {
      const outcome = credential.poll();
      if (outcome.state !== 'pending') {
        check(outcome.state === 'reply' && outcome.value[1] === 'fixture-value', 'Retained agent ss reply');
        credential = null; connecting.reply(); connecting = null;
      }
    }
    raw.dbus_connection_read_write(peer, 0);
    const message = raw.dbus_connection_pop_message(peer).value;
    if (message !== null) {
      try {
        if (raw.dbus_message_get_type(message).value === C.MESSAGE_METHOD_CALL) sendProjection(message);
      } finally { raw.dbus_message_unref(message); message.close(); }
    }
  }
}
try {
  [72, 32, 2, 4, 4, 8].forEach((size, index) =>
    check(Number(oracle.call('size', index).value) === size, 'Measured native D-Bus ABI ' + index));
  [C.TYPE_INT16, C.TYPE_ARRAY, C.TYPE_STRUCT, C.TYPE_DICT_ENTRY, C.TYPE_VARIANT, C.MESSAGE_SIGNAL]
    .forEach((constant, index) => check(oracle.call('constant', index).value === constant, 'Measured D-Bus constant'));
  const registered = await wait(consumer.call(target(provider.uniqueName, 'Register'), 'o', [agentPath], 's', 3000));
  check(registered.value === consumer.uniqueName, 'Registration returns the same unique connection');
  const connected = await wait(consumer.call(target(provider.uniqueName, 'Connect'), '', [], '', 3000));
  check(connected.state === 'reply' && connected.sender === provider.uniqueName, 'Duplex agent/outgoing RPC completes');
  const intruder = open({});
  const denied = await wait(intruder.call(target(consumer.uniqueName, 'Request', agentPath),
    'os', [agentPath, 'fixture-user'], 'ss'));
  check(denied.error?.dbusName === 'org.freedesktop.DBus.Error.AccessDenied' && denied.error.dbusMessage === null,
    'Agent admission rejects another unique sender without exposing remote error body');
  const forged = nativeSignal.call('signal', path, name, 'Owner').value;
  try {
    check(nativeSignal.call('destination', forged, consumer.uniqueName).value, 'Forged signal destination');
    check(raw.dbus_connection_send(peer, forged, null).value, 'Forged malformed signal send');
  } finally { raw.dbus_message_unref(forged); forged.close(); }
  const tuple = ['device', 'Powered', { signature: 'b', value: false }];
  const echo = await wait(consumer.call(target(provider.uniqueName, 'Echo'), 'ssv', tuple, 'ssv'));
  check(JSON.stringify(echo.value) === JSON.stringify(tuple), 'ssv variant round trip');
  const decoded = await wait(consumer.call(target(provider.uniqueName, 'Model'), '', [], 'a{oa{sa{sv}}}'));
  check(JSON.stringify(decoded.value) === JSON.stringify(model), 'ObjectManager nested dictionaries preserve ordered pairs');
  const ordered = await wait(consumer.call(target(provider.uniqueName, 'Order'), '', [], 'a(on)'));
  check(ordered.value[0][1] === -4500 && ordered.value[1][1] === -10000, 'Signed int16 array of structs');
  const connectionName = 'org.polly.NativeProjection';
  check(raw.dbus_bus_request_name(peer, connectionName, C.NAME_DO_NOT_QUEUE, null).value === C.NAME_PRIMARY_OWNER, 'Native peer name');
  const projected = await wait(consumer.call(target(connectionName, 'Project'), '', [], 'a{sv}', 3000,
    path => path.length !== 1 || path[0] === 'Wanted'));
  check(projected.value[0][1].value === true && projected.value[1][1] === dbusSkipped, 'Explicit projection skips unknown native variant');
  const unprojected = await wait(consumer.call(target(connectionName, 'Project'), '', [], 'a{sv}', 3000));
  check(unprojected.state === 'error' && unprojected.error instanceof TypeError, 'Unprojected unknown native type fails explicitly');
  const signal = nativeSignal.call('signal', path, name, 'Changed').value, iter = raw.createRecord('messageIter');
  try {
    check(nativeSignal.call('destination', signal, consumer.uniqueName).value, 'Signal unique destination');
    raw.dbus_message_iter_init_append(signal, iter.pointer);
    basic(iter.pointer, 's', 'native'); basic(iter.pointer, 's', 'signal');
    container(iter.pointer, C.TYPE_VARIANT, 'b', child => basic(child, 'b', true));
    check(raw.dbus_connection_send(peer, signal, null).value, 'Native signal send');
  } finally { iter.close(); raw.dbus_message_unref(signal); signal.close(); }
  consumer.notify(target(provider.uniqueName, 'Notify'), '', []);
  const held = consumer.call(target(provider.uniqueName, 'Hold'), 's', ['held'], 's', 3000);
  await wait(consumer.call(target(provider.uniqueName, 'Echo'), 'ssv', tuple, 'ssv'), () => retained && observedSignal && noReply);
  collect(); retained.reply(['held']);
  check((await wait(held)).value === 'held', 'Retained request survives unrelated RPC, signal and GC');
  const timed = consumer.call(target(provider.uniqueName, 'Hold'), 's', ['late'], 's', 1);
  pump(); await pause();
  check(timed.poll().error?.code === 'ERR_DBUS_TIMEOUT', 'Monotonic deadline rejects late reply');
  retained.reply(['late']);
  const cancelled = consumer.call(target(provider.uniqueName, 'Hold'), 's', ['cancel'], 's');
  pump(); cancelled.cancel(); collect(); retained.close();
  check(cancelled.poll().state === 'cancelled', 'Local cancellation stable');
  const closing = consumer.call(target(provider.uniqueName, 'Hold'), 's', ['close'], 's');
  pump(); refuses(shutdownDbus, 'ERR_DBUS_BUSY'); provider.close(); consumer.close();
  check(closing.poll().error?.code === 'ERR_DBUS_CLOSED', 'Close resolves retained ticket');
  refuses(() => retained.reply(['closed']), 'ERR_DBUS_REQUEST_CLOSED');
  projectionReply = true;
} finally {
  for (const endpoint of endpoints) endpoint.close();
  raw.dbus_connection_close(peer); raw.dbus_connection_unref(peer); peer.close();
  nativeSignal.close(); raw.dispose(); oracle.close(); shutdownDbus(); collect();
  check(descriptorCount() === initial, 'Endpoint/peer closure restores exact descriptor count');
  if (projectionReply) print('PASS: measured ABI, nested containers, projection, single-connection agent/RPC/signal routing and close/GC/deadline/fd lifecycle');
  dispose();
}
check(projectionReply, 'Protocol fixture completed');
