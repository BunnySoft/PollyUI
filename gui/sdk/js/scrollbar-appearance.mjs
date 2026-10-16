const limits = { width: [4, 128], thumbInset: [0, 32], minThumbHeight: [1, 256],
  arrowSize: [0, 128], stepSize: [1, 4096] };
const styleKeys = new Set(['backgroundColor', 'gradientFrom', 'gradientTo', 'gradientDir',
  'borderColor', 'borderWidth', 'borderRadius', 'color', 'opacity']);

export function scrollbarAppearance(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['metrics', 'paint', 'decorate'].includes(key)))
    throw new TypeError('Invalid scrollbar appearance');
  const metrics = { minThumbHeight: 28, arrowSize: 0, stepSize: 42 };
  if (value.metrics !== undefined) {
    if (!value.metrics || typeof value.metrics !== 'object' || Array.isArray(value.metrics))
      throw new TypeError('Invalid scrollbar metrics');
    for (const [key, entry] of Object.entries(value.metrics)) {
      if (!Object.hasOwn(limits, key)) throw new TypeError('Unknown scrollbar metric: ' + key);
      const [min, max] = limits[key];
      if (!Number.isFinite(entry) || entry < min || entry > max)
        throw new RangeError('Invalid scrollbar metric: ' + key);
      metrics[key] = entry;
    }
  }
  if (metrics.width !== undefined && (metrics.thumbInset ?? 0) * 2 >= metrics.width)
    throw new RangeError('Scrollbar thumb inset must fit its width');
  for (const key of ['paint', 'decorate'])
    if (value[key] !== undefined && typeof value[key] !== 'function')
      throw new TypeError('Invalid scrollbar ' + key);
  return { metrics: Object.freeze(metrics), paint: value.paint, decorate: value.decorate };
}

export function scrollbarStyles(value, parts) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Scrollbar paint must return part styles');
  for (const [part, style] of Object.entries(value)) {
    if (!['track', 'thumb', 'decrement', 'increment'].includes(part) ||
        !style || typeof style !== 'object' || Array.isArray(style))
      throw new TypeError('Invalid scrollbar paint part: ' + part);
    for (const [key, entry] of Object.entries(style))
      if (!styleKeys.has(key) || !['string', 'number'].includes(typeof entry) ||
          typeof entry === 'number' && !Number.isFinite(entry))
        throw new TypeError('Invalid scrollbar paint style: ' + key);
  }
  return Object.entries(value).filter(([part]) => parts[part]).map(([part, style]) => [parts[part], style]);
}
