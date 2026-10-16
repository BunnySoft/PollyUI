import { DESKTOP_THEMES } from './desktop/shared/ui/themes.mjs';
import { fitCaptionText, paintCaptionFrame } from './desktop/shared/ui/caption-paint.mjs';
import { parseThemeFile } from './desktop/shared/ui/theme-schema.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
check(typeof textBoundaries === 'function', 'This fixture requires the real native Linux ICU boundary API');
const canvas = document.createElement('canvas');
canvas.width = 800; canvas.height = 80;
const ctx = canvas.getContext('2d');
ctx.font = '400 14px DejaVu Sans';
function oldFit(context, title, width) {
  let label = Array.from(String(title).replace(/[\x00-\x1f\x7f]/g, ' ')).slice(0, 512).join('');
  if (context.measureText(label).width > width) {
    const chars = Array.from(label);
    let low = 0, high = chars.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (context.measureText(chars.slice(0, mid).join('') + '…').width <= width) low = mid;
      else high = mid - 1;
    }
    label = context.measureText('…').width <= width ? chars.slice(0, low).join('') + '…' : '';
  }
  return label;
}
function oracle(title, width) {
  const source = String(title).replace(/[\x00-\x1f\x7f]/g, ' ');
  const capped = Array.from(source).slice(0, 512).join('');
  const end = textBoundaries(source).filter(index => index <= capped.length).at(-1);
  const label = source.slice(0, end);
  if (ctx.measureText(label).width <= width) return label;
  let result = '';
  for (const index of textBoundaries(label)) {
    const candidate = label.slice(0, index) + '…';
    if (ctx.measureText(candidate).width <= width) result = candidate;
  }
  return result;
}
let repaired = 0, capRepairs = 0;
for (const cluster of ['A\u0301\u0327', '👩‍💻', '🇨🇦']) {
  const boundaries = textBoundaries(cluster);
  check(boundaries.length === 2 && boundaries[0] === 0 && boundaries[1] === cluster.length,
    'Native ICU recognizes one complete cluster: ' + cluster);
  const title = 'Prefix ' + cluster.repeat(3) + ' end';
  const suffix = ctx.measureText('…').width;
  const widths = [0, suffix / 2, suffix, ctx.measureText(title).width,
    ...Array.from(title).map((_, index, points) => ctx.measureText(points.slice(0, index + 1).join('') + '…').width)];
  for (const width of widths) {
    const actual = fitCaptionText(ctx, title, width);
    check(actual === oracle(title, width), 'Whole-prefix fitting disagrees with native ICU oracle');
    check(ctx.measureText(actual).width <= width || actual === '', 'Fitted caption exceeds its text box');
    const prefix = actual.endsWith('…') ? actual.slice(0, -1) : actual;
    check(textBoundaries(title).includes(prefix.length), 'Caption split a native ICU grapheme');
    if (actual !== oldFit(ctx, title, width)) repaired++;
  }
  const long = 'x'.repeat(511) + cluster + 'tail';
  check(fitCaptionText(ctx, long, 100000) === 'x'.repeat(511), '512-codepoint cap split a grapheme');
  if (fitCaptionText(ctx, long, 100000) !== oldFit(ctx, long, 100000)) capRepairs++;
}
check(capRepairs === 3, 'Native fixture must repair cap splits for combining, ZWJ and flag clusters');
for (const title of ['', 'Caption', 'A long ASCII title with ffi and AV pairs', 'A\0B\tC\nD\u007f', 'x'.repeat(520)])
  for (const width of [0, 1, 8, 30, 160, 500, 100000])
    check(fitCaptionText(ctx, title, width) === oldFit(ctx, title, width), 'ASCII/cap behavior changed');

