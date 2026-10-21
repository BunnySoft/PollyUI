export function companionPreferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'enabled,reducedMotion' ||
      typeof value.enabled !== 'boolean' || typeof value.reducedMotion !== 'boolean')
    throw new TypeError('Companion requires boolean enabled and reducedMotion');
  return { enabled: value.enabled, reducedMotion: value.reducedMotion };
}

export function companionPosition(x, y, width, height, bottom = 64) {
  if (![x, y, width, height, bottom].every(Number.isFinite) || width < 96 || height < 96 || bottom < 0)
    throw new TypeError('Companion requires valid output-local geometry');
  return { x: Math.round(Math.max(0, Math.min(width - 96, x))),
    y: Math.round(Math.max(0, Math.min(height - 96 - bottom, y))) };
}

export function companionInput(mask, position, bubble = null) {
  return [...mask.map(([x, y, width, height]) => [x + position.x, y + position.y, width, height]),
    ...(bubble ? [[bubble.x, bubble.y, bubble.width, bubble.height]] : [])];
}
