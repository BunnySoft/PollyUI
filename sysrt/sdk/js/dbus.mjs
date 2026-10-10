import { alloc, platform } from 'sysrt:ffi';
import { loadNativeApi } from './sysrt/sdk/js/native.mjs';
import { monotonicNanoseconds } from './sysrt/sdk/js/clock.mjs';
import { dbusBindings, dbusConstants as C } from './sysrt/bindings/dbus.mjs';

let native;
const clients = new Set();

export function createDbusApi() {
  if (!dbusBindings[platform]) throw new Error('D-Bus SDK is unavailable on ' + platform);
  return loadNativeApi(dbusBindings[platform]);
}

/**
 * Explicit process-library teardown, only when the application exclusively
 * owns ALL libdbus users (including any other realms/native code). Never call
 * this during another libdbus user's work. SDK clients must already be closed.
 * Per-client close intentionally keeps the library loaded: dlclose without
 * dbus_shutdown would orphan libdbus's global caches.
 */
export function shutdownDbus() {
  if (clients.size) throw failure('ERR_DBUS_BUSY', 'Close all SDK D-Bus clients before library shutdown');
  if (!native) return;
  native.dbus_shutdown();
  native.dispose();
  native = undefined;
}

function failure(code, message, dbusName = null) {
  const error = new Error(message);
  error.code = code;
  error.dbusName = dbusName;
  return error;
}

function text(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\0'))
    throw new TypeError(label + ' requires a nonempty string without NUL');
}

/**
 * Linux x86_64 private connection to an explicit address, never the ambient bus.
 * Opening/authentication/Hello are synchronous setup; RPC waiting is not.
 * Schedule ticket.poll() on the application's event loop: each poll performs
 * one zero-wait read/write/dispatch step, without callbacks or worker threads.
 * Close in the application's teardown/finally, then shutdownDbus() when the
 * process-wide exclusive-library precondition holds. Opaque objects are never
 * adopted with guessed extents. Cancellation only discards the local result,
 * not remote side effects. Terminal outcomes remain stable after close/cancel.
 * Only one uint32 argument and one uint32 reply are supported. Known remote
 * error names are matched natively; arbitrary names/text are not read through
 * unbounded borrowed pointers. Setup failures omit libdbus error strings.
 * Poll enforces the caller's monotonic deadline, since zero-wait libdbus I/O
 * alone does not drive its timeout handlers. This is ERR_DBUS_TIMEOUT, not a
 * fabricated remote NoReply. Poll after the deadline discards even a late reply.
 */
