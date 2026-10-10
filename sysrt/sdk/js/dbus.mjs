import { alloc, allocPointers, maxBytes, platform } from 'sysrt:ffi';
import { loadNativeApi } from './sysrt/sdk/js/native.mjs';
import { monotonicNanoseconds } from './sysrt/sdk/js/clock.mjs';
import { encodeUtf8 } from './sysrt/sdk/js/encoding.mjs';
import { dbusBindings, dbusConstants as C, dbusStringBindings } from './sysrt/bindings/dbus.mjs';

let native, strings;
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
  strings?.dispose();
  native = strings = undefined;
}

function failure(code, message, dbusName = null, dbusMessage = null) {
  const error = new Error(message);
  error.code = code;
  error.dbusName = dbusName;
  error.dbusMessage = dbusMessage;
  return error;
}

// Only pass pointers with libdbus's valid NUL-string contract, while their
// message/DBusError owner is alive. Native strnlen obtains the real extent;
// memcpy copies that extent into managed memory, never an external FFI read.
function copyCString(pointer, label) {
  if (pointer === null) throw failure('ERR_DBUS_DIAGNOSTIC', 'Missing native D-Bus ' + label);
  const api = strings ??= loadNativeApi(dbusStringBindings);
  const length = Number(api.strnlen(pointer, maxBytes).value);
  if (length === maxBytes)
    throw failure('ERR_DBUS_STRING_OVERFLOW', 'Native D-Bus ' + label + ' exceeds the FFI allocation bound');
  const output = alloc(length + 1);
  let copied;
  try {
    copied = api.memcpy(output, pointer, length + 1).value;
    if (copied === null) throw failure('ERR_DBUS_DIAGNOSTIC', 'Native string copy returned NULL');
    return output.readString(length + 1);
  } finally { copied?.close(); output.close(); }
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
 * call(target, signature, args, replySignature, timeoutMs=25000) accepts no
 * argument or one u/b/s/o scalar, and an empty/scalar/fixed scalar tuple reply.
 * Empty replies have value undefined; tuples have a frozen array value.
 * Strings and native error diagnostics are copied within their owner's lifetime;
 * a string exceeding the existing FFI allocation bound is an explicit overflow.
 * callUint32 is only a compatibility wrapper around this same ticket kernel.
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
  function errorRecord() {
    const record = api.createRecord('error');
    try { value('dbus_error_init', record.pointer); return record; }
    catch (error) { record.close(); throw error; }
  }
  function freeError(record) {
    try { value('dbus_error_free', record.pointer); } finally { record.close(); }
  }
  function readError(record, code, fallback) {
    if (!value('dbus_error_is_set', record.pointer)) return failure(code, fallback);
    const namePointer = record.pointer.readPointer(0), messagePointer = record.pointer.readPointer(8);
    let name;
    try {
      name = copyCString(namePointer, 'error name');
      const message = copyCString(messagePointer, 'error message');
      return failure(code, message, name, message);
    } catch (error) {
      if (error.code !== 'ERR_DBUS_STRING_OVERFLOW') throw error;
      error.code = 'ERR_DBUS_DIAGNOSTIC_OVERFLOW';
      error.dbusName = name ?? null;
      return error;
    } finally { namePointer?.close(); messagePointer?.close(); }
  }
  try {
    const diagnostic = errorRecord();
    try {
      connection = value('dbus_connection_open_private', address, diagnostic.pointer);
      if (connection === null) throw readError(diagnostic, 'ERR_DBUS_OPEN', 'Cannot open the explicit D-Bus address');
      value('dbus_connection_set_exit_on_disconnect', connection, 0);
      if (!value('dbus_bus_register', connection, diagnostic.pointer))
        throw readError(diagnostic, 'ERR_DBUS_REGISTER', 'D-Bus authentication/Hello failed');
    } finally { freeError(diagnostic); }
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
  function decode(reply, signature) {
    const type = value('dbus_message_get_type', reply);
    if (type === C.MESSAGE_ERROR) {
      const diagnostic = errorRecord();
      try {
        if (!value('dbus_set_error_from_message', diagnostic.pointer, reply))
          throw failure('ERR_DBUS_REPLY', 'D-Bus error message has no native diagnostic');
        return Object.freeze({ state: 'error',
          error: readError(diagnostic, 'ERR_DBUS_REMOTE', 'Remote D-Bus error') });
      } finally { freeError(diagnostic); }
    }
    if (type !== C.MESSAGE_METHOD_RETURN || !value('dbus_message_has_signature', reply, signature))
      throw failure('ERR_DBUS_SIGNATURE', 'Expected D-Bus method return signature: ' + signature);
    if (!signature) return Object.freeze({ state: 'reply', value: undefined });
    const iter = api.createRecord('messageIter');
    let output;
    try {
      output = alloc(8);
      if (!value('dbus_message_iter_init', reply, iter.pointer))
        throw failure('ERR_DBUS_SIGNATURE', 'D-Bus reply has no argument');
      const values = [];
      for (let index = 0; index < signature.length; index++) {
        value('dbus_message_iter_get_basic', iter.pointer, output);
        if (signature[index] === 's' || signature[index] === 'o') {
          const pointer = output.readPointer();
          try { values.push(copyCString(pointer, 'reply string')); }
          finally { pointer?.close(); }
        } else {
          const number = new DataView(output.read(4)).getUint32(0, true);
          if (signature[index] === 'b' && number !== 0 && number !== 1)
            throw failure('ERR_DBUS_REPLY', 'D-Bus boolean is not canonical');
          values.push(signature[index] === 'b' ? number === 1 : number);
        }
        if (index + 1 < signature.length && !value('dbus_message_iter_next', iter.pointer))
          throw failure('ERR_DBUS_SIGNATURE', 'D-Bus reply tuple ended early');
      }
      return Object.freeze({ state: 'reply',
        value: values.length === 1 ? values[0] : Object.freeze(values) });
    } finally { output?.close(); iter.close(); }
  }
  const client = Object.freeze({
    call(target, signature, args, replySignature, timeoutMs = 25000) {
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
      if (!['', 'u', 'b', 's', 'o'].includes(signature) ||
          typeof replySignature !== 'string' || !/^[ubso]*$/.test(replySignature))
        throw new TypeError('D-Bus call supports no argument/one u/b/s/o scalar and a fixed scalar reply tuple');
      if (!value('dbus_signature_validate', replySignature, null))
        throw new TypeError('Invalid D-Bus reply signature');
      if (!Array.isArray(args) || args.length !== signature.length)
        throw new TypeError('D-Bus arguments must match the request signature');
      const argument = signature ? args[0] : undefined;
      let encoded;
      if (signature === 'u' && (!Number.isInteger(argument) || argument < 0 || argument > 0xffffffff))
        throw new RangeError('D-Bus argument must be uint32');
      if (signature === 'b' && typeof argument !== 'boolean')
        throw new TypeError('D-Bus boolean argument requires a boolean');
      if (signature === 's' || signature === 'o') {
        if (typeof argument !== 'string' || argument.includes('\0'))
          throw new TypeError('D-Bus string argument requires a string without NUL');
        encoded = encodeUtf8(argument, maxBytes - 1);
        live();
        if (signature === 'o' && !value('dbus_validate_path', argument, null))
          throw new TypeError('Invalid D-Bus object path argument');
      }
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 0x7fffffff)
        throw new RangeError('D-Bus timeout must be a positive int32 number of milliseconds');
      live();
      let message = null, iter, input, stringSlot, slot, handle = null;
      let deadline;
      try {
        message = value('dbus_message_new_method_call',
          destination, path, interfaceName, member);
        if (message === null) throw failure('ERR_DBUS_MEMORY', 'Cannot allocate D-Bus method call');
        slot = alloc(8);
        if (signature) {
          iter = api.createRecord('messageIter');
          if (encoded) {
            input = alloc(encoded.length + 1); input.write(encoded.buffer);
            stringSlot = allocPointers([input]);
          } else {
            input = alloc(4);
            const bytes = new ArrayBuffer(4);
            new DataView(bytes).setUint32(0, signature === 'b' ? Number(argument) : argument, true);
            input.write(bytes);
          }
          value('dbus_message_iter_init_append', message, iter.pointer);
          if (!value('dbus_message_iter_append_basic', iter.pointer, signature.charCodeAt(0), stringSlot ?? input))
            throw failure('ERR_DBUS_MEMORY', 'Cannot append D-Bus scalar argument');
        }
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
        slot?.close(); stringSlot?.close(); input?.close(); iter?.close();
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
                result = decode(reply, replySignature);
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
    callUint32(target, argument, timeoutMs = 25000) {
      return client.call(target, 'u', [argument], 'u', timeoutMs);
    },
    close() { close(); },
  });
  clients.add(client);
  return client;
}
