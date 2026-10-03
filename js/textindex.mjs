// UTF-16 indices for JS strings, without splitting surrogate pairs.
// Grapheme-cluster navigation and IME preedit remain separate features.
export function clampTextIndex(value, index) {
  let i = Math.max(0, Math.min(index, value.length));
  const low = value.charCodeAt(i), high = value.charCodeAt(i - 1);
  if (low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff) i--;
  return i;
}

export function previousTextIndex(value, index) {
  let i = Math.max(0, clampTextIndex(value, index) - 1);
  const low = value.charCodeAt(i), high = value.charCodeAt(i - 1);
  if (low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff) i--;
  return i;
}

export function nextTextIndex(value, index) {
  let i = clampTextIndex(value, index);
  const high = value.charCodeAt(i), low = value.charCodeAt(i + 1);
  i += high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff ? 2 : 1;
  return Math.min(i, value.length);
}

export const removeLastCodePoint = value => value.slice(0, previousTextIndex(value, value.length));
