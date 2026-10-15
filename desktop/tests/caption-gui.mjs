import { DESKTOP_THEMES } from './desktop/shared/ui/themes.mjs';
import { paintCaptionFrame, captionFrameGeometry } from './desktop/shared/ui/caption-paint.mjs';
import { decorationLayout } from './desktop/shared/ui/caption-layout.mjs';
const check = (value, message) => { if (!value) throw new Error(message); };

function metadata(theme, { width = 460, height = 200, scale = 1, state = 1 } = {}) {
  const l = decorationLayout(theme), outer = width + l.border_width * 2;
  const words = [1, 1, 2, 0, width, height, new Uint32Array(new Float32Array([scale]).buffer)[0], state,
    l.border_width, l.title_height, ...Array(16).fill(0)];
  let left = Math.min(outer, l.text_inset), right = outer - l.text_inset;
  for (let command = 0; command < 3; command++) {
    const index = command === 0 ? 0 : l.left_controls ? (command === 2 ? 1 : 2) : command;
    const gap = index ? l.close_gap + (index - 1) * l.control_gap : 0;
    if (outer < (index + 1) * l.control_width + gap + 2 * l.control_inset) continue;
    const x = l.left_controls ? l.control_inset + index * l.control_width + gap :
      outer - l.control_inset - (index + 1) * l.control_width - gap;
    words.splice(10 + command * 4, 4, x, l.control_top, l.control_width, l.control_height);
    if (l.left_controls) left = Math.max(left, x + l.control_width + l.text_gap);
    else right = Math.min(right, x - l.text_gap);
  }
  left = Math.min(outer, left);
  words.splice(22, 4, left, l.border_width, Math.max(0, right - left), l.title_height - l.border_width);
  return words;
}
function blackGlyph(image, box) {
  const [left, top, width, height] = box, points = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = ((top + y) * image.width + left + x) * 4;
    if (image.data[offset] === 0 && image.data[offset + 1] === 0 &&
        image.data[offset + 2] === 0 && image.data[offset + 3] === 255) points.push([x, y]);
  }
  if (!points.length) return null;
  const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs) + 1,
    Math.max(...ys) - Math.min(...ys) + 1, points.length];
}
export function checkCaptionCanvas(directory) {
  const boundDocument = document;
  const server = DESKTOP_THEMES.find(theme => theme.id === 'server2003');
  let active, inactive;
  for (const theme of DESKTOP_THEMES) {
    const meta = metadata(theme);
    const strips = paintCaptionFrame({ document: boundDocument, theme, meta, title: 'Caption shaping 字体' });
    const geometry = captionFrameGeometry(meta);
    check(strips.length === 4, 'Exactly four native strips');
    strips.forEach((strip, index) => check(strip.width === geometry.strips[index].width &&
      strip.height === geometry.strips[index].height && strip.data.length === strip.width * strip.height * 4,
    theme.id + ' exact RGBA strip shape'));
    console.log('CAPTION_GUI ' + JSON.stringify({ theme: theme.id, meta,
      strips: strips.map(image => [image.width, image.height, image.data.length]) }));
  }
  const meta = metadata(server);
  active = paintCaptionFrame({ document: boundDocument, theme: server, meta, title: '' })[0];
  const boxes = captionFrameGeometry(meta).buttons;
  const expected = [[4, 3, 8, 7, 26], [3, 2, 9, 9, 39], [4, 9, 6, 2, 12]];
  boxes.forEach((box, command) => check(JSON.stringify(blackGlyph(active, box)) === JSON.stringify(expected[command]),
    'Classic glyph geometry ' + command));
  const pressed = paintCaptionFrame({ document: boundDocument, theme: server,
    meta: metadata(server, { state: 37 }), title: '' })[0];
  check(JSON.stringify(blackGlyph(pressed, boxes[0])) === '[5,4,8,7,26]', 'Pressed glyph moves exactly 1px');
  inactive = paintCaptionFrame({ document: boundDocument, theme: server,
    meta: metadata(server, { state: 0 }), title: 'Inactive caption' })[0];
  for (const width of [1, 8, 24, 48]) {
    const narrow = metadata(server, { width });
    const strips = paintCaptionFrame({ document: boundDocument, theme: server, meta: narrow, title: 'Narrow caption' });
    check(strips[0].width === width + 8, 'Narrow caption preserves native width');
  }
  const fractional = paintCaptionFrame({ document: boundDocument, theme: server,
    meta: metadata(server, { scale: 1.25 }), title: 'Fractional caption' });
  check(fractional[0].width === 585 && fractional[0].height === 29, 'Exact fractional backing dimensions');
  const canvas = boundDocument.createElement('canvas');
  canvas.width = 468; canvas.height = 80;
  Object.assign(canvas.style, { width: 468, height: 80, flexShrink: 0, alignSelf: 'flex-start' });
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = server.colors.body; ctx.fillRect(0, 0, 468, 80);
  ctx.putImageData(active, 0, 0); ctx.putImageData(inactive, 0, 40);
  while (boundDocument.body.firstChild) boundDocument.body.removeChild(boundDocument.body.firstChild);
  boundDocument.body.appendChild(canvas);
  host.render();
  check(host.save(directory + '\\caption-gui-actual.png'), 'Save actual GUI caption evidence');
  boundDocument.body.removeChild(canvas);
  console.log('PASS: actual detached GUI Canvas strips, six retained routes, Classic glyphs/press/narrow/scale');
}
