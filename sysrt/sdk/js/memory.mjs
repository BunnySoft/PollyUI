import { alloc, allocPointers, maxBytes, pointerSize, longSize } from 'sysrt:ffi';
import { encodeUtf8, decodeUtf8 } from './sysrt/sdk/js/encoding.mjs';

const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const integers = {
  i8: [1, 'Int8', -128, 127], u8: [1, 'Uint8', 0, 255],
  i16: [2, 'Int16', -32768, 32767], u16: [2, 'Uint16', 0, 65535],
  i32: [4, 'Int32', -2147483648, 2147483647], u32: [4, 'Uint32', 0, 4294967295],
};
const aliases = {
  size: pointerSize === 8 ? 'u64' : 'u32', ssize: pointerSize === 8 ? 'i64' : 'i32',
  long: longSize === 8 ? 'i64' : 'i32', ulong: longSize === 8 ? 'u64' : 'u32',
};

function object(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key)))
    throw new TypeError('Invalid ' + label);
}

function scalar(type) {
  type = aliases[type] ?? type;
  if (Object.hasOwn(integers, type)) {
    const [size, suffix, minimum, maximum] = integers[type];
    return {
      size, suffix,
      validate(value) {
        if (!Number.isInteger(value) || value < minimum || value > maximum)
          throw new RangeError('Record field is outside ' + type + ' range');
        return value;
      },
    };
  }
  if (type === 'i64' || type === 'u64') {
    const signed = type === 'i64';
    return {
      size: 8, suffix: signed ? 'BigInt64' : 'BigUint64',
      validate(value) {
        if (typeof value === 'number') {
          if (!Number.isSafeInteger(value)) throw new RangeError('Use BigInt for exact record fields');
          value = BigInt(value);
        }
        if (typeof value !== 'bigint') throw new TypeError('Record field requires Number or BigInt');
        const minimum = signed ? -9223372036854775808n : 0n;
        const maximum = signed ? 9223372036854775807n : 18446744073709551615n;
        if (value < minimum || value > maximum) throw new RangeError('Record field exceeds ' + type);
        return value;
      },
    };
  }
  if (type === 'float' || type === 'double') {
    return {
      size: type === 'float' ? 4 : 8, suffix: type === 'float' ? 'Float32' : 'Float64',
      validate(value) {
        if (typeof value !== 'number') throw new TypeError('Floating record fields require Number');
        if (type === 'float' && Number.isFinite(value) && Math.abs(value) > 3.4028234663852886e38)
          throw new RangeError('Record float overflow');
        return value;
      },
    };
  }
  throw new TypeError('Unsupported record field type: ' + type);
}

export function compileLayout(description) {
  object(description, ['byteLength', 'fields'], 'record layout');
  const size = description.byteLength;
  if (!Number.isInteger(size) || size < 1 || size > maxBytes)
    throw new RangeError('Record size exceeds the native memory bound');
  if (!description.fields || typeof description.fields !== 'object' || Array.isArray(description.fields))
    throw new TypeError('Record layout requires fields');
  const entries = Object.entries(description.fields);
  if (!entries.length || entries.length > 256) throw new RangeError('Record fields must be bounded');
  const fields = entries.map(([name, field]) => {
    object(field, ['type', 'offset', 'byteLength'], 'record field');
    if (typeof field.type !== 'string') throw new TypeError('Record field requires an explicit type');
    let type;
    if (field.type === 'bytes' || field.type === 'cstring') {
      const length = field.byteLength;
      if (!Number.isInteger(length) || length < 1 || length > size)
        throw new RangeError('Array/string field requires a bounded byteLength');
      const string = field.type === 'cstring';
      type = {
        size: length,
        read(view, offset) {
          const bytes = new Uint8Array(view.buffer, offset, length);
          if (!string) return bytes.slice();
          const end = bytes.indexOf(0);
          if (end < 0) throw new RangeError('No C string terminator inside field: ' + name);
          return decodeUtf8(bytes.subarray(0, end));
        },
        write(view, offset, value) {
          let bytes;
          if (string) {
            if (typeof value !== 'string' || value.includes('\0'))
              throw new TypeError('CString fields require strings without NUL');
            bytes = encodeUtf8(value, length - 1);
          } else {
            if (!(value instanceof Uint8Array) || value.length !== length)
              throw new TypeError('Byte fields require an exact-length Uint8Array');
            bytes = value;
          }
          const destination = new Uint8Array(view.buffer, offset, length);
          destination.fill(0); destination.set(bytes);
        },
      };
    } else {
      if (field.byteLength !== undefined) throw new TypeError('byteLength is only valid for array/string fields');
      type = scalar(field.type);
    }
    if (!Number.isInteger(field.offset) || field.offset < 0 || field.offset > size - type.size)
      throw new RangeError('Record field exceeds its allocation: ' + name);
    return { name, offset: field.offset, ...type };
  });
  const ordered = [...fields].sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < ordered.length; i++)
    if (ordered[i].offset < ordered[i - 1].offset + ordered[i - 1].size)
      throw new TypeError('Overlapping record fields are unsupported');
  const names = new Set(fields.map(field => field.name));
  return Object.freeze({
    byteLength: size,
    create() {
      const pointer = alloc(size);
      let closed = false;
      function live() { if (closed) throw new Error('Native record is closed'); }
      return {
        get pointer() { live(); return pointer; },
        read() {
          live();
          const view = new DataView(pointer.read(size)), result = Object.create(null);
          for (const field of fields)
            result[field.name] = field.read ? field.read(view, field.offset) :
              view['get' + field.suffix](field.offset, littleEndian);
          return Object.freeze(result);
        },
        write(values) {
          live();
          if (!values || typeof values !== 'object' || Array.isArray(values) ||
              Object.keys(values).some(name => !names.has(name)))
            throw new TypeError('Unknown or invalid record values');
          const bytes = pointer.read(size), view = new DataView(bytes);
          for (const field of fields)
            if (Object.hasOwn(values, field.name)) {
              if (field.write) field.write(view, field.offset, values[field.name]);
              else view['set' + field.suffix](field.offset, field.validate(values[field.name]), littleEndian);
            }
          pointer.write(bytes);
        },
        close() {
          if (closed) return;
          pointer.close(); closed = true;
        },
      };
    },
  });
}

export function createRecord(description) { return compileLayout(description).create(); }

export function createCStringArray(values) {
  if (!Array.isArray(values)) throw new TypeError('CString array requires an array of strings');
  const buffers = [];
  let pointer;
  try {
    for (const value of values) {
      if (typeof value !== 'string' || value.includes('\0')) throw new TypeError('CString arrays cannot contain NUL');
      const bytes = encodeUtf8(value, maxBytes - 1);
      const buffer = alloc(bytes.length + 1);
      buffers.push(buffer); buffer.write(bytes.buffer);
    }
    pointer = allocPointers([...buffers, null]);
  } catch (error) {
    for (const buffer of buffers) buffer.close();
    throw error;
  }
  let closed = false;
  return {
    get pointer() { if (closed) throw new Error('CString array is closed'); return pointer; },
    close() {
      if (closed) return;
      pointer.close();
      for (const buffer of buffers) buffer.close();
      closed = true;
    },
  };
}
