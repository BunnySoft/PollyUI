import { nextTextIndex, clampTextIndex } from './gui/sdk/js/textindex.mjs';
import { requireFontFamily } from './gui/sdk/js/font-family.mjs';

const cache = new Map();
export function textGeometry(value, size, family, weight = 400) {
  requireFontFamily(family);
  const key = JSON.stringify([size, family, weight, value]);
  let layout = cache.get(key);
  if (!layout) {
    const measure = text => family === undefined && weight === 400 ? measureText(text, size) : measureText(text, size, weight, family);
    if (typeof layoutText === 'function') layout = family === undefined && weight === 400 ?
      layoutText(value, size) : layoutText(value, size, weight, family);
    else {
      const clusters = [];
      for (let start = 0; start < value.length;) {
        const end = nextTextIndex(value, start), x = measure(value.slice(0, start));
        clusters.push({ start, end, x, width: measure(value.slice(0, end)) - x, rtl: false });
        start = end;
      }
      layout = { clusters, width: measure(value) };
    }
    if (cache.size >= 32) cache.delete(cache.keys().next().value);
    if (value.length <= 16384) cache.set(key, layout);
  }
  const caret = index => {
    index = clampTextIndex(value, index);
    const cluster = layout.clusters.find(item => item.start === index);
    if (cluster) return cluster.x + (cluster.rtl ? cluster.width : 0);
    const last = layout.clusters[layout.clusters.length - 1];
    return last ? last.x + (last.rtl ? 0 : last.width) : 0;
  };
  return {
    width: layout.width,
    caret,
    nearest(x) {
      let best = 0, distance = Infinity;
      for (const item of layout.clusters) {
        for (const [index, position] of [[item.start, item.x + (item.rtl ? item.width : 0)],
          [item.end, item.x + (item.rtl ? 0 : item.width)]]) {
          const d = Math.abs(position - x);
          if (d < distance) { distance = d; best = index; }
        }
      }
      return best;
    },
    ranges(start, end) {
      const selected = layout.clusters.filter(item => item.start < end && item.end > start)
        .map(item => ({ x: item.x, width: item.width })).sort((a, b) => a.x - b.x);
      const ranges = [];
      for (const item of selected) {
        const last = ranges[ranges.length - 1];
        if (last && item.x <= last.x + last.width + 0.01)
          last.width = Math.max(last.width, item.x + item.width - last.x);
        else ranges.push({ ...item });
      }
      return ranges;
    },
  };
}
