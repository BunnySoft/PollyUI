import { DESKTOP_THEMES, BUILTIN_THEME_CATALOG } from './desktop/shared/ui/themes.mjs';
import { applyThemeOverrides } from './desktop/shared/ui/theme-schema.mjs';
import { paintCaptionFrame, captionFrameGeometry } from './desktop/shared/ui/caption-paint.mjs';
import { decorationLayout } from './desktop/shared/ui/caption-layout.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
function metadata(theme, state, width = 300, scale = 1) {
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
const paint = (theme, meta, title = '') => paintCaptionFrame({ document, theme, meta, title });
const same = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);
function differences(a, b, scale, boxes) {
  let count = 0, outside = 0;
  const perBox = boxes.map(() => 0);
  for (let at = 0; at < a.data.length; at += 4) {
    if ([0, 1, 2, 3].every(c => a.data[at + c] === b.data[at + c])) continue;
    count++;
    const x = (at / 4 % a.width + 0.5) / scale;
    const y = (Math.floor(at / 4 / a.width) + 0.5) / scale;
    let inside = false;
    boxes.forEach(([bx, by, bw, bh], i) => {
      if (x >= bx && x < bx + bw && y >= by && y < by + bh) { inside = true; perBox[i]++; }
    });
    if (!inside) outside++;
  }
  return { count, outside, perBox };
}
function hash(image) {
  let result = 2166136261;
  for (const value of image.data) result = Math.imul(result ^ value, 16777619) >>> 0;
  return result;
}

