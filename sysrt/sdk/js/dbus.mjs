import { alloc, allocPointers, maxBytes, platform } from 'sysrt:ffi';
import { loadNativeApi } from './sysrt/sdk/js/native.mjs';
import { monotonicNanoseconds } from './sysrt/sdk/js/clock.mjs';
import { encodeUtf8 } from './sysrt/sdk/js/encoding.mjs';
import { dbusBindings, dbusConstants as C, dbusStringBindings } from './sysrt/bindings/dbus.mjs';

let native, strings;
const endpoints = new Set();

export function createDbusApi() {
  if (!dbusBindings[platform]) throw new Error('D-Bus SDK is unavailable on ' + platform);
  return loadNativeApi(dbusBindings[platform]);
}

/**
 * Explicit process-library teardown, only when the application exclusively
 * owns ALL libdbus users (including any other realms/native code). Never call
 * this during another libdbus user's work. SDK endpoints must already be closed.
 * Per-client close intentionally keeps the library loaded: dlclose without
 * dbus_shutdown would orphan libdbus's global caches.
 */
export function shutdownDbus() {
  if (endpoints.size) throw failure('ERR_DBUS_BUSY', 'Close all SDK D-Bus endpoints before library shutdown');
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

const value = (name, ...args) => native[name](...args).value;
function release(name, pointer) {
  try { value(name, pointer); } finally { pointer.close(); }
}
function errorRecord() {
  const record = native.createRecord('error');
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
function closeConnection(connection) {
  try { value('dbus_connection_close', connection); }
  finally { release('dbus_connection_unref', connection); }
}
function openConnection(address) {
  text(address, 'D-Bus address');
  native ??= createDbusApi();
  let connection = null;
  try {
    const diagnostic = errorRecord();
    try {
      connection = value('dbus_connection_open_private', address, diagnostic.pointer);
      if (connection === null) throw readError(diagnostic, 'ERR_DBUS_OPEN', 'Cannot open the explicit D-Bus address');
      value('dbus_connection_set_exit_on_disconnect', connection, 0);
      if (!value('dbus_bus_register', connection, diagnostic.pointer))
        throw readError(diagnostic, 'ERR_DBUS_REGISTER', 'D-Bus authentication/Hello failed');
    } finally { freeError(diagnostic); }
    return connection;
  } catch (error) {
    if (connection !== null) closeConnection(connection);
    throw error;
  }
}
function validateText(input, validator) {
  text(input, validator);
  if (!value(validator, input, null)) throw new TypeError('Invalid D-Bus name/path: ' + input);
}
function validateSignature(signature, request = false) {
  if (typeof signature !== 'string' || !/^[ubso]*$/.test(signature) ||
      (request && signature.length > 1) || !value('dbus_signature_validate', signature, null))
    throw new TypeError('D-Bus supports no argument/one u/b/s/o scalar and a fixed scalar reply tuple');
}
function prepareScalars(signature, args, live) {
  if (!Array.isArray(args) || args.length !== signature.length)
    throw new TypeError('D-Bus arguments must match the signature');
  return Array.from(signature, (type, index) => {
    const argument = args[index];
    live();
    if (type === 'u' && (!Number.isInteger(argument) || argument < 0 || argument > 0xffffffff))
      throw new RangeError('D-Bus argument must be uint32');
    if (type === 'b' && typeof argument !== 'boolean')
      throw new TypeError('D-Bus boolean argument requires a boolean');
    let encoded;
    if (type === 's' || type === 'o') {
      if (typeof argument !== 'string' || argument.includes('\0'))
        throw new TypeError('D-Bus string argument requires a string without NUL');
      encoded = encodeUtf8(argument, maxBytes - 1);
      if (type === 'o' && !value('dbus_validate_path', argument, null))
        throw new TypeError('Invalid D-Bus object path argument');
    }
    return { type, argument, encoded };
  });
}
function appendScalars(message, scalars) {
  if (!scalars.length) return;
  const iter = native.createRecord('messageIter');
  try {
    value('dbus_message_iter_init_append', message, iter.pointer);
    for (const { type, argument, encoded } of scalars) {
      let input, stringSlot;
      try {
        if (encoded) {
          input = alloc(encoded.length + 1); input.write(encoded.buffer);
          stringSlot = allocPointers([input]);
        } else {
          input = alloc(4);
          const bytes = new ArrayBuffer(4);
          new DataView(bytes).setUint32(0, type === 'b' ? Number(argument) : argument, true);
          input.write(bytes);
        }
        if (!value('dbus_message_iter_append_basic', iter.pointer, type.charCodeAt(0), stringSlot ?? input))
          throw failure('ERR_DBUS_MEMORY', 'Cannot append D-Bus scalar argument');
      } finally { stringSlot?.close(); input?.close(); }
    }
  } finally { iter.close(); }
}
function readScalars(message, signature) {
  if (!value('dbus_message_has_signature', message, signature))
    throw failure('ERR_DBUS_SIGNATURE', 'Expected D-Bus signature: ' + signature);
  const values = [];
  if (!signature) return Object.freeze(values);
  const iter = native.createRecord('messageIter');
  let output;
  try {
    output = alloc(8);
    if (!value('dbus_message_iter_init', message, iter.pointer))
      throw failure('ERR_DBUS_SIGNATURE', 'D-Bus message has no argument');
    for (let index = 0; index < signature.length; index++) {
      value('dbus_message_iter_get_basic', iter.pointer, output);
      if (signature[index] === 's' || signature[index] === 'o') {
        const pointer = output.readPointer();
        try { values.push(copyCString(pointer, 'scalar string')); }
        finally { pointer?.close(); }
      } else {
        const number = new DataView(output.read(4)).getUint32(0, true);
        if (signature[index] === 'b' && number !== 0 && number !== 1)
          throw failure('ERR_DBUS_REPLY', 'D-Bus boolean is not canonical');
        values.push(signature[index] === 'b' ? number === 1 : number);
      }
      if (index + 1 < signature.length && !value('dbus_message_iter_next', iter.pointer))
        throw failure('ERR_DBUS_SIGNATURE', 'D-Bus scalar tuple ended early');
    }
    return Object.freeze(values);
  } finally { output?.close(); iter.close(); }
}
function header(message, field) {
  const pointer = value('dbus_message_get_' + field, message);
  try { return pointer === null ? null : copyCString(pointer, field); }
  finally { pointer?.close(); }
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
  const pending = new Set();
  let connection = openConnection(address), closed = false;
  function close(error = failure('ERR_DBUS_CLOSED', 'D-Bus client is closed')) {
    if (closed) return;
    closed = true;
    try {
      for (const operation of pending) operation.finish(Object.freeze({ state: 'error', error }), true);
    } finally {
      try { closeConnection(connection); }
      finally { connection = null; endpoints.delete(client); }
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
    if (type !== C.MESSAGE_METHOD_RETURN)
      throw failure('ERR_DBUS_SIGNATURE', 'Expected D-Bus method return signature: ' + signature);
    const values = readScalars(reply, signature);
    return Object.freeze({ state: 'reply',
      value: values.length === 0 ? undefined : values.length === 1 ? values[0] : values });
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
      validateSignature(signature, true);
      validateSignature(replySignature);
      const scalars = prepareScalars(signature, args, live);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 0x7fffffff)
        throw new RangeError('D-Bus timeout must be a positive int32 number of milliseconds');
      live();
      let message = null, slot, handle = null;
      let deadline;
      try {
        message = value('dbus_message_new_method_call',
          destination, path, interfaceName, member);
        if (message === null) throw failure('ERR_DBUS_MEMORY', 'Cannot allocate D-Bus method call');
        slot = alloc(8);
        appendScalars(message, scalars);
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
        slot?.close();
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
  endpoints.add(client);
  return client;
}

/**
 * Explicit private-bus endpoint with its own connection, one well-known name,
 * fixed path/interface and finite methods: { Member: { signature, replySignature } }.
 * Open/authentication/Hello/name claim are synchronous setup; DO_NOT_QUEUE
 * never replaces or queues behind another owner. No reconnect or discovery.
 * poll() does one zero-wait read/write and pops at most one message, returning
 * a request or null (including discarded control traffic). No native dispatch,
 * callbacks, flush, automatic handlers, Promise responses or timeouts.
 * Requests retain their native message until reply(args=[]), error(name,text)
 * or close(); reply/error are single-use. Replies support empty/u/b/s/o/fixed
 * tuples; inputs are empty/one scalar. Validation failures do not admit a
 * request. Copied, frozen headers/args survive close. sender is a unique-name
 * metadata field, NOT authorization. No pointers/closures/GUI objects cross IPC.
 * "accepted" means only native send acceptance; "suppressed" honors no-reply.
 * Cancellation/disconnect do not roll back side effects or trigger replay.
 * Authentic daemon NameLost/disconnect closes admission, never peer signals.
 * There is no authorization, introspection, general signal API, containers or
 * Unix FD transport; the existing FFI byte bound also applies to scalar text.
 * close() drops retained requests and closes the private connection (releasing
 * its name); subsequent operations fail explicitly. Shutdown is process-wide
 * and exclusive, with the same precondition as for clients.
 */
export function openDbusService(address, options) {
  text(address, 'D-Bus address');
  native ??= createDbusApi();
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some(key => !['name', 'path', 'interface', 'methods'].includes(key)))
    throw new TypeError('D-Bus service requires name, path, interface and methods');
  const name = options.name, path = options.path, interfaceName = options.interface;
  validateText(name, 'dbus_validate_bus_name');
  if (name.startsWith(':')) throw new TypeError('D-Bus service requires a well-known name');
  validateText(path, 'dbus_validate_path');
  validateText(interfaceName, 'dbus_validate_interface');
  const declarations = options.methods, methods = new Map();
  if (!declarations || typeof declarations !== 'object' || Array.isArray(declarations))
    throw new TypeError('D-Bus service methods require a finite declaration object');
  for (const member of Object.keys(declarations)) {
    validateText(member, 'dbus_validate_member');
    const method = declarations[member];
    if (!method || typeof method !== 'object' || Array.isArray(method) ||
        Object.keys(method).some(key => !['signature', 'replySignature'].includes(key)))
      throw new TypeError('D-Bus method requires signature and replySignature');
    const signature = method.signature, replySignature = method.replySignature;
    validateSignature(signature, true); validateSignature(replySignature);
    methods.set(member, { signature, replySignature });
  }
  let connection = openConnection(address), closedError = null;
  const pending = new Set();
  try {
    const diagnostic = errorRecord();
    try {
      const claimed = value('dbus_bus_request_name', connection, name, C.NAME_DO_NOT_QUEUE, diagnostic.pointer);
      if (value('dbus_error_is_set', diagnostic.pointer))
        throw readError(diagnostic, 'ERR_DBUS_NAME', 'D-Bus name claim failed');
      if (claimed !== C.NAME_PRIMARY_OWNER)
        throw failure('ERR_DBUS_NAME_OWNED', 'D-Bus name is not available: ' + name);
    } finally { freeError(diagnostic); }
  } catch (error) { closeConnection(connection); throw error; }
  function close(error = failure('ERR_DBUS_CLOSED', 'D-Bus service is closed')) {
    if (closedError) return;
    closedError = error;
    try { for (const request of pending) request.close(); }
    finally {
      try { closeConnection(connection); }
      finally { connection = null; endpoints.delete(service); }
    }
  }
  function live() {
    if (closedError) throw closedError;
    if (!value('dbus_connection_get_is_connected', connection)) {
      const error = failure('ERR_DBUS_DISCONNECTED', 'D-Bus service connection is disconnected');
      close(error); throw error;
    }
  }
  function send(request, noReply, scalars, errorName, errorText) {
    live();
    if (noReply) return Object.freeze({ state: 'suppressed' });
    const message = errorName
      ? value('dbus_message_new_error', request, errorName, errorText)
      : value('dbus_message_new_method_return', request);
    if (message === null) throw failure('ERR_DBUS_MEMORY', 'Cannot allocate D-Bus response');
    try {
      if (!errorName) appendScalars(message, scalars);
      if (!value('dbus_connection_send', connection, message, null))
        throw failure('ERR_DBUS_SEND', 'D-Bus response was not accepted');
      return Object.freeze({ state: 'accepted' });
    } finally { release('dbus_message_unref', message); }
  }
  const service = Object.freeze({
    poll() {
      live();
      value('dbus_connection_read_write', connection, 0);
      live();
      let message = value('dbus_connection_pop_message', connection);
      if (message === null) return null;
      try {
        if (value('dbus_message_is_signal', message, 'org.freedesktop.DBus', 'NameLost') &&
            header(message, 'sender') === 'org.freedesktop.DBus' &&
            header(message, 'path') === '/org/freedesktop/DBus' &&
            readScalars(message, 's')[0] === name) {
          const error = failure('ERR_DBUS_NAME_LOST', 'D-Bus service lost its name: ' + name);
          close(error); throw error;
        }
        if (value('dbus_message_get_type', message) !== C.MESSAGE_METHOD_CALL) return null;
        const target = Object.freeze({
          destination: header(message, 'destination'), path: header(message, 'path'),
          interface: header(message, 'interface'), member: header(message, 'member'),
        });
        const sender = header(message, 'sender');
        const noReply = Boolean(value('dbus_message_get_no_reply', message));
        const method = methods.get(target.member);
        let invalid;
        if (target.path !== path) invalid = ['UnknownObject', 'Unknown D-Bus object path'];
        else if (target.interface !== interfaceName) invalid = ['UnknownInterface', 'Unknown D-Bus interface'];
        else if (!method) invalid = ['UnknownMethod', 'Unknown D-Bus method'];
        else if (!value('dbus_message_has_signature', message, method.signature))
          invalid = ['InvalidArgs', 'Incorrect D-Bus argument signature'];
        if (invalid) {
          send(message, noReply, [], 'org.freedesktop.DBus.Error.' + invalid[0], invalid[1]);
          return null;
        }
        if (!sender?.startsWith(':') || !value('dbus_validate_bus_name', sender, null))
          throw failure('ERR_DBUS_SENDER', 'Private-bus method has no valid unique sender');
        const args = readScalars(message, method.signature), owned = message;
        let finished = false;
        function active() {
          if (finished) throw failure('ERR_DBUS_REQUEST_CLOSED', 'D-Bus request is already closed');
          live();
        }
        function finish() {
          if (finished) return;
          finished = true; pending.delete(request);
          release('dbus_message_unref', owned);
        }
        const request = Object.freeze({
          target, sender, args, noReply,
          reply(args = []) {
            active();
            const scalars = prepareScalars(method.replySignature, args, active);
            active();
            try { return send(owned, noReply, scalars); } finally { finish(); }
          },
          error(name, message) {
            active(); validateText(name, 'dbus_validate_error_name');
            if (typeof message !== 'string' || message.includes('\0'))
              throw new TypeError('D-Bus error text requires a string without NUL');
            encodeUtf8(message, maxBytes - 1);
            active();
            try { return send(owned, noReply, [], name, message); } finally { finish(); }
          },
          close() { finish(); },
        });
        pending.add(request); message = null;
        return request;
      } finally { if (message !== null) release('dbus_message_unref', message); }
    },
    close() { close(); },
  });
  endpoints.add(service);
  return service;
}
