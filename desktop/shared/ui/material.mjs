const nodeRuntime = typeof process !== 'undefined' && process.versions?.node;
const { validateTheme } = await import(nodeRuntime ? './theme-schema.mjs' : './desktop/shared/ui/theme-schema.mjs');

function bounded(value, minimum, maximum, name) {
  if (!Number.isFinite(value) || value < minimum || value > maximum)
    throw new RangeError('Invalid material ' + name);
  return value;
}
const length = (value, extent) => typeof value === 'string' ? parseFloat(value) * extent / 100 : value;

function gradient(context, from, to, x, y, width, height, radius = 0) {
  const paint = context.createLinearGradient(x, y, x, y + height);
  paint.addColorStop(0, from); paint.addColorStop(1, to);
  context.fillStyle = paint;
  context.beginPath(); context.roundRect(x, y, width, height, radius); context.fill();
}
function paintWallpaper(context, desktop, width, height, image) {
  gradient(context, desktop.from, desktop.to, 0, 0, width, height);
  if (image) { context.drawImage(image, 0, 0, width, height); return; }
  for (const layer of desktop.layers) {
    const x = length(layer.left, width), y = length(layer.top, height);
    const w = length(layer.width, width), h = length(layer.height, height);
    context.save();
    context.globalAlpha = layer.opacity;
    context.translate(x + w / 2, y + h / 2); context.rotate(layer.rotation * Math.PI / 180);
    gradient(context, layer.from, layer.to, -w / 2, -h / 2, w, h, layer.radius);
    if (layer.borderWidth) {
      context.strokeStyle = layer.borderColor; context.lineWidth = layer.borderWidth;
      context.stroke();
    }
    context.restore();
  }
}
function dimensions(width, height, scale, blur, limit) {
  const size = factor => {
    const w = Math.max(1, Math.ceil(width * factor)), h = Math.max(1, Math.ceil(height * factor));
    const pad = Math.ceil(4 * blur * factor) + 2;
    return { w, h, pad, factor };
  };
  let low = 0, high = Math.min(scale, blur ? 128 / blur : scale);
  for (let i = 0; i < 32; ++i) {
    const middle = (low + high) / 2, { w, h, pad } = size(middle);
    if ((w + 2 * pad) * (h + 2 * pad) <= limit) low = middle;
    else high = middle;
  }
  return size(low);
}