export function checkBigSurCaptionSurface(directory) {
  check(host.width === 400 && host.height === 320, 'Unscaled 400x320 caption evidence surface');
  const theme = DESKTOP_THEMES.find(item => item.id === 'bigsur');
  const guards = DESKTOP_THEMES.filter(item => item !== theme).map(other => ({
    theme: other, meta: metadata(other, 0), strips: paint(other, metadata(other, 0)),
  }));
  const snapshots = [];
  for (const state of [0, 1, 32, 33, 64, 65, 96, 97, 37, 73, 113, 3]) {
    const meta = metadata(theme, state), g = captionFrameGeometry(meta), strips = paint(theme, meta);
    check(JSON.stringify(g.buttons) === JSON.stringify([[12, 8, 12, 12], [52, 8, 12, 12], [32, 8, 12, 12]]),
      'Default native-metadata contract retains left close/minimize/maximize order');
    const titleAt = (12 * strips[0].width + 250) * 4;
    const titleColor = parseInt((g.active ? theme.window.titleFrom : theme.window.inactiveFrom).slice(1), 16);
    check([16, 8, 0].every((shift, i) => strips[0].data[titleAt + i] === (titleColor >> shift & 255)),
      'Blank active/inactive caption uses the current solid title palette');
    const recolored = paint({ ...theme, window: { ...theme.window, controlText: '#00ffff' } }, meta);
    const glyphs = differences(strips[0], recolored[0], 1, g.buttons);
    check(glyphs.outside === 0 && (g.hovered ? glyphs.perBox.every(n => n > 0) : glyphs.count === 0),
      'Current hover-only policy shows the whole group, with no glyph ink outside controls');
    const noHover = paint(theme, metadata(theme, Number(g.active)))[0];
    const hover = differences(strips[0], noHover, 1, g.buttons);
    check(hover.outside === 0, 'Hover/pressed states cannot alter title text or surrounding frame');
    const hoverOpacity = value => paint({ ...theme, window: { ...theme.window, hoverOpacity: value } }, meta)[0];
    const hot = differences(hoverOpacity(0), hoverOpacity(1), 1, g.buttons);
    check(hot.outside === 0 && hot.perBox.every((n, i) => g.hovered === i + 1 ? n > 0 : n === 0),
      'Hover opacity affects only the actual hovered control face, not the group glyph policy');
    if (g.pressed) {
      const unpressed = paint(theme, metadata(theme, state & ~28))[0];
      const down = differences(strips[0], unpressed, 1, g.buttons);
      const command = g.pressed === 1 ? 0 : g.pressed === 2 ? 1 : 2;
      check(down.count > 0 && down.outside === 0 && down.perBox.every((n, i) => i === command ? n > 0 : n === 0),
        'Held glyph changes only its own control while the pointer remains over that control');
    }
    const opacity = value => paint({ ...theme, window: { ...theme.window, inactiveOpacity: value } }, meta)[0];
    const inactive = differences(opacity(0), opacity(1), 1, g.buttons);
    check(g.active ? inactive.count === 0 : inactive.perBox.every(n => n > 0),
      'Inactive opacity is consumed only when inactive');
    check(inactive.outside === 0, 'Inactive control mixing stays in its own rectangles');
    snapshots.push(strips[0]);
    console.log('BIGSUR_CAPTION_STATE ' + JSON.stringify({ state, meta, hash: hash(strips[0]),
      glyphPixels: glyphs.perBox, inactiveOpacityPixels: inactive.count }));
  }
  const custom = applyThemeOverrides(BUILTIN_THEME_CATALOG, JSON.stringify({ schemaVersion: 1,
    themes: { bigsur: { window: { controlSize: 16, controlTop: 7, titleHeight: 34,
      controlGap: 6, controlInset: 10, glyphsOnHoverOnly: false, controlText: '#174a65' } } } }))
    .themes.find(item => item.id === 'bigsur');
  for (const current of [theme, custom]) for (const width of [1, 20, 44, 64, 300]) {
    const meta = metadata(current, 1, width), g = captionFrameGeometry(meta);
    const empty = paint(current, meta), text = paint(current, meta, 'A long title must stay inside its native text rectangle');
    const delta = differences(empty[0], text[0], 1, [g.text]);
    check(delta.outside === 0 && (g.text[2] > 0 || delta.count === 0), 'Long/empty/narrow titles stay clipped');
    check(text.slice(1).every((strip, i) => same(strip.data, empty[i + 1].data)),
      'Title changes do not alter side or bottom strips');
    check(empty[0].width === width + 2 * current.window.borderWidth, 'Native strip width is not stretched');
    const ink = paint({ ...current, window: { ...current.window, controlText: '#ff00ff' } }, meta);
    const glyphs = differences(empty[0], ink[0], 1, g.buttons);
    check(glyphs.outside === 0 && (current.window.glyphsOnHoverOnly ? glyphs.count === 0 :
      glyphs.perBox.every((n, i) => g.buttons[i][2] ? n > 0 : n === 0)), 'Configured always-visible glyphs consume current ink');
    console.log('BIGSUR_CAPTION_GEOMETRY ' + JSON.stringify({ custom: current === custom, width, meta,
      hash: hash(empty[0]), glyphPixels: glyphs.perBox, titlePixels: delta.count }));
  }
  const fractionalMeta = metadata(custom, 33, 300, 1.25);
  const fractional = paint(custom, fractionalMeta);
  check(fractional[0].width === 378 && fractional[0].height === 43,
    '1.25 backing dimensions are ceiled without changing logical geometry');
  for (const guard of guards) {
    const after = paint(guard.theme, guard.meta);
    check(after.every((strip, i) => same(strip.data, guard.strips[i].data)), 'No state leaks into other preset strips');
    console.log('CAPTION_GUARD ' + JSON.stringify({ theme: guard.theme.id, hash: hash(after[0]) }));
  }
  const canvas = document.createElement('canvas');
  canvas.width = 302; canvas.height = 28 * 10;
  Object.assign(canvas.style, { width: canvas.width, height: canvas.height, flexShrink: 0, alignSelf: 'flex-start' });
  const ctx = canvas.getContext('2d');
  snapshots.slice(0, 10).forEach((image, i) => ctx.putImageData(image, 0, i * 28));
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
  document.body.appendChild(canvas); host.render();
  check(host.save(directory + '\\bigsur-caption-states.png'), 'Save actual caption strips, not native macOS');
  document.body.removeChild(canvas);
  console.log('PASS: current Big Sur caption state/field/geometry contract; no product fix or OS-exact certification');
}
