import { alloc, maxBytes, pointerSize, longSize } from 'sysrt:ffi';

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
    object(field, ['type', 'offset'], 'record field');
    if (typeof field.type !== 'string') throw new TypeError('Record field requires an explicit type');
    const type = scalar(field.type);
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
            result[field.name] = view['get' + field.suffix](field.offset, littleEndian);
          return Object.freeze(result);
        },
        write(values) {
          live();
          if (!values || typeof values !== 'object' || Array.isArray(values) ||
              Object.keys(values).some(name => !names.has(name)))
            throw new TypeError('Unknown or invalid record values');
          const bytes = pointer.read(size), view = new DataView(bytes);
          for (const field of fields)
            if (Object.hasOwn(values, field.name))
              view['set' + field.suffix](field.offset, field.validate(values[field.name]), littleEndian);
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
