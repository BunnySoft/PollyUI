import { createBoundedAnimation } from './desktop/shared/ui/animation.mjs';
import { videoWallpaperPreferences } from './desktop/shared/ui/video-wallpaper.mjs';

export function wallpaperPreferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== (Object.hasOwn(value, 'video') ? 'mode,reducedMotion,video' : 'mode,reducedMotion') ||
      !['theme', 'aurora', 'video'].includes(value.mode) || typeof value.reducedMotion !== 'boolean' ||
      (value.mode === 'video' && !Object.hasOwn(value, 'video')))
    throw new TypeError('Wallpaper requires a supported mode, boolean reducedMotion and local video selection when needed');
  return { mode: value.mode, reducedMotion: value.reducedMotion,
    ...(Object.hasOwn(value, 'video') ? { video: videoWallpaperPreferences(value.video) } : {}) };
}

export function createProceduralWallpaper({ document, mount, onError, clock = {} }) {
  if (typeof document?.createElement !== 'function' || !mount || typeof onError !== 'function')
    throw new TypeError('Procedural wallpaper requires an owned document, mount and error callback');
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 0;
  Object.assign(canvas.style, { position: 'absolute', left: '0', top: '0',
    width: '100%', height: '100%', pointerEvents: 'none' });
  canvas.setAttribute('aria-hidden', 'true');
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('Procedural wallpaper requires Canvas 2D');
  let signature = '', colors = null, active = false, reducedMotion = false, disposed = false;
  const animation = createBoundedAnimation({ ...clock, onError(error) {
    canvas.width = canvas.height = 0;
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    onError(error);
  }, paint(time) {
    if (!colors || !canvas.width || !canvas.height) return;
    const w = canvas.width, h = canvas.height, phase = time / 2000;
    context.resetTransform();
    context.globalAlpha = 1;
    const base = context.createLinearGradient(0, 0, w, h);
    base.addColorStop(0, colors.from); base.addColorStop(1, colors.to);
    context.fillStyle = base;
    context.fillRect(0, 0, w, h);
    for (let band = 0; band < 4; band++) {
      const y = h * (0.24 + band * 0.18 + 0.08 * Math.sin(phase + band));
      const wave = h * (0.22 + 0.12 * Math.cos(phase * 0.7 + band));
      const glow = context.createLinearGradient(0, y - wave, w, y + wave);
      glow.addColorStop(0, colors.accent); glow.addColorStop(1, band % 2 ? colors.from : '#ffffff');
      context.globalAlpha = 0.16 + band * 0.025;
      context.fillStyle = glow;
      context.beginPath();
      context.moveTo(-w * 0.1, y);
      context.bezierCurveTo(w * 0.25, y - wave, w * 0.65, y + wave, w * 1.1, y - h * 0.16);
      context.lineTo(w * 1.1, y + h * 0.08);
      context.bezierCurveTo(w * 0.65, y + wave + h * 0.2, w * 0.25, y - wave + h * 0.15, -w * 0.1, y + h * 0.15);
      context.closePath();
      context.fill();
    }
    context.globalAlpha = 1;
  } });
  mount.appendChild(canvas);
  return Object.freeze({
    canvas,
    update({ theme, width, height, reducedMotion: reduced }) {
      if (disposed) throw new Error('Procedural wallpaper is disposed');
      if (typeof reduced !== 'boolean' || !Number.isFinite(width) || !Number.isFinite(height) ||
          width < 1 || height < 1 || width > 32768 || height > 32768)
        throw new TypeError('Invalid procedural wallpaper dimensions or motion policy');
      const next = { from: theme.desktop.from, to: theme.desktop.to, accent: theme.colors.accent };
      const factor = Math.min(1, 640 / width, 360 / height);
      const w = Math.max(1, Math.floor(width * factor)), h = Math.max(1, Math.floor(height * factor));
      const key = JSON.stringify([next, w, h]);
      const changed = key !== signature;
      if (changed && !animation.stats.failed) {
        canvas.height = 0; canvas.width = w; canvas.height = h;
        colors = next; signature = key;
      }
      const motionChanged = reducedMotion !== reduced;
      reducedMotion = reduced;
      animation.setState(active, reducedMotion);
      if (changed && !motionChanged && !animation.stats.disposed && !animation.stats.failed) animation.invalidate();
    },
    setActive(value) {
      if (typeof value !== 'boolean') throw new TypeError('Wallpaper activity must be boolean');
      active = value;
      animation.setState(active, reducedMotion);
    },
    get stats() { return { ...animation.stats, width: canvas.width, height: canvas.height, maxPixels: 230400 }; },
    dispose() {
      if (disposed) return;
      disposed = true;
      animation.dispose();
      canvas.width = canvas.height = 0;
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    },
  });
}