export function openDbusClient(address) {
  text(address, 'D-Bus address');
  const api = native ??= createDbusApi(), pending = new Set();
  let connection = null, closed = false;
  const value = (name, ...args) => api[name](...args).value;
  function release(name, pointer) {
    try { value(name, pointer); } finally { pointer.close(); }
  }
  try {
    connection = value('dbus_connection_open_private', address, null);
    if (connection === null) throw failure('ERR_DBUS_OPEN', 'Cannot open the explicit D-Bus address');
    value('dbus_connection_set_exit_on_disconnect', connection, 0);
    if (!value('dbus_bus_register', connection, null))
      throw failure('ERR_DBUS_REGISTER', 'D-Bus authentication/Hello failed');
  } catch (error) {
    if (connection !== null) {
      try { value('dbus_connection_close', connection); }
      finally { release('dbus_connection_unref', connection); }
    }
    throw error;
  }
  function close(error = failure('ERR_DBUS_CLOSED', 'D-Bus client is closed')) {
    if (closed) return;
    closed = true;
    try {
      for (const operation of pending) operation.finish(Object.freeze({ state: 'error', error }), true);
      value('dbus_connection_close', connection);
    } finally {
      try { release('dbus_connection_unref', connection); }
      finally { connection = null; clients.delete(client); }
    }
  }
  function live() {
    if (closed) throw failure('ERR_DBUS_CLOSED', 'D-Bus client is closed');
    if (!value('dbus_connection_get_is_connected', connection)) {
      const error = failure('ERR_DBUS_DISCONNECTED', 'D-Bus connection is disconnected');
      close(error);
      throw error;
    }
  }
  function decode(reply) {
    const type = value('dbus_message_get_type', reply);
    if (type === C.MESSAGE_ERROR) {
      const names = ['NoReply', 'Disconnected', 'ServiceUnknown', 'UnknownMethod',
        'AccessDenied', 'InvalidArgs', 'Failed'];
      const name = names.map(name => 'org.freedesktop.DBus.Error.' + name)
        .find(name => value('dbus_message_is_error', reply, name)) ?? null;
      return Object.freeze({ state: 'error', error: failure('ERR_DBUS_REMOTE',
        name ?? 'Remote D-Bus error (arbitrary name/text decoding is unsupported)', name) });
    }
    if (type !== C.MESSAGE_METHOD_RETURN || !value('dbus_message_has_signature', reply, 'u'))
      throw failure('ERR_DBUS_SIGNATURE', 'Expected exactly one uint32 D-Bus method return');
    const iter = api.createRecord('messageIter');
    let output;
    try {
      output = alloc(4);
      if (!value('dbus_message_iter_init', reply, iter.pointer))
        throw failure('ERR_DBUS_SIGNATURE', 'D-Bus reply has no argument');
      value('dbus_message_iter_get_basic', iter.pointer, output);
      const number = new DataView(output.read(4)).getUint32(0, true);
      return Object.freeze({ state: 'reply', value: number });
    } finally { output?.close(); iter.close(); }
  }
  const client = Object.freeze({
    callUint32(target, argument, timeoutMs = 25000) {
      live();
      if (!target || typeof target !== 'object' || Array.isArray(target) ||
          Object.keys(target).some(key => !['destination', 'path', 'interface', 'member'].includes(key)))
        throw new TypeError('D-Bus target requires destination, path, interface and member');
      const destination = target.destination, path = target.path;
      const interfaceName = target.interface, member = target.member;
      for (const [key, validator] of [
        [destination, 'dbus_validate_bus_name'], [path, 'dbus_validate_path'],
        [interfaceName, 'dbus_validate_interface'], [member, 'dbus_validate_member'],
      ]) {
        text(key, validator);
        live();
        if (!value(validator, key, null)) throw new TypeError('Invalid D-Bus target: ' + key);
      }
      if (!Number.isInteger(argument) || argument < 0 || argument > 0xffffffff)
        throw new RangeError('D-Bus argument must be uint32');
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 0x7fffffff)
        throw new RangeError('D-Bus timeout must be a positive int32 number of milliseconds');
      live();
      let message = null, iter, input, slot, handle = null;
      let deadline;
      try {
        message = value('dbus_message_new_method_call',
          destination, path, interfaceName, member);
        if (message === null) throw failure('ERR_DBUS_MEMORY', 'Cannot allocate D-Bus method call');
        iter = api.createRecord('messageIter');
        input = alloc(4); slot = alloc(8);
        const bytes = new ArrayBuffer(4);
        new DataView(bytes).setUint32(0, argument, true); input.write(bytes);
        value('dbus_message_iter_init_append', message, iter.pointer);
        if (!value('dbus_message_iter_append_basic', iter.pointer, C.TYPE_UINT32, input))
          throw failure('ERR_DBUS_MEMORY', 'Cannot append D-Bus uint32 argument');
        deadline = monotonicNanoseconds() + BigInt(timeoutMs) * 1000000n;
        const sent = value('dbus_connection_send_with_reply', connection, message, slot, timeoutMs);
        handle = slot.readPointer();
        if (!sent || handle === null) throw failure('ERR_DBUS_SEND', 'D-Bus request was not accepted');
      } catch (error) {
        if (handle !== null) {
          try { value('dbus_pending_call_cancel', handle); }
          finally { release('dbus_pending_call_unref', handle); }
        }
        throw error;
      } finally {
        slot?.close(); input?.close(); iter?.close();
        if (message !== null) release('dbus_message_unref', message);
      }
      let outcome = Object.freeze({ state: 'pending' });
      const operation = {
        finish(result, cancel = false) {
          if (outcome.state !== 'pending') return outcome;
          outcome = result;
          pending.delete(operation);
          try {
            try { if (cancel) value('dbus_pending_call_cancel', handle); }
            finally { release('dbus_pending_call_unref', handle); }
          } catch (error) {
            outcome = Object.freeze({ state: 'error', error });
            throw error;
          } finally { handle = null; }
          return outcome;
        },
      };
      pending.add(operation);
      return Object.freeze({
        poll() {
          if (outcome.state !== 'pending') return outcome;
          let reply = null, result, cancel = false, disconnected = false;
          try {
            if (monotonicNanoseconds() >= deadline) {
              result = Object.freeze({ state: 'error', error:
                failure('ERR_DBUS_TIMEOUT', 'D-Bus request exceeded its caller-specified deadline') });
              cancel = true;
            } else {
              value('dbus_connection_read_write_dispatch', connection, 0);
              if (value('dbus_pending_call_get_completed', handle)) {
                reply = value('dbus_pending_call_steal_reply', handle);
                if (reply === null) throw failure('ERR_DBUS_REPLY', 'Completed D-Bus call has no reply');
                result = decode(reply);
              } else {
                disconnected = !value('dbus_connection_get_is_connected', connection);
              }
            }
          } catch (error) {
            result = Object.freeze({ state: 'error', error }); cancel = true;
          } finally { if (reply !== null) release('dbus_message_unref', reply); }
          if (disconnected) close(failure('ERR_DBUS_DISCONNECTED', 'D-Bus connection is disconnected'));
          return result ? operation.finish(result, cancel) : outcome;
        },
        cancel() {
          return operation.finish(Object.freeze({ state: 'cancelled' }), true);
        },
      });
    },
    close() { close(); },
  });
  clients.add(client);
  return client;
}
