import { openDbusClient, createDbusApi, shutdownDbus } from './sysrt/sdk/js/dbus.mjs';
import { createNetworkApi } from './sysrt/sdk/js/network.mjs';
import { monotonicNanoseconds, close as closeClock } from './sysrt/sdk/js/clock.mjs';
import { libc } from 'sysrt:ffi';
import { loadBindings } from './sysrt/sdk/js/native.mjs';

function check(value, message) { if (!value) throw new Error(message); }
function refuses(action, code) {
  try { action(); } catch (error) {
    check(code ? error.code === code : error instanceof TypeError || error instanceof RangeError,
      'Unexpected rejection: ' + error);
    return;
  }
  throw new Error('Expected rejection: ' + code);
}
const wait = createNetworkApi(), clients = [];
const directories = loadBindings({
  library: libc === 'glibc' ? 'libc.so.6' : 'libc.musl-x86_64.so.1',
  functions: {
    open: { symbol: 'opendir', result: 'pointer', parameters: ['cstring'] },
    next: { symbol: 'readdir', result: 'pointer', parameters: ['pointer'] },
    close: { symbol: 'closedir', result: 'i32', parameters: ['pointer'] },
  },
});
function descriptorCount() {
  const directory = directories.call('open', '/proc/self/fd').value;
  check(directory !== null, 'Open private process descriptor inventory');
  let count = 0;
  try {
    for (;;) {
      const entry = directories.call('next', directory).value;
      if (entry === null) return count;
      entry.close(); count++;
    }
  } finally {
    check(directories.call('close', directory).value === 0, 'Close descriptor inventory');
    directory.close();
  }
}
const initialDescriptors = descriptorCount();
const pause = async () => {
  check((await wait.async.poll(null, 0, 2)).value === 0, 'Application loop yields between polls');
};
function client() {
  const result = openDbusClient(processChild); clients.push(result); return result;
}
const target = member => ({
  destination: 'org.polly.Test', path: '/org/polly/Test', interface: 'org.polly.Test', member,
});
async function result(ticket, label = 'request') {
  const deadline = monotonicNanoseconds() + 5000000000n;
  let outcome;
  do {
    outcome = ticket.poll();
    if (outcome.state !== 'pending') return outcome;
    check(monotonicNanoseconds() < deadline, 'Private D-Bus test deadline: ' + label);
    await pause();
  } while (true);
}
async function call(connection, member, argument = 0, timeout = 2000) {
  const outcome = await result(connection.callUint32(target(member), argument, timeout), member);
  check(outcome.state === 'reply', member + ': ' + outcome.error);
  return outcome.value;
}

