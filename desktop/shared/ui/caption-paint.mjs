import { lunaBandColor, mixColor } from './desktop/shared/ui/luna-primitives.mjs';

export function captionFrameGeometry(meta) {
  if (!Array.isArray(meta) || meta.length !== 26 ||
      meta.some(value => !Number.isInteger(value) || value < 0 || value > 0xffffffff))
    throw new TypeError('Invalid native caption metadata');
  const scale = new Float32Array(new Uint32Array([meta[6]]).buffer)[0];
  const [width, height, , state, border, title] = meta.slice(4, 10);
  if (!meta[0] || !meta[1] || !(meta[2] || meta[3]) || width < 1 || height < 1 ||
      width > 32700 || height > 32700 || border > 8 || title < 16 || title > 96 ||
      !Number.isFinite(scale) || scale <= 0 || scale > 8 || state > 127)
    throw new RangeError('Caption frame exceeds supported bounds');
  const logical = [[width + 2 * border, title], [border, height],
    [border, height], [width + 2 * border, border]];
  const strips = logical.map(([w, h]) => ({
    width: Math.ceil(w * scale), height: Math.ceil(h * scale), logicalWidth: w, logicalHeight: h,
  }));
  if (strips.some(strip => strip.width > 32768 || strip.height > 32768) ||
      strips.reduce((sum, strip) => sum + strip.width * strip.height, 0) > 16777216)
    throw new RangeError('Caption frame exceeds the pixel budget');
  return { scale, width, height, border, title, strips,
    active: Boolean(state & 1), maximized: Boolean(state & 2), pressed: state >> 2 & 7,
    hovered: state >> 5 & 3, buttons: [10, 14, 18].map(at => meta.slice(at, at + 4)), text: meta.slice(22) };
}

function fill(ctx, color, x, y, width, height) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, width, height);
}
function gradient(ctx, from, to, x0, y0, x1, y1) {
  const paint = ctx.createLinearGradient(x0, y0, x1, y1);
  paint.addColorStop(0, from); paint.addColorStop(1, to);
  return paint;
}
function frameColor(theme, side, layer, active) {
  const w = theme.window;
  if (w.surfaceStyle === 'classic')
    return (side < 2 ? [theme.colors.body, theme.colors.light, theme.colors.body] :
      ['#404040', theme.colors.dark, theme.colors.body])[Math.min(layer, 2)];
  return w.surfaceStyle === 'luna' && !active ? mixColor(w.inactiveFrom, '#000000', 0.3) : w.border;
}
function paintEdge(ctx, theme, geometry, side) {
  const { border, width, height, active } = geometry, outer = width + 2 * border;
  for (let i = 0; i < border; i++) {
    if (side === 3) fill(ctx, frameColor(theme, 3, i, active), i, border - 1 - i, outer - 2 * i, 1);
    else fill(ctx, frameColor(theme, side, i, active), side === 1 ? i : border - 1 - i, 0, 1, height);
  }
}

