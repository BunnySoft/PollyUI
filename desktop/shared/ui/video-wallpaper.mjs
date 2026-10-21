export function videoWallpaperPreferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'loop,path,paused' ||
      typeof value.path !== 'string' || !value.path.startsWith('/') ||
      value.path.length > 4096 || /[\x00-\x1f\x7f]/.test(value.path) ||
      value.path.split('/').some(part => part === '.' || part === '..') ||
      typeof value.loop !== 'boolean' || typeof value.paused !== 'boolean')
    throw new TypeError('Video wallpaper requires one bounded absolute local pathname and boolean loop/paused');
  return { path: value.path, loop: value.loop, paused: value.paused };
}

export function videoWallpaperCover(width, height, outputWidth, outputHeight) {
  if (![width, height, outputWidth, outputHeight].every(value => Number.isFinite(value) && value > 0))
    throw new TypeError('Video cover requires valid source/output dimensions');
  const scale = Math.max(outputWidth / width, outputHeight / height);
  const w = Math.ceil(width * scale), h = Math.ceil(height * scale);
  return { x: Math.floor((outputWidth - w) / 2), y: Math.floor((outputHeight - h) / 2), width: w, height: h };
}