// One owner per client base. Foreground DOM remains a separate, fully opaque sibling.
export function createWallpaperMaterial({ document = globalThis.document, maxPixels = 262144,
  onError = error => console.error('[material]', error) } = {}) {
  bounded(maxPixels, 1024, 1048576, 'pixel budget');
  if (!Number.isInteger(maxPixels) || typeof document?.createElement !== 'function' || typeof onError !== 'function')
    throw new TypeError('Material requires a document, integer pixel budget and error callback');
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 0;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('Material requires Canvas 2D');
  let disposed = false, generation = 0, requested = '', published = '', pending = null;
  let image = null, sourceKey = '', imageReady = null, blurred = null, blurKey = '';
  const stats = { decodes: 0, wallpaperPaints: 0, blurs: 0, composites: 0 };
  const releaseCanvas = value => { if (value) value.width = value.height = 0; };
  function releaseSource() {
    if (image) image.removeAttribute('src');
    image = imageReady = null; sourceKey = '';
  }
  function releaseBlur() { releaseCanvas(blurred); blurred = null; blurKey = ''; }
  function report(error) {
    published = '';
    releaseSource(); releaseBlur();
    releaseCanvas(canvas);
    onError(error);
  }
  function makeCanvas(width, height) {
    const result = document.createElement('canvas');
    result.height = 0;
    result.width = width; result.height = height;
    return result;
  }
  function snapshot(options) {
    const { theme, width, height, scale = 1, active = true, mode = 'wallpaper',
      asset = theme?.desktop?.asset || '', sourceRevision = 0, blur = 32 } = options;
    validateTheme(theme);
    bounded(width, 1, 16384, 'width'); bounded(height, 1, 16384, 'height');
    bounded(scale, 0.25, 8, 'scale'); bounded(blur, 0, 64, 'blur');
    if (typeof active !== 'boolean' || !['wallpaper', 'solid'].includes(mode) ||
        typeof asset !== 'string' || asset.length > 89478528 ||
        !['string', 'number'].includes(typeof sourceRevision) ||
        (typeof sourceRevision === 'number' && !Number.isFinite(sourceRevision)) ||
        (typeof sourceRevision === 'string' && sourceRevision.length > 128))
      throw new TypeError('Invalid material mode, activation or source');
    return { desktop: JSON.parse(JSON.stringify(theme.desktop)), body: theme.colors.body,
      tint: active ? theme.colors.surface : theme.colors.body, width, height, scale, active, mode,
      asset, sourceRevision, blur };
  }
  async function build(value, version, key) {
    if (value.mode === 'solid') {
      releaseSource(); releaseBlur();
      canvas.width = canvas.height = 1;
      context.fillStyle = value.body; context.fillRect(0, 0, 1, 1);
    } else {
      if (!('filter' in context)) throw new Error('Wallpaper material requires Canvas blur support');
      const test = 'blur(1px)';
      context.filter = test;
      if (context.filter !== test) throw new Error('Canvas provider does not support blur(px)');
      context.filter = 'none';
      const nextSource = value.asset ? JSON.stringify([value.asset, value.sourceRevision]) : '';
      if (nextSource !== sourceKey) {
        releaseSource();
        if (value.asset) {
          image = document.createElement('img'); sourceKey = nextSource;
          image.src = value.asset; stats.decodes++;
          imageReady = image.decode();
        }
      }
      if (imageReady) await imageReady;
      if (disposed || version !== generation) return false;
      const nextBlur = JSON.stringify([value.desktop, value.asset, value.sourceRevision,
        value.width, value.height, value.scale, value.blur]);
      if (nextBlur !== blurKey) {
        releaseBlur();
        const { w, h, pad, factor } = dimensions(value.width, value.height, value.scale, value.blur, maxPixels);
        let raw = null, padded = null, result = null;
        try {
          raw = makeCanvas(w, h); padded = makeCanvas(w + 2 * pad, h + 2 * pad);
          result = makeCanvas(w, h);
          const source = raw.getContext('2d');
          source.scale(w / value.width, h / value.height);
          paintWallpaper(source, value.desktop, value.width, value.height, image); stats.wallpaperPaints++;
          const edge = padded.getContext('2d');
          // Clamp all four edges/corners before filtering; never sample other apps.
          const xs = [[0, 1, 0, pad], [0, w, pad, w], [w - 1, 1, pad + w, pad]];
          const ys = [[0, 1, 0, pad], [0, h, pad, h], [h - 1, 1, pad + h, pad]];
          for (const [sx, sw, dx, dw] of xs) for (const [sy, sh, dy, dh] of ys)
            edge.drawImage(raw, sx, sy, sw, sh, dx, dy, dw, dh);
          const filtered = result.getContext('2d');
          filtered.filter = `blur(${value.blur * factor}px)`;
          filtered.drawImage(padded, -pad, -pad); stats.blurs++;
          blurred = result; result = null; blurKey = nextBlur;
        } finally { releaseCanvas(raw); releaseCanvas(padded); releaseCanvas(result); }
      }
      canvas.height = 0;
      canvas.width = blurred.width; canvas.height = blurred.height;
      context.fillStyle = value.body; context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(blurred, 0, 0);
      context.globalAlpha = value.active ? 0.78 : 0.9;
      context.fillStyle = value.tint; context.fillRect(0, 0, canvas.width, canvas.height);
      context.globalAlpha = 1;
    }
    canvas.style.width = String(value.width); canvas.style.height = String(value.height);
    stats.composites++; published = key;
    return true;
  }
  return Object.freeze({
    canvas,
    get stats() { return Object.freeze({ ...stats, width: canvas.width, height: canvas.height,
      maxPixels, disposed, ready: !!published }); },
    update(options) {
      if (disposed) return Promise.reject(new Error('Material is disposed'));
      let value, key;
      try { value = snapshot(options); key = JSON.stringify(value); }
      catch (error) {
        generation++; requested = ''; pending = null;
        report(error);
        return Promise.reject(error);
      }
      if (key === requested && pending) return pending;
      if (key === published) {
        generation++; requested = key; pending = null;
        return Promise.resolve(false);
      }
      requested = key;
      const version = ++generation;
      pending = build(value, version, key).catch(error => {
        if (disposed || version !== generation) return false;
        report(error);
        throw error;
      }).finally(() => { if (version === generation) pending = null; });
      return pending;
    },
    dispose() {
      if (disposed) return;
      disposed = true; generation++; published = requested = ''; pending = null;
      releaseSource(); releaseBlur(); releaseCanvas(canvas);
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    },
  });
}
