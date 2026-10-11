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
  return prepareArguments(signature, args, live);
}
function appendScalars(message, scalars) {
  appendArguments(message, scalars);
}
function readScalars(message, signature) {
  return readArguments(message, signature);
}

// This is a deliberately finite protocol subset, not introspection or a general
// D-Bus type system. Dictionary values are ordered pairs (duplicates stay visible).
// Variants are { signature, value }; a projection may explicitly skip an unused
// value before recursing, including native types outside this subset.
export const dbusSkipped = Object.freeze({ skipped: true });
function protocolSignature(signature) {
  if (typeof signature !== 'string' || !value('dbus_signature_validate', signature, null))
    throw new TypeError('Invalid D-Bus signature');
  let offset = 0;
  function node(dictAllowed = false) {
    const start = offset, type = signature[offset++];
    let children = [];
    if ('nubso'.includes(type ?? '\0') || type === 'v') { /* basic or variant */ }
    else if (type === 'a') children = [node(true)];
    else if (type === '(' || (type === '{' && dictAllowed)) {
      const end = type === '(' ? ')' : '}';
      while (offset < signature.length && signature[offset] !== end) children.push(node());
      if (signature[offset++] !== end || !children.length ||
          (type === '{' && (children.length !== 2 || !'nubso'.includes(children[0].type))))
        throw new TypeError('Unsupported D-Bus container');
    } else throw new TypeError('Unsupported D-Bus type: ' + type);
    return { type, children, signature: signature.slice(start, offset) };
  }
  const nodes = [];
  while (offset < signature.length) nodes.push(node());
  return nodes;
}
function prepareArguments(signature, args, live) {
  function tuple(nodes, items) {
    if (!Array.isArray(items) || items.length !== nodes.length)
      throw new TypeError('D-Bus arguments must match the signature');
    return nodes.map((node, index) => prepare(node, items[index]));
  }
  function prepare(node, argument) {
    live();
    const { type } = node;
    let encoded, children;
    if (type === 'a') {
      if (!Array.isArray(argument)) throw new TypeError('D-Bus array requires an array');
      children = argument.map(item => prepare(node.children[0], item));
    } else if (type === '(' || type === '{') children = tuple(node.children, argument);
    else if (type === 'v') {
      if (!argument || typeof argument !== 'object' || Array.isArray(argument) ||
          Object.keys(argument).some(key => !['signature', 'value'].includes(key)))
        throw new TypeError('D-Bus variant requires signature and value');
      const nodes = protocolSignature(argument.signature);
      if (nodes.length !== 1) throw new TypeError('D-Bus variant requires exactly one type');
      children = [prepare(nodes[0], argument.value)];
    } else if (type === 'n' || type === 'u') {
      const min = type === 'n' ? -32768 : 0, max = type === 'n' ? 32767 : 0xffffffff;
      if (!Number.isInteger(argument) || argument < min || argument > max)
        throw new RangeError('D-Bus argument is outside ' + type + ' range');
    } else if (type === 'b') {
      if (typeof argument !== 'boolean') throw new TypeError('D-Bus boolean requires a boolean');
    } else {
      if (typeof argument !== 'string' || argument.includes('\0'))
        throw new TypeError('D-Bus string requires a string without NUL');
      encoded = encodeUtf8(argument, maxBytes - 1);
      if (type === 'o' && !value('dbus_validate_path', argument, null))
        throw new TypeError('Invalid D-Bus object path argument');
    }
    return { ...node, argument, encoded, prepared: children };
  }
  return tuple(protocolSignature(signature), args);
}
function appendArguments(message, arguments_) {
  function append(iter, item) {
    const { type, argument, encoded, prepared } = item;
    if (prepared) {
      const child = native.createRecord('messageIter');
      let opened = false, signatureBuffer;
      try {
        const contained = type === 'a' ? item.children[0].signature :
          type === 'v' ? prepared[0].signature : null;
        if (contained !== null) {
          const bytes = encodeUtf8(contained, 255);
          signatureBuffer = alloc(bytes.length + 1); signatureBuffer.write(bytes.buffer);
        }
        const nativeType = type === '(' ? C.TYPE_STRUCT : type === '{' ? C.TYPE_DICT_ENTRY : type.charCodeAt(0);
        if (!value('dbus_message_iter_open_container', iter, nativeType, signatureBuffer ?? null, child.pointer))
          throw failure('ERR_DBUS_MEMORY', 'Cannot open D-Bus container');
        opened = true;
        for (const entry of prepared) append(child.pointer, entry);
        if (!value('dbus_message_iter_close_container', iter, child.pointer))
          throw failure('ERR_DBUS_MEMORY', 'Cannot close D-Bus container');
        opened = false;
      } finally {
        try { if (opened) value('dbus_message_iter_abandon_container', iter, child.pointer); }
        finally { signatureBuffer?.close(); child.close(); }
      }
      return;
    }
    let input, slot;
    try {
      if (encoded) {
        input = alloc(encoded.length + 1); input.write(encoded.buffer); slot = allocPointers([input]);
      } else {
        const bytes = new ArrayBuffer(type === 'n' ? 2 : 4), view = new DataView(bytes);
        if (type === 'n') view.setInt16(0, argument, true);
        else view.setUint32(0, type === 'b' ? Number(argument) : argument, true);
        input = alloc(bytes.byteLength); input.write(bytes);
      }
      if (!value('dbus_message_iter_append_basic', iter, type.charCodeAt(0), slot ?? input))
        throw failure('ERR_DBUS_MEMORY', 'Cannot append D-Bus basic argument');
    } finally { slot?.close(); input?.close(); }
  }
  if (!arguments_.length) return;
  const iter = native.createRecord('messageIter');
  try {
    value('dbus_message_iter_init_append', message, iter.pointer);
    for (const item of arguments_) append(iter.pointer, item);
  } finally { iter.close(); }
}
function readArguments(message, signature, projection) {
  if (!value('dbus_message_has_signature', message, signature))
    throw failure('ERR_DBUS_SIGNATURE', 'Expected D-Bus signature: ' + signature);
  function tuple(iter, nodes, path) {
    const values = [];
    for (const node of nodes) {
      values.push(read(iter, node, path));
      value('dbus_message_iter_next', iter);
    }
    if (value('dbus_message_iter_get_arg_type', iter))
      throw failure('ERR_DBUS_SIGNATURE', 'D-Bus tuple has extra arguments');
    return Object.freeze(values);
  }
  function read(iter, node, path) {
    const { type } = node;
    const expected = type === '(' ? C.TYPE_STRUCT : type === '{' ? C.TYPE_DICT_ENTRY : type.charCodeAt(0);
    if (value('dbus_message_iter_get_arg_type', iter) !== expected)
      throw failure('ERR_DBUS_SIGNATURE', 'D-Bus value has incorrect type');
    if (projection && projection(Object.freeze(path), node.signature) === false) return dbusSkipped;
    if (type === 'a' || type === '(' || type === '{' || type === 'v') {
      const child = native.createRecord('messageIter');
      try {
        value('dbus_message_iter_recurse', iter, child.pointer);
        if (type === 'a') {
          const entries = [];
          while (value('dbus_message_iter_get_arg_type', child.pointer)) {
            entries.push(read(child.pointer, node.children[0], path));
            value('dbus_message_iter_next', child.pointer);
          }
          return Object.freeze(entries);
        }
        if (type === '{') {
          const key = read(child.pointer, node.children[0], path);
          value('dbus_message_iter_next', child.pointer);
          const entry = read(child.pointer, node.children[1], [...path, key]);
          value('dbus_message_iter_next', child.pointer);
          if (value('dbus_message_iter_get_arg_type', child.pointer))
            throw failure('ERR_DBUS_SIGNATURE', 'D-Bus dictionary entry has extra values');
          return Object.freeze([key, entry]);
        }
        if (type === '(') return tuple(child.pointer, node.children, path);
        const pointer = value('dbus_message_iter_get_signature', child.pointer);
        let contained;
        try { contained = copyCString(pointer, 'variant signature'); }
        finally { if (pointer !== null) release('dbus_free', pointer); }
        const nodes = protocolSignature(contained);
        if (nodes.length !== 1) throw failure('ERR_DBUS_SIGNATURE', 'D-Bus variant has invalid signature');
        return Object.freeze({ signature: contained, value: tuple(child.pointer, nodes, path)[0] });
      } finally { child.close(); }
    }
    const output = alloc(8);
    try {
      value('dbus_message_iter_get_basic', iter, output);
      if (type === 's' || type === 'o') {
        const pointer = output.readPointer();
        try { return copyCString(pointer, 'basic string'); }
        finally { pointer?.close(); }
      }
      if (type === 'n') return new DataView(output.read(2)).getInt16(0, true);
      const number = new DataView(output.read(4)).getUint32(0, true);
      if (type === 'b' && number !== 0 && number !== 1)
        throw failure('ERR_DBUS_REPLY', 'D-Bus boolean is not canonical');
      return type === 'b' ? number === 1 : number;
    } finally { output.close(); }
  }
  const nodes = protocolSignature(signature);
  if (!nodes.length) return Object.freeze([]);
  const iter = native.createRecord('messageIter');
  try {
    if (!value('dbus_message_iter_init', message, iter.pointer))
      throw failure('ERR_DBUS_SIGNATURE', 'D-Bus message has no argument');
    return tuple(iter.pointer, nodes, []);
  } finally { iter.close(); }
}
function header(message, field) {
  const pointer = value('dbus_message_get_' + field, message);
  try { return pointer === null ? null : copyCString(pointer, field); }
  finally { pointer?.close(); }
}

