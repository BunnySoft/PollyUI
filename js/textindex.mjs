// ICU grapheme boundaries on Linux; preserve the code-point contract elsewhere.
const cache = new Map();
function boundaries(value) {
  let result = cache.get(value);
  if (!result) {
    result = textBoundaries(value);
    if (cache.size >= 16) cache.delete(cache.keys().next().value);
    if (value.length <= 16384) cache.set(value, result);
  }
  return result;
}
function preceding(values, index) {
  let lo = 0, hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid] <= index) lo = mid + 1; else hi = mid;
  }
  return Math.max(0, lo - 1);
}
export function clampTextIndex(value, index) {
  let i = Math.max(0, Math.min(index, value.length));
  if (typeof textBoundaries === 'function') {
    const points = boundaries(value);
    return points[preceding(points, i)];
  }
  const low = value.charCodeAt(i), high = value.charCodeAt(i - 1);
  if (low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff) i--;
  return i;
}

export function previousTextIndex(value, index) {
  if (typeof textBoundaries === 'function') {
    const points = boundaries(value), i = preceding(points, Math.max(0, Math.min(index, value.length)));
    return points[Math.max(0, i - 1)];
  }
  let i = Math.max(0, clampTextIndex(value, index) - 1);
  const low = value.charCodeAt(i), high = value.charCodeAt(i - 1);
  if (low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff) i--;
  return i;
}

export function nextTextIndex(value, index) {
  if (typeof textBoundaries === 'function') {
    const points = boundaries(value), i = preceding(points, Math.max(0, Math.min(index, value.length)));
    return points[Math.min(points.length - 1, i + 1)];
  }
  let i = clampTextIndex(value, index);
  const high = value.charCodeAt(i), low = value.charCodeAt(i + 1);
  i += high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff ? 2 : 1;
  return Math.min(i, value.length);
}

export const removeLastCodePoint = value => value.slice(0, previousTextIndex(value, value.length));
