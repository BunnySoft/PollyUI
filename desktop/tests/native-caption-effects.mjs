import { DESKTOP_THEMES } from './desktop/shared/ui/themes.mjs';
import { paintCaptionFrame } from './desktop/shared/ui/caption-paint.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
const base = DESKTOP_THEMES.find(theme => theme.id === 'modern');
function paint(mode, scale, state) {
  const theme = { ...base, window: { ...base.window, radius: 16, titleHeight: 32, borderWidth: 0,
    surfaceStyle: 'generic' } };
  if (mode !== undefined) theme.window.nativeEffects = mode;
  const bits = new Uint32Array(new Float32Array([scale]).buffer)[0];
  const meta = [1, 1, 2, 0, 64, 64, bits, state, 0, theme.window.titleHeight, ...Array(16).fill(0)];
  return { strips: paintCaptionFrame({ document, theme, meta, title: '' }), meta };
}
for (const scale of [1, 1.25]) {
  const missing = paint(undefined, scale, 1), none = paint('none', scale, 1);
  check(missing.strips.every((strip, index) =>
    strip.data.every((value, offset) => value === none.strips[index].data[offset])),
  'Explicit none must retain every default strip byte');
  check(missing.strips[0].data[3] === 0, 'Legacy top corner must retain its original clip');
  for (const mode of ['rounded', 'rounded-shadow']) for (const state of [1, 3]) {
    const { strips, meta } = paint(mode, scale, state), top = strips[0];
    for (let offset = 3; offset < top.data.length; offset += 4)
      check(top.data[offset] === 255, 'Native outline must be the only outer coverage, including maximized captions');
    console.log('NATIVE_CAPTION ' + JSON.stringify({
      width: 64, height: 64, title: meta[9], radius: 16, scale: meta[6], state,
      pixelWidth: top.width, pixelHeight: top.height,
      rgba: Array.from(top.data, value => value.toString(16).padStart(2, '0')).join(''),
    }));
  }
}
console.log('PASS: real GUI caption strips are rectangular only for native outline opt-in; default/none bytes retained');
