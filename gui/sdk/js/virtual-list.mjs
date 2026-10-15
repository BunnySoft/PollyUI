export function fixedRowWindow(count, rowHeight, height, scrollTop = 0) {
  const total = count * rowHeight;
  const maximum = Math.max(0, total - height);
  const offset = Math.max(0, Math.min(maximum, scrollTop));
  return {
    total, maximum, offset,
    start: Math.max(0, Math.floor(offset / rowHeight) - 2),
    end: Math.min(count, Math.ceil((offset + height) / rowHeight) + 2),
  };
}