function metadata(theme, width = 280) {
  const w = theme.window;
  return [1, 1, 2, 0, 400, 80, new Uint32Array(new Float32Array([1]).buffer)[0], 1,
    w.borderWidth, w.titleHeight, ...Array(12).fill(0),
    w.borderWidth + 8, w.borderWidth, width, w.titleHeight - w.borderWidth];
}
function recordingDocument(transform, labels) {
  return {
    createElement(name) {
      const node = document.createElement(name);
      return {
        set width(value) { node.width = value; },
        set height(value) { node.height = value; },
        getContext(kind) {
          const context = node.getContext(kind);
          return new Proxy(context, {
            get(target, key) {
              if (key === 'fillText') return (label, ...args) => {
                const final = transform ? transform(target) : label;
                labels.push(final);
                return target.fillText(final, ...args);
              };
              const value = target[key];
              return typeof value === 'function' ? value.bind(target) : value;
            },
            set(target, key, value) { target[key] = value; return true; },
          });
        },
      };
    },
  };
}
for (const theme of DESKTOP_THEMES) {
  for (const title of ['', 'Caption', 'A long ASCII caption that exceeds the narrow native title text box']) {
    const meta = metadata(theme, title.length > 20 ? 80 : 280);
    const actual = paintCaptionFrame({ document, theme, meta, title });
    const reference = paintCaptionFrame({ document: recordingDocument(context =>
      oldFit(context, title, meta[24]), []), theme, meta, title });
    check(actual.length === 4 && actual.every((strip, index) =>
      strip.width === reference[index].width && strip.height === reference[index].height &&
      strip.data.every((value, offset) => value === reference[index].data[offset])),
    theme.id + ' ASCII/empty/ellipsis full-strip pixels changed');
  }
  const labels = [], title = 'A\u0301\u0327👩‍💻🇨🇦 title';
  const narrow = metadata(theme, 50);
  const painted = paintCaptionFrame({ document: recordingDocument(null, labels), theme, meta: narrow, title });
  const blank = paintCaptionFrame({ document, theme, meta: narrow, title: '' });
  check(labels.length > 0 && labels.every(label => {
    const prefix = label.endsWith('…') ? label.slice(0, -1) : label;
    return textBoundaries(title).includes(prefix.length);
  }), theme.id + ' did not use the shared grapheme-safe fitter');
  const [x, y, width, height] = narrow.slice(22);
  for (let row = 0; row < painted[0].height; row++)
    for (let col = 0; col < painted[0].width; col++) {
      if (col >= x && col < x + width && row >= y && row < y + height) continue;
      const offset = (row * painted[0].width + col) * 4;
      for (let channel = 0; channel < 4; channel++)
        check(painted[0].data[offset + channel] === blank[0].data[offset + channel],
          theme.id + ' text/shadow escaped its real Canvas clip');
    }
  for (let side = 1; side < 4; side++)
    check(painted[side].data.every((value, index) => value === blank[side].data[index]),
      theme.id + ' caption text changed a side strip');
}
const theme = DESKTOP_THEMES.at(-1);
for (const family of ['sans-serif', 'serif', 'monospace', 'DejaVu Sans']) {
  const custom = parseThemeFile(JSON.stringify({ schemaVersion: 1,
    theme: { ...theme, window: { ...theme.window, fontFamily: family } } }));
  ctx.font = `400 14px ${family}`;
  check(ctx.font === `400 14px ${family}` && ctx.measureText('AV ffi Caption').width > 0,
    'Native Canvas did not accept the literal family: ' + family);
  const strips = paintCaptionFrame({ document, theme: custom, meta: metadata(custom), title: 'AV ffi Caption' });
  const blank = paintCaptionFrame({ document, theme: custom, meta: metadata(custom), title: '' });
  check(strips[0].data.some((value, i) => value !== blank[0].data[i]), 'Named/generic family did not draw caption pixels');
}
const serifWidth = (ctx.font = '400 24px DejaVu Serif', ctx.measureText('WWiiAV ffi').width);
const sansWidth = (ctx.font = '400 24px DejaVu Sans', ctx.measureText('WWiiAV ffi').width);
check(serifWidth !== sansWidth, 'Installed named font families did not select distinguishable native metrics');
console.log('CAPTION_TEXT_NATIVE ' + JSON.stringify({ capRepairs, ellipsisRepairs: repaired, themes: DESKTOP_THEMES.length,
  boundaryBackend: 'native Linux ICU', namedFamily: 'DejaVu Sans', serifWidth, sansWidth }));
console.log('PASS: native Linux ICU caption clusters, 512 cap, measured ellipsis, six-theme exact ASCII strips and installed named-font Canvas pixels');