try {
  refuses(() => openDbusClient('unix:path=/nonexistent-polly-private-bus'), 'ERR_DBUS_OPEN');
  refuses(() => openDbusClient(''));
  refuses(() => openDbusClient('bad\0address'));
  const raw = createDbusApi();
  try {
    const iter = raw.createRecord('messageIter');
    check(iter.pointer.read(72).byteLength === 72, 'Measured public iterator storage is bounded');
    iter.close();
    const connection = raw.dbus_connection_open_private(processChild, null).value;
    check(connection !== null, 'Real opaque libdbus connection');
    try {
      refuses(() => connection.read(1), 'ERR_FFI_MEMORY');
      raw.dbus_connection_close(connection);
    } finally { raw.dbus_connection_unref(connection); connection.close(); }
  } finally { raw.dispose(); }

  const connection = client(), initial = await call(connection, 'Count');
  refuses(() => shutdownDbus(), 'ERR_DBUS_BUSY');
  const first = connection.callUint32(target('Increment'), 41);
  const outcome = await result(first);
  check(outcome.state === 'reply' && outcome.value === 42, 'Real JS/config -> libdbus -> private service reply');
  check(first.poll() === outcome && first.cancel() === outcome, 'Consumed reply is stable after cancel');
  check(await call(connection, 'Increment', 0xffffffff) === 0, 'Exact uint32 boundary on the wire');
  const failed = await result(connection.callUint32(target('Fail'), 0));
  check(failed.state === 'error' && failed.error.code === 'ERR_DBUS_REMOTE' &&
    failed.error.dbusName === null, 'Arbitrary remote error is explicit, without unsafe pointer decoding');
  const unknown = await result(connection.callUint32({
    ...target('Increment'), destination: 'org.polly.Missing',
  }, 0));
  check(unknown.state === 'error' && unknown.error.dbusName === 'org.freedesktop.DBus.Error.ServiceUnknown',
    'Native known remote error name is preserved');
  const wrong = await result(connection.callUint32(target('BadReply'), 0));
  check(wrong.state === 'error' && wrong.error.code === 'ERR_DBUS_SIGNATURE', 'Wrong reply signature is rejected');

  const delayed = connection.callUint32(target('Delay'), 17);
  const before = monotonicNanoseconds();
  check(delayed.poll().state === 'pending', 'Slow RPC remains pending');
  check(monotonicNanoseconds() - before < 100000000n, 'Zero-wait poll does not wait for the 250ms remote method');
  check(await call(connection, 'Count') === initial + 3, 'Other requests progress while a reply is delayed');
  const delayedReply = await result(delayed);
  check(delayedReply.state === 'reply' && delayedReply.value === 18, 'Delayed response is delivered by later polls');

  const timeout = connection.callUint32(target('Hang'), 0, 30);
  const timed = await result(timeout, 'Hang timeout');
  check(timed.state === 'error' && timed.error.code === 'ERR_DBUS_TIMEOUT' && timed.error.dbusName === null,
    'Caller deadline is an explicit local timeout, not a fabricated native NoReply');
  check(timeout.poll() === timed && timeout.cancel() === timed, 'Timeout is terminal');

  const cancelled = connection.callUint32(target('Delay'), 50);
  cancelled.poll();
  check(await call(connection, 'Count') === initial + 5, 'Cancellation test request reached remote side effect');
  const cancellation = cancelled.cancel();
  check(cancellation.state === 'cancelled' && cancelled.cancel() === cancellation, 'Cancel is idempotent');
  const due = monotonicNanoseconds() + 350000000n;
  while (monotonicNanoseconds() < due) {
    await call(connection, 'Count');
    await pause();
  }
  check(cancelled.poll() === cancellation, 'Late remote reply cannot revive a cancelled ticket');
  check(await call(connection, 'Count') === initial + 5, 'Cancel does not claim to roll back remote effects');

  const closing = connection.callUint32(target('Hang'), 0);
  closing.poll();
  const countBeforeClose = await call(connection, 'Count');
  check(countBeforeClose === initial + 6, 'Close test request reached remote side effect');
  connection.close(); connection.close();
  const closedResult = closing.poll();
  check(closedResult.state === 'error' && closedResult.error.code === 'ERR_DBUS_CLOSED' &&
    closing.cancel() === closedResult && closing.poll() === closedResult, 'Close cancels/releases pending calls once');
  check(first.poll() === outcome, 'Completed result survives client close');
  refuses(() => connection.callUint32(target('Increment'), 0), 'ERR_DBUS_CLOSED');
  const reopened = client();
  check(await call(reopened, 'Count') === countBeforeClose, 'Fresh connection does not replay closed requests');
  check(await call(reopened, 'Increment', 1) === 2, 'Fresh connection can explicitly send a new request');
  for (const changed of [
    { ...target('Increment'), destination: 'bad destination' },
    { ...target('Increment'), path: 'relative' },
    { ...target('Increment'), interface: 'bad' },
    { ...target('Increment'), member: 'bad.member' },
    { ...target('Increment'), member: 'bad\0member' },
  ]) refuses(() => reopened.callUint32(changed, 0));
  refuses(() => reopened.callUint32(target('Increment'), -1));
  refuses(() => reopened.callUint32(target('Increment'), 0x100000000));
  refuses(() => reopened.callUint32(target('Increment'), 0, 0));
  let memberReads = 0;
  const changingTarget = { ...target('Increment'), get member() {
    memberReads++; return memberReads === 1 ? 'Increment' : 'bad.member';
  } };
  check((await result(reopened.callUint32(changingTarget, 10))).value === 11 && memberReads === 1,
    'Validate and call the same target snapshot');
  const reentrant = client();
  const closesDuringRead = { ...target('Count'), get member() {
    reentrant.close(); return 'Count';
  } };
  refuses(() => reentrant.callUint32(closesDuringRead, 0), 'ERR_DBUS_CLOSED');

  const readyButUnconsumed = reopened.callUint32(target('Increment'), 70);
  await call(reopened, 'Count');
  const discarded = readyButUnconsumed.cancel();
  check(discarded.state === 'cancelled' && readyButUnconsumed.poll() === discarded,
    'Cancellation wins before SDK consumption even when a native reply is already available');
  const late = reopened.callUint32(target('Increment'), 80, 1);
  const expire = monotonicNanoseconds() + 10000000n;
  while (monotonicNanoseconds() < expire) await pause();
  const expired = late.poll();
  check(expired.state === 'error' && expired.error.code === 'ERR_DBUS_TIMEOUT',
    'Poll after caller deadline cannot consume an unobserved late reply');
  const lateClose = reopened.callUint32(target('Delay'), 90);
  lateClose.poll();
  const beforeLateClose = await call(reopened, 'Count');
  reopened.close();
  const closeOutcome = lateClose.poll();
  const observer = client();
  const afterClose = monotonicNanoseconds() + 350000000n;
  while (monotonicNanoseconds() < afterClose) {
    await call(observer, 'Count'); await pause();
  }
  check(closeOutcome.error.code === 'ERR_DBUS_CLOSED' && lateClose.poll() === closeOutcome &&
    await call(observer, 'Count') === beforeLateClose,
    'Late reply after close cannot revive or replay an accepted request');
  for (let index = 0; index < 16; index++) {
    const temporary = client();
    const ticket = temporary.callUint32(target('Count'), 0);
    ticket.cancel(); temporary.close();
    check(ticket.poll().state === 'cancelled', 'Repeated connection and pending cleanup');
  }
} finally {
  for (const connection of clients) connection.close();
  check(descriptorCount() === initialDescriptors, 'All native connection descriptors are released');
  shutdownDbus(); shutdownDbus();
  directories.close();
  wait.dispose(); closeClock();
}