/**
 * One explicit private connection for calls, declared signals and exported
 * objects addressed by its unique name (no well-known name claim). poll() is
 * the sole zero-wait reader and pops at most one message. It routes replies to
 * tickets and returns a copied signal or retained method request, otherwise
 * null. Ticket.poll() checks outcome/deadline only; drive endpoint.poll() too.
 * The scalar adapters below retain their existing narrower contracts.
 *
 * Supports n/u/b/s/o, arrays, structs, dictionaries and variants. An optional
 * reply/signal projection(path, signature) can explicitly skip unused values
 * before native iterator recursion. No implicit unsupported-type defaults.
 * Replies expose sender and error name, not arbitrary remote diagnostic bodies.
 * Cancellation discards local results only. Requests are once-reply/error/close.
 * Closing resolves all tickets and drops all retained native messages before
 * releasing the connection. No native dispatch, filter or retained callback.
 */
export function openDbusEndpoint(address, options = {}) {
  native ??= createDbusApi();
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some(key => !['objects', 'signals', 'limits'].includes(key)))
    throw new TypeError('D-Bus endpoint requires objects, signals and optional native limits');
  const objects = new Map(), signals = new Map();
  for (const declaration of options.objects ?? []) {
    const { path, interface: interfaceName, methods, accept } = declaration;
    validateText(path, 'dbus_validate_path'); validateText(interfaceName, 'dbus_validate_interface');
    if (!methods || typeof methods !== 'object' || Array.isArray(methods))
      throw new TypeError('D-Bus object requires finite method declarations');
    if (accept !== undefined && typeof accept !== 'function')
      throw new TypeError('D-Bus admission predicate must be a function');
    const declared = new Map();
    for (const [member, method] of Object.entries(methods)) {
      validateText(member, 'dbus_validate_member');
      protocolSignature(method.signature); protocolSignature(method.replySignature);
      declared.set(member, { signature: method.signature, replySignature: method.replySignature });
    }
    const key = path + '\n' + interfaceName;
    if (objects.has(key)) throw new TypeError('Duplicate D-Bus object declaration');
    objects.set(key, { methods: declared, accept });
  }
  for (const signal of options.signals ?? []) {
    validateText(signal.interface, 'dbus_validate_interface'); validateText(signal.member, 'dbus_validate_member');
    protocolSignature(signal.signature);
    if (signal.projection !== undefined && typeof signal.projection !== 'function')
      throw new TypeError('D-Bus projection must be a function');
    if (signal.accept !== undefined && typeof signal.accept !== 'function')
      throw new TypeError('D-Bus admission predicate must be a function');
    const key = signal.interface + '\n' + signal.member;
    if (signals.has(key)) throw new TypeError('Duplicate D-Bus signal declaration');
    signals.set(key, { signature: signal.signature, projection: signal.projection, accept: signal.accept });
  }
  const limits = options.limits ?? {};
  for (const key of Object.keys(limits)) {
    if (!['receivedBytes', 'messageBytes', 'receivedFDs', 'messageFDs', 'outgoingBytes'].includes(key) ||
        !Number.isSafeInteger(limits[key]) || limits[key] < 0 ||
        (key.endsWith('Bytes') && !limits[key]))
      throw new TypeError('Invalid native D-Bus connection limit');
  }
  let connection = openConnection(address), closedError = null;
  const tickets = new Map(), requests = new Set();
  let uniqueName;
  try {
    for (const [key, method] of [
      ['receivedBytes', 'dbus_connection_set_max_received_size'],
      ['messageBytes', 'dbus_connection_set_max_message_size'],
      ['receivedFDs', 'dbus_connection_set_max_received_unix_fds'],
      ['messageFDs', 'dbus_connection_set_max_message_unix_fds'],
    ]) if (limits[key] !== undefined) value(method, connection, BigInt(limits[key]));
    const pointer = value('dbus_bus_get_unique_name', connection);
    try { uniqueName = copyCString(pointer, 'unique name'); }
    finally { pointer?.close(); }
  } catch (error) { closeConnection(connection); throw error; }
  function close(error = failure('ERR_DBUS_CLOSED', 'D-Bus endpoint is closed')) {
    if (closedError) return;
    closedError = error;
    try {
      for (const ticket of tickets.values()) ticket.finish(Object.freeze({ state: 'error', error }));
      for (const request of requests) request.close();
    } finally {
      try { closeConnection(connection); }
      finally { connection = null; endpoints.delete(endpoint); }
    }
  }
  function live() {
    if (closedError) throw closedError;
    if (!value('dbus_connection_get_is_connected', connection)) {
      const error = failure('ERR_DBUS_DISCONNECTED', 'D-Bus connection is disconnected');
      close(error); throw error;
    }
  }
  function send(message, serial = null) {
    live();
    if (limits.outgoingBytes !== undefined &&
        value('dbus_connection_get_outgoing_size', connection) >= BigInt(limits.outgoingBytes))
      throw failure('ERR_DBUS_QUEUE', 'Native D-Bus outgoing queue is full');
    if (!value('dbus_connection_send', connection, message, serial))
      throw failure('ERR_DBUS_SEND', 'D-Bus message was not accepted');
  }
  function respond(message, noReply, args, name, diagnostic) {
    live();
    if (noReply) return Object.freeze({ state: 'suppressed' });
    const reply = name ? value('dbus_message_new_error', message, name, diagnostic) :
      value('dbus_message_new_method_return', message);
    if (reply === null) throw failure('ERR_DBUS_MEMORY', 'Cannot allocate D-Bus response');
    try {
      if (!name) appendArguments(reply, args);
      send(reply); return Object.freeze({ state: 'accepted' });
    } finally { release('dbus_message_unref', reply); }
  }
  const endpoint = Object.freeze({
    uniqueName,
    call(target, signature, args, replySignature, timeoutMs = 25000, projection) {
      live();
      for (const [field, validator] of [
        ['destination', 'dbus_validate_bus_name'], ['path', 'dbus_validate_path'],
        ['interface', 'dbus_validate_interface'], ['member', 'dbus_validate_member'],
      ]) validateText(target?.[field], validator);
      protocolSignature(replySignature);
      if (projection !== undefined && typeof projection !== 'function')
        throw new TypeError('D-Bus projection must be a function');
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 0x7fffffff)
        throw new RangeError('D-Bus timeout must be a positive int32 number of milliseconds');
      const prepared = prepareArguments(signature, args, live);
      const message = value('dbus_message_new_method_call',
        target.destination, target.path, target.interface, target.member);
      if (message === null) throw failure('ERR_DBUS_MEMORY', 'Cannot allocate D-Bus method call');
      const slot = alloc(4);
      let serial;
      try {
        appendArguments(message, prepared); send(message, slot);
        serial = new DataView(slot.read(4)).getUint32(0, true);
      } finally { slot.close(); release('dbus_message_unref', message); }
      if (!serial || tickets.has(serial)) throw failure('ERR_DBUS_SERIAL', 'Invalid D-Bus request serial');
      const deadline = monotonicNanoseconds() + BigInt(timeoutMs) * 1000000n;
      const destination = target.destination;
      let outcome = Object.freeze({ state: 'pending' }), reply = null;
      const operation = {
        finish(result) {
          if (outcome.state !== 'pending') return outcome;
          outcome = result; tickets.delete(serial);
          if (reply !== null) { release('dbus_message_unref', reply); reply = null; }
          return outcome;
        },
        receive(message) {
          if (reply !== null) return false;
          reply = message; return true;
        },
      };
      tickets.set(serial, operation);
      return Object.freeze({
        poll() {
          if (outcome.state !== 'pending') return outcome;
          if (monotonicNanoseconds() >= deadline)
            return operation.finish(Object.freeze({ state: 'error', error:
              failure('ERR_DBUS_TIMEOUT', 'D-Bus request exceeded its caller-specified deadline') }));
          if (reply === null) return outcome;
          try {
            const sender = header(reply, 'sender'), type = value('dbus_message_get_type', reply);
            if (!sender || ((destination.startsWith(':') || destination === 'org.freedesktop.DBus') &&
                sender !== destination && !(type === C.MESSAGE_ERROR && sender === 'org.freedesktop.DBus')))
              throw failure('ERR_DBUS_SENDER', 'D-Bus reply has unexpected sender');
            if (value('dbus_message_contains_unix_fds', reply))
              throw failure('ERR_DBUS_SIGNATURE', 'D-Bus endpoint does not support file descriptors');
            if (type === C.MESSAGE_ERROR) {
              const name = header(reply, 'error_name');
              if (!name) throw failure('ERR_DBUS_REPLY', 'D-Bus error has no name');
              return operation.finish(Object.freeze({ state: 'error', sender, error:
                failure('ERR_DBUS_REMOTE', 'Remote D-Bus error: ' + name, name) }));
            }
            const decoded = readArguments(reply, replySignature, projection);
            return operation.finish(Object.freeze({ state: 'reply', sender,
              value: decoded.length === 0 ? undefined : decoded.length === 1 ? decoded[0] : decoded }));
          } catch (error) { return operation.finish(Object.freeze({ state: 'error', error })); }
        },
        cancel() { return operation.finish(Object.freeze({ state: 'cancelled' })); },
      });
    },
    notify(target, signature, args) {
      live();
      for (const [field, validator] of [
        ['destination', 'dbus_validate_bus_name'], ['path', 'dbus_validate_path'],
        ['interface', 'dbus_validate_interface'], ['member', 'dbus_validate_member'],
      ]) validateText(target?.[field], validator);
      const prepared = prepareArguments(signature, args, live);
      const message = value('dbus_message_new_method_call',
        target.destination, target.path, target.interface, target.member);
      if (message === null) throw failure('ERR_DBUS_MEMORY', 'Cannot allocate D-Bus notification');
      try {
        appendArguments(message, prepared); value('dbus_message_set_no_reply', message, 1); send(message);
      } finally { release('dbus_message_unref', message); }
    },
    poll() {
      live(); value('dbus_connection_read_write', connection, 0); live();
      let message = value('dbus_connection_pop_message', connection);
      if (message === null) return null;
      try {
        const type = value('dbus_message_get_type', message);
        if (type === C.MESSAGE_METHOD_RETURN || type === C.MESSAGE_ERROR) {
          const ticket = tickets.get(value('dbus_message_get_reply_serial', message));
          if (ticket?.receive(message)) message = null;
          return null;
        }
        if (type !== C.MESSAGE_METHOD_CALL && type !== C.MESSAGE_SIGNAL) return null;
        const target = Object.freeze({ destination: header(message, 'destination'), path: header(message, 'path'),
          interface: header(message, 'interface'), member: header(message, 'member') });
        const sender = header(message, 'sender');
        if (!sender || (sender !== 'org.freedesktop.DBus' &&
            (!sender.startsWith(':') || !value('dbus_validate_bus_name', sender, null))))
          throw failure('ERR_DBUS_SENDER', 'D-Bus message has no valid sender');
        if (type === C.MESSAGE_SIGNAL) {
          const declaration = signals.get(target.interface + '\n' + target.member);
          if (!declaration || (declaration.accept && !declaration.accept(sender, target))) return null;
          if (value('dbus_message_contains_unix_fds', message))
            throw failure('ERR_DBUS_SIGNATURE', 'D-Bus endpoint does not support file descriptors');
          return Object.freeze({ kind: 'signal', target, sender,
            args: readArguments(message, declaration.signature, declaration.projection) });
        }
        const noReply = Boolean(value('dbus_message_get_no_reply', message));
        const object = objects.get(target.path + '\n' + target.interface);
        if (object?.accept && !object.accept(sender, target)) {
          respond(message, noReply, [], 'org.freedesktop.DBus.Error.AccessDenied', 'D-Bus method caller is not authorized');
          return null;
        }
        if (value('dbus_message_contains_unix_fds', message))
          throw failure('ERR_DBUS_SIGNATURE', 'D-Bus endpoint does not support file descriptors');
        const method = object?.methods.get(target.member);
        if (!method || !value('dbus_message_has_signature', message, method.signature)) {
          respond(message, noReply, [], 'org.freedesktop.DBus.Error.' + (method ? 'InvalidArgs' : 'UnknownMethod'),
            method ? 'Incorrect D-Bus argument signature' : 'Unknown D-Bus method');
          return null;
        }
        const args = readArguments(message, method.signature), owned = message;
        let finished = false;
        function active() {
          if (finished) throw failure('ERR_DBUS_REQUEST_CLOSED', 'D-Bus request is already closed');
          live();
        }
        function finish() {
          if (finished) return;
          finished = true; requests.delete(request); release('dbus_message_unref', owned);
        }
        const request = Object.freeze({
          kind: 'method', target, sender, noReply, args,
          reply(args = []) {
            active(); const prepared = prepareArguments(method.replySignature, args, active);
            try { return respond(owned, noReply, prepared); } finally { finish(); }
          },
          error(name, diagnostic) {
            active(); validateText(name, 'dbus_validate_error_name');
            if (typeof diagnostic !== 'string' || diagnostic.includes('\0'))
              throw new TypeError('D-Bus error text requires a string without NUL');
            encodeUtf8(diagnostic, maxBytes - 1);
            try { return respond(owned, noReply, [], name, diagnostic); } finally { finish(); }
          },
          close() { finish(); },
        });
        requests.add(request); message = null; return request;
      } finally { if (message !== null) release('dbus_message_unref', message); }
    },
    close() { close(); },
  });
  endpoints.add(endpoint); return endpoint;
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
