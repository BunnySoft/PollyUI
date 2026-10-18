// A literal installed family name, never a font resource or fallback list.
export function fontFamily(value) {
  if (typeof value !== 'string' || !value.length || value.length > 128 || value !== value.trim() ||
      !/^[\p{L}\p{N}][\p{L}\p{M}\p{N} ._()'-]*$/u.test(value) || /['"]$|\burl *\(/i.test(value))
    throw new TypeError('fontFamily must be a bounded literal family name, not a font resource');
  return value;
}

export function requireFontFamily(value) {
  if (value === undefined) return;
  fontFamily(value);
  if (typeof measureText !== 'function' || measureText.supportsFontFamily !== true ||
      (typeof layoutText === 'function' && layoutText.supportsFontFamily !== true))
    throw new Error('Named UI fonts require font-family-aware measureText and layoutText providers');
  return value;
}

export function fontFamilyStyle(value) {
  return value === undefined ? {} : { fontFamily: requireFontFamily(value) };
}
