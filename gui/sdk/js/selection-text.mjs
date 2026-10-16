export function selectionTextColor(value) {
  if (value !== undefined && (typeof value !== 'string' || !value.length || value.length > 64))
    throw new TypeError('Invalid selectionTextColor');
  return value;
}

// Use the same full-string DOM renderer, including color glyphs and native
// shaping. Each decorative copy is clipped, never a separately shaped slice.
export function paintSelectionText(layer, { text, fontSize, fontFamily, ranges, width, height, foreground, selection, background, textTop = 0 }) {
  const owner = layer.ownerDocument;
  if (!owner) throw new Error('Selected text requires its attached owning document');
  const create = style => {
    const node = owner.createElement('view');
    Object.assign(node.style, { position: 'absolute', pointerEvents: 'none', ...style });
    node.setAttribute('aria-hidden', 'true');
    return node;
  };
  while (layer.childNodes.length > ranges.length) layer.removeChild(layer.lastChild);
  while (layer.childNodes.length < ranges.length) {
    const clip = create({ overflow: 'hidden' }), fill = create({ left: 0, right: 0, top: 0, bottom: 0 });
    const copy = create({});
    copy.appendChild(owner.createTextNode(''));
    clip.appendChild(fill); clip.appendChild(copy); layer.appendChild(clip);
  }
  Object.assign(layer.style, { width: String(Math.ceil(width)), height: String(height) });
  ranges.forEach((range, index) => {
    const clip = layer.childNodes[index], fill = clip.childNodes[0], copy = clip.childNodes[1];
    Object.assign(clip.style, { left: String(range.x), top: '0', width: String(range.width), height: String(height),
      backgroundColor: layer.parentNode.parentNode.style.backgroundColor || background });
    fill.style.backgroundColor = selection;
    Object.assign(copy.style, { left: String(-range.x), top: String(textTop), width: String(Math.ceil(width) + 1),
      fontSize: String(fontSize), color: foreground });
    if (fontFamily !== undefined || copy.style.fontFamily) copy.style.fontFamily = fontFamily ?? '';
    copy.firstChild.textContent = text;
  });
}
