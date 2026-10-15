import { DESKTOP_THEMES } from './desktop/shared/ui/themes.mjs';
import { paintCaptionFrame, captionFrameGeometry } from './desktop/shared/ui/caption-paint.mjs';
import { decorationLayout } from './desktop/shared/ui/caption-layout.mjs';
import { mixColor } from './desktop/shared/ui/luna-primitives.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
function metadata(theme, width, state, scale) {
  const l = decorationLayout(theme), outer = width + 2 * l.border_width;
  const meta = [1, 1, 2, 0, width, 80, new Uint32Array(new Float32Array([scale]).buffer)[0],
    state, l.border_width, l.title_height, ...Array(16).fill(0)];
  let left = l.text_inset, right = outer - l.text_inset;
  for (let command = 0; command < 3; command++) {
    const index = l.left_controls && command ? 3 - command : command;
    const gap = index ? l.close_gap + (index - 1) * l.control_gap : 0;
    if (outer < (index + 1) * l.control_width + gap + 2 * l.control_inset) continue;
    const x = l.left_controls ? l.control_inset + index * l.control_width + gap :
      outer - l.control_inset - (index + 1) * l.control_width - gap;
    meta.splice(10 + command * 4, 4, x, l.control_top, l.control_width, l.control_height);
    if (l.left_controls) left = Math.max(left, x + l.control_width + l.text_gap);
    else right = Math.min(right, x - l.text_gap);
  }
  left = Math.min(left, outer);
  meta.splice(22, 4, left, l.border_width, Math.max(0, right - left), l.title_height - l.border_width);
  return meta;
}
function reference(theme, meta, label, shadow) {
  const g = captionFrameGeometry(meta), [x, y, width, height] = g.text, w = theme.window;
  const blank = paintCaptionFrame({ document, theme, meta, title: '' })[0];
  const canvas = document.createElement('canvas');
  canvas.width = blank.width; canvas.height = blank.height;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(blank, 0, 0);
  if (width > 0 && height > 0) {
    ctx.scale(g.scale, g.scale);
    ctx.beginPath(); ctx.roundRect(0, 0, g.width + 2 * g.border, g.title, [w.radius, w.radius, 0, 0]); ctx.clip();
    ctx.beginPath(); ctx.rect(x, y, width, height); ctx.clip();
    ctx.font = `${w.fontWeight} ${w.fontSize}px ${w.fontFamily}`;
    if (ctx.measureText(label).width > width) {
      const chars = Array.from(label);
      while (chars.length && ctx.measureText(chars.join('') + '…').width > width) chars.pop();
      label = ctx.measureText('…').width <= width ? chars.join('') + '…' : '';
    }
    const m = ctx.measureText(label);
    const left = x + (w.textAlign === 'center' ? (width - m.width) / 2 : w.textAlign === 'right' ? width - m.width : 0);
    const baseline = y + (height - m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2 + m.actualBoundingBoxAscent;
    ctx.textBaseline = 'alphabetic';
    if (shadow && g.active && w.surfaceStyle === 'luna') {
      ctx.fillStyle = mixColor(w.titleText, '#000000', 0.7);
      ctx.fillText(label, left + 1, baseline + 1);
    }
    ctx.fillStyle = g.active ? w.titleText : w.inactiveText;
    ctx.fillText(label, left, baseline);
  }
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}
export function checkLunaCaptionShadow(directory, expectShadow = true) {
  const xp = DESKTOP_THEMES.find(theme => theme.id === 'xp'), images = [];
  const cases = [
    [xp, 460, 1, 1, 'Luna caption', 'active'],
    [xp, 460, 0, 1, 'Luna caption', 'inactive'],
    [xp, 120, 1, 1, 'A long caption that must be clipped before controls', 'long'],
    [xp, 1, 1, 1, 'No text space', 'narrow'],
    [xp, 460, 1, 1.25, 'Luna caption', 'fractional'],
    [xp, 460, 1, 1, '', 'empty'],
    ...DESKTOP_THEMES.filter(theme => theme.id !== 'xp').map(theme =>
      [theme, 460, 1, 1, 'Caption', theme.id]),
  ];
  for (const [theme, width, state, scale, title, name] of cases) {
    const meta = metadata(theme, width, state, scale);
    const strips = paintCaptionFrame({ document, theme, meta, title });
    const actual = strips[0], expected = reference(theme, meta, title, expectShadow);
    check(actual.data.every((value, i) => value === expected.data[i]), name + ' exact clipped text composition');
    const plain = reference(theme, meta, title, false);
    let changed = 0, hash = 2166136261;
    for (let i = 0; i < actual.data.length; i += 4) {
      if (actual.data.slice(i, i + 4).some((value, c) => value !== plain.data[i + c])) changed++;
      for (let c = 0; c < 4; c++) hash = Math.imul(hash ^ actual.data[i + c], 16777619) >>> 0;
    }
    const shouldChange = expectShadow && theme === xp && state === 1 && !['narrow', 'empty'].includes(name);
    check(shouldChange ? changed > 0 : changed === 0, name + ' shadow scope');
    console.log('LUNA_SHADOW ' + JSON.stringify({ name, scale, meta, changedPixels: changed, hash }));
    if (theme === xp && scale === 1 && width === 460) images.push(actual);
    const blankStrips = paintCaptionFrame({ document, theme, meta, title: '' });
    strips.slice(1).forEach((strip, i) => check(strip.data.every((value, j) =>
      value === blankStrips[i + 1].data[j]), name + ' side strips unchanged'));
  }
  const canvas = document.createElement('canvas');
  canvas.width = 466; canvas.height = 90;
  Object.assign(canvas.style, { width: 466, height: 90, flexShrink: 0, alignSelf: 'flex-start' });
  const ctx = canvas.getContext('2d');
  images.forEach((image, i) => ctx.putImageData(image, 0, i * 30));
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
  document.body.appendChild(canvas); host.render();
  check(host.save(directory + '\\luna-caption-shadow.png'), 'Save actual GUI caption strips');
  document.body.removeChild(canvas);
  console.log('PASS: actual GUI Luna caption shadow scope, exact composition, long/narrow/empty, logical 1px at 1/1.25 scale');
}