function classicGlyph(ctx, w, command, width, height, maximized) {
  const span = Math.max(1, Math.round(w.glyphRadius * 2)), stroke = Math.max(1, Math.round(w.glyphThickness));
  const rect = (x, y, size) => {
    ctx.fillRect(x, y, size, Math.min(size, stroke + 1));
    ctx.fillRect(x, y, Math.min(size, stroke), size);
    ctx.fillRect(x + size - stroke, y, stroke, size);
    ctx.fillRect(x, y + size - stroke, size, stroke);
  };
  if (command === 2) {
    const length = Math.max(1, span - 3), thick = Math.max(1, Math.round(w.glyphThickness * 2));
    ctx.fillRect(Math.max(0, Math.floor((width - length) / 2) - 1), Math.max(0, height - 3 - thick), length, thick);
  } else if (command === 0) {
    const gw = Math.max(1, span - 1), gh = Math.max(1, span - 2), thick = Math.max(1, Math.round(w.closeThickness * 2));
    const left = Math.floor((width - gw) / 2), top = Math.floor((height - gh) / 2);
    ctx.save(); ctx.beginPath(); ctx.rect(left, top, gw, gh); ctx.clip();
    for (let y = 0; y < gh; y++) {
      const diagonal = Math.min(y, gh - 1 - y);
      ctx.fillRect(left + diagonal, top + y, thick, 1);
      ctx.fillRect(left + gw - diagonal - thick, top + y, thick, 1);
    }
    ctx.restore();
  } else {
    const left = Math.floor((width - span) / 2), top = Math.floor((height - span) / 2);
    if (!maximized) rect(left, top, span);
    else {
      const offset = span > 4 ? 2 : 1, small = Math.max(1, span - offset);
      ctx.save(); ctx.beginPath();
      ctx.rect(left, top + offset, small, small);
      ctx.rect(0, 0, width, height); ctx.clip('evenodd');
      rect(left + offset, top, small); ctx.restore();
      rect(left, top + offset, small);
    }
  }
}
function glyph(ctx, theme, command, width, height, maximized) {
  const w = theme.window;
  if (w.surfaceStyle === 'classic') { classicGlyph(ctx, w, command, width, height, maximized); return; }
  const r = w.glyphRadius;
  ctx.translate(width / 2, height / 2);
  ctx.lineWidth = w.glyphThickness * 2; ctx.strokeStyle = ctx.fillStyle;
  if (command === 0) {
    ctx.lineWidth = w.closeThickness * Math.SQRT2;
    ctx.beginPath(); ctx.moveTo(-r, -r); ctx.lineTo(r, r); ctx.moveTo(r, -r); ctx.lineTo(-r, r); ctx.stroke();
  } else if (command === 2) ctx.fillRect(-r, (w.controlShape === 'round' ? 0 : r / 2) - w.glyphThickness, r * 2, w.glyphThickness * 2);
  else if (w.controlShape === 'round') {
    ctx.fillRect(-w.glyphThickness, -r, w.glyphThickness * 2, r * 2);
    ctx.fillRect(-r, -w.glyphThickness, r * 2, w.glyphThickness * 2);
  } else {
    const extent = r * (w.surfaceStyle === 'luna' ? 1 : 0.75);
    if (maximized && ['luna', 'fluent'].includes(w.surfaceStyle)) {
      ctx.beginPath(); ctx.moveTo(-extent + 1, -extent - 1);
      ctx.lineTo(extent + 1, -extent - 1); ctx.lineTo(extent + 1, extent - 1); ctx.stroke();
      ctx.translate(-1, 1);
    }
    ctx.strokeRect(-extent, -extent, extent * 2, extent * 2);
  }
}
function paintControl(ctx, theme, geometry, command, box) {
  const [x, y, width, height] = box;
  if (!width || !height) return;
  const w = theme.window, style = w.surfaceStyle, hovered = geometry.hovered === command + 1;
  const pressed = Boolean(geometry.pressed & 1 << command);
  let from = command === 0 ? w.closeFrom : command === 1 ? w.maximizeFrom : w.minimizeFrom;
  let to = command === 0 ? w.closeTo : command === 1 ? w.maximizeTo : w.minimizeTo;
  ctx.save(); ctx.translate(x, y);
  ctx.beginPath(); ctx.roundRect(0, 0, width, height, w.controlShape === 'round' ? width / 2 : w.controlRadius); ctx.clip();
  if (style === 'classic') {
    fill(ctx, w.controlFrom, 0, 0, width, height);
    if (pressed) {
      fill(ctx, theme.colors.dark, 0, 0, width, 1); fill(ctx, theme.colors.dark, 0, 0, 1, height);
    } else {
      fill(ctx, theme.colors.light, 0, 0, width, 1); fill(ctx, theme.colors.light, 0, 0, 1, height);
      fill(ctx, '#404040', width - 1, 0, 1, height); fill(ctx, '#404040', 0, height - 1, width, 1);
      fill(ctx, theme.colors.dark, width - 2, 1, 1, height - 2);
      fill(ctx, theme.colors.dark, 1, height - 2, width - 2, 1);
    }
  } else if (style === 'fluent') {
    fill(ctx, !hovered ? (geometry.active ? w.titleFrom : w.inactiveFrom) :
      command === 0 ? (pressed ? w.closeTo : w.closeFrom) : (pressed ? w.controlTo : w.hoverColor), 0, 0, width, height);
  } else {
    if (!geometry.active) { from = mixColor(from, w.inactiveTo, w.inactiveOpacity); to = mixColor(to, w.inactiveTo, w.inactiveOpacity); }
    if (hovered) { from = mixColor(from, w.hoverColor, w.hoverOpacity); to = mixColor(to, w.hoverColor, w.hoverOpacity); }
    fill(ctx, gradient(ctx, pressed && style === 'luna' ? to : from, pressed && style === 'luna' ? from : to, 0, 0, 0, height), 0, 0, width, height);
    if (style === 'luna') {
      const edge = mixColor(w.controlText, from, geometry.active ? 0.12 : 0.5);
      ctx.strokeStyle = edge; ctx.lineWidth = 2; ctx.strokeRect(0, 0, width, height);
      ctx.globalAlpha = pressed ? 0.3 : 0.45;
      fill(ctx, pressed ? '#000000' : '#ffffff', 1, 1, width - 2, 1);
      fill(ctx, pressed ? '#000000' : '#ffffff', 1, 1, 1, height - 2);
      ctx.globalAlpha = 1;
    }
  }
  if (!w.glyphsOnHoverOnly || geometry.hovered) {
    ctx.fillStyle = style === 'fluent' && command === 0 && hovered ? '#ffffff' :
      style === 'fluent' && !geometry.active ? w.inactiveText : w.controlText;
    if (pressed && style !== 'fluent') ctx.translate(1, 1);
    glyph(ctx, theme, command, width, height, geometry.maximized);
  }
  ctx.restore();
}
function paintText(ctx, theme, geometry, title) {
  const [x, y, width, height] = geometry.text, w = theme.window;
  if (width <= 0 || height <= 0) return;
  ctx.save(); ctx.beginPath(); ctx.rect(x, y, width, height); ctx.clip();
  ctx.font = `${w.fontWeight} ${w.fontSize}px ${w.fontFamily}`;
  let label = Array.from(String(title).replace(/[\x00-\x1f\x7f]/g, ' ')).slice(0, 512).join('');
  if (ctx.measureText(label).width > width) {
    const chars = Array.from(label), suffix = '…';
    let low = 0, high = chars.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (ctx.measureText(chars.slice(0, mid).join('') + suffix).width <= width) low = mid;
      else high = mid - 1;
    }
    label = ctx.measureText(suffix).width <= width ? chars.slice(0, low).join('') + suffix : '';
  }
  const metrics = ctx.measureText(label), ascent = metrics.actualBoundingBoxAscent, descent = metrics.actualBoundingBoxDescent;
  const available = width - metrics.width;
  const left = x + (w.textAlign === 'center' ? available / 2 : w.textAlign === 'right' ? available : 0);
  const color = geometry.active ? w.titleText : w.inactiveText;
  const baseline = y + (height - ascent - descent) / 2 + ascent;
  ctx.textBaseline = 'alphabetic';
  if (w.surfaceStyle === 'luna' && geometry.active) {
    ctx.fillStyle = mixColor(color, '#000000', 0.7);
    ctx.fillText(label, left + 1, baseline + 1);
  }
  ctx.fillStyle = color;
  ctx.fillText(label, left, baseline);
  ctx.restore();
}
function paintTitle(ctx, theme, geometry, title) {
  const w = theme.window, { border, active } = geometry, width = geometry.width + 2 * border, height = geometry.title;
  ctx.beginPath(); ctx.roundRect(0, 0, width, height, [w.radius, w.radius, 0, 0]); ctx.clip();
  const from = active ? w.titleFrom : w.inactiveFrom, to = active ? w.titleTo : w.inactiveTo;
  const start = w.surfaceStyle === 'classic' && geometry.text[2] > 0 ? geometry.text[0] : border;
  const end = w.surfaceStyle === 'classic' && geometry.text[2] > 0 ? start + geometry.text[2] : width - border;
  if (w.surfaceStyle === 'luna' && w.gradientDir !== 'horizontal') {
    for (let y = 0; y < height; y++) fill(ctx, lunaBandColor(theme, active ? 'title' : 'inactive-title', y + 0.5, height), 0, y, width, 1);
  } else fill(ctx, gradient(ctx, from, to, w.gradientDir === 'horizontal' ? start : 0, 0,
    w.gradientDir === 'horizontal' ? Math.max(start + 1, end) : 0, w.gradientDir === 'horizontal' ? 0 : height), 0, 0, width, height);
  if (w.texture === 'pinstripe') {
    ctx.globalAlpha = w.stripeOpacity;
    for (let y = 0; y < height; y += w.stripeSpacing) fill(ctx, w.stripeColor, 0, y, width, w.stripeWidth);
    ctx.globalAlpha = 1;
  }
  if (w.surfaceStyle === 'luna') {
    fill(ctx, frameColor(theme, 1, 0, active), 0, 0, 1, height);
    fill(ctx, frameColor(theme, 1, 0, active), width - 1, 0, 1, height);
    ctx.globalAlpha = 0.25;
    fill(ctx, '#ffffff', 1, 0, 1, height); fill(ctx, '#ffffff', width - 2, 0, 1, height);
    ctx.globalAlpha = 1;
  } else for (let i = 0; i < border; i++) {
    fill(ctx, frameColor(theme, 0, i, active), i, i, width - 2 * i, 1);
    fill(ctx, frameColor(theme, 1, i, active), i, i, 1, height - i);
    fill(ctx, frameColor(theme, 2, i, active), width - 1 - i, i, 1, height - i);
  }
  if (w.surfaceStyle === 'classic') fill(ctx, theme.colors.body, border, height - 1, width - 2 * border, 1);
  paintText(ctx, theme, geometry, title);
  geometry.buttons.forEach((box, command) => paintControl(ctx, theme, geometry, command, box));
}

export function paintCaptionFrame({ document, theme, meta, title }) {
  const geometry = captionFrameGeometry(meta);
  return geometry.strips.map((strip, index) => {
    if (!strip.width || !strip.height) return { width: strip.width, height: strip.height, data: new Uint8ClampedArray(0) };
    const canvas = document.createElement('canvas');
    canvas.width = strip.width; canvas.height = strip.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('GUI offscreen Canvas2D is unavailable');
    ctx.scale(geometry.scale, geometry.scale);
    if (index === 0) paintTitle(ctx, theme, geometry, title);
    else paintEdge(ctx, theme, geometry, index);
    return ctx.getImageData(0, 0, strip.width, strip.height);
  });
}
