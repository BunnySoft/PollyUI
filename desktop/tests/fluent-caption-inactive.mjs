import { DESKTOP_THEMES } from './desktop/shared/ui/themes.mjs';
import { paintCaptionFrame, captionFrameGeometry } from './desktop/shared/ui/caption-paint.mjs';
import { decorationLayout } from './desktop/shared/ui/caption-layout.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
function metadata(theme, state, width = 460, scale = 1) {
  const l = decorationLayout(theme), outer = width + 2 * l.border_width;
  const meta = [1, 1, 2, 0, width, 80, new Uint32Array(new Float32Array([scale]).buffer)[0],
    state, l.border_width, l.title_height, ...Array(16).fill(0)];
  for (let command = 0; command < 3; command++) {
    const index = l.left_controls && command ? 3 - command : command;
    const gap = index ? l.close_gap + (index - 1) * l.control_gap : 0;
    if (outer < (index + 1) * l.control_width + gap + 2 * l.control_inset) continue;
    const x = l.left_controls ? l.control_inset + index * l.control_width + gap :
      outer - l.control_inset - (index + 1) * l.control_width - gap;
    meta.splice(10 + command * 4, 4, x, l.control_top, l.control_width, l.control_height);
  }
  return meta;
}
const paint = (theme, meta) => paintCaptionFrame({ document, theme, meta, title: '' });
const ink = (theme, color) => ({ ...theme, window: { ...theme.window, controlText: color } });
export function checkFluentInactiveCaption(directory, expectFixed = true) {
  const modern = DESKTOP_THEMES.find(theme => theme.id === 'modern'), images = [];
  const custom = { ...modern, window: { ...modern.window, inactiveText: '#397d51' } };
  const cases = [
    [modern, 0, 460, 1, 'inactive'],
    [modern, 32, 460, 1, 'close-hover'],
    [modern, 36, 460, 1, 'close-held'],
    [modern, 64, 460, 1, 'maximize-hover'],
    [modern, 72, 460, 1, 'maximize-held'],
    [modern, 96, 460, 1, 'minimize-hover'],
    [modern, 112, 460, 1, 'minimize-held'],
    [modern, 2, 460, 1, 'restore'],
    [modern, 0, 460, 1.25, 'fractional'],
    [modern, 0, 1, 1, 'narrow'],
    [custom, 0, 460, 1, 'custom-inactive-ink'],
    ...[1, 33, 37, 65, 73, 97, 113, 3].map(state => [modern, state, 460, 1, 'active-' + state]),
    ...DESKTOP_THEMES.filter(theme => theme !== modern).map(theme => [theme, 0, 460, 1, theme.id]),
  ];
  for (const [theme, state, width, scale, name] of cases) {
    const meta = metadata(theme, state, width, scale), geometry = captionFrameGeometry(meta);
    const actual = paint(theme, meta), fluent = theme.window.surfaceStyle === 'fluent';
    const changesInk = expectFixed && fluent && !geometry.active;
    const expected = paint(changesInk ? ink(theme, theme.window.inactiveText) : theme, meta);
    const old = paint({ ...theme, window: { ...theme.window, inactiveText: theme.window.controlText } }, meta);
    let changed = 0, outside = 0, hash = 2166136261;
    actual.forEach((strip, stripIndex) => check(strip.data.every((value, i) =>
      value === expected[stripIndex].data[i]), name + ' configured glyph ink'));
    for (let offset = 0; offset < actual[0].data.length; offset += 4) {
      const x = (offset / 4 % actual[0].width + 0.5) / scale;
      const y = (Math.floor(offset / 4 / actual[0].width) + 0.5) / scale;
      if (actual[0].data.slice(offset, offset + 4).some((value, c) => value !== old[0].data[offset + c])) {
        changed++;
        if (!geometry.buttons.some(([bx, by, bw, bh], command) =>
          !(command === 0 && geometry.hovered === 1) && x >= bx && x < bx + bw && y >= by && y < by + bh))
          outside++;
      }
      for (let c = 0; c < 4; c++) hash = Math.imul(hash ^ actual[0].data[offset + c], 16777619) >>> 0;
    }
    check(changesInk && width > 1 ? changed > 0 : changed === 0, name + ' inactive-only change');
    check(outside === 0, name + ' no changes outside glyph-owning controls or on close hover');
    actual.slice(1).forEach((strip, i) => check(strip.data.every((value, j) =>
      value === old[i + 1].data[j]), name + ' unchanged side strips'));
    const minimum = geometry.buttons[2];
    if (changesInk && minimum[2] && scale === 1) {
      const color = parseInt(theme.window.inactiveText.slice(1), 16);
      let solid = 0;
      for (let y = minimum[1]; y < minimum[1] + minimum[3]; y++)
        for (let x = minimum[0]; x < minimum[0] + minimum[2]; x++) {
          const at = (y * actual[0].width + x) * 4;
          if ([16, 8, 0].every((shift, i) => actual[0].data[at + i] === (color >> shift & 255))) solid++;
        }
      check(solid > 0, name + ' minimize solid glyph consumes inactiveText exactly');
    }
    console.log('FLUENT_INACTIVE ' + JSON.stringify({ name, scale, meta, changedPixels: changed, outside, hash }));
    if (theme === modern && scale === 1 && width === 460 && images.length < 8) images.push(actual[0]);
  }
  const canvas = document.createElement('canvas');
  canvas.width = 462; canvas.height = 33 * images.length;
  Object.assign(canvas.style, { width: canvas.width, height: canvas.height, flexShrink: 0, alignSelf: 'flex-start' });
  const ctx = canvas.getContext('2d');
  images.forEach((image, i) => ctx.putImageData(image, 0, i * 33));
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
  document.body.appendChild(canvas); host.render();
  check(host.save(directory + '\\fluent-caption-inactive.png'), 'Save actual GUI caption evidence');
  document.body.removeChild(canvas);
  console.log('PASS: actual Fluent inactive caption ink, hover/held/restore, custom color, narrow/scale and unchanged active/non-Fluent');
}
