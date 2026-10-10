export function encodeUtf8(text, maximum = Number.MAX_SAFE_INTEGER) {
  if (typeof text !== 'string') throw new TypeError('UTF-8 encoding requires a string');
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw new RangeError('Invalid UTF-8 byte bound');
  if (text.length > maximum) throw new RangeError('UTF-8 input exceeds its byte bound');
  const bytes = [];
  for (const character of text) {
    const code = character.codePointAt(0);
    if (code >= 0xd800 && code <= 0xdfff) throw new TypeError('Unpaired Unicode surrogate');
    const count = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes.length + count > maximum) throw new RangeError('UTF-8 input exceeds its byte bound');
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
  }
  return new Uint8Array(bytes);
}

export function decodeUtf8(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('UTF-8 decoding requires Uint8Array');
  const characters = [];
  for (let i = 0; i < bytes.length;) {
    const first = bytes[i++];
    if (first < 0x80) { characters.push(String.fromCharCode(first)); continue; }
    let count, code, minimum;
    if (first >= 0xc2 && first <= 0xdf) { count = 1; code = first & 31; minimum = 0x80; }
    else if (first >= 0xe0 && first <= 0xef) { count = 2; code = first & 15; minimum = 0x800; }
    else if (first >= 0xf0 && first <= 0xf4) { count = 3; code = first & 7; minimum = 0x10000; }
    else throw new TypeError('Invalid UTF-8 leading byte');
    if (count > bytes.length - i) throw new TypeError('Truncated UTF-8 sequence');
    for (let j = 0; j < count; j++) {
      const next = bytes[i++];
      if ((next & 0xc0) !== 0x80) throw new TypeError('Invalid UTF-8 continuation byte');
      code = (code << 6) | (next & 63);
    }
    if (code < minimum || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
      throw new TypeError('Invalid or noncanonical UTF-8 code point');
    characters.push(String.fromCodePoint(code));
  }
  return characters.join('');
}
