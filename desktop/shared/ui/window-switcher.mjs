export function windowSwitcherStyle(value) {
  if (!['list', 'thumbnails', 'flip3d'].includes(value))
    throw new TypeError('Unknown window switcher style');
  return value;
}

export function windowSwitcherMotion(value) {
  if (typeof value !== 'boolean') throw new TypeError('Window switcher motion must be boolean');
  return value;
}

export function windowProjectionSize(theme, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
    throw new TypeError('3D window switching requires an actual output extent');
  return { width: Math.max(1, Math.min(1000, width - theme.layout.switcherInset * 2)),
    height: Math.max(1, Math.min(640, height - theme.layout.switcherInset * 2)) };
}

export function windowProjectionViewport(theme, width, height) {
  const header = Math.max(48, theme.layout.headingFontSize + 24);
  const footer = Math.max(64, theme.layout.statusFontSize * 4 + 16);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 192 || height - header - footer < 120)
    return null;
  return { x: 16, y: header, width: width - 32, height: height - header - footer };
}

function metrics(theme, width) {
  return { padding: 16, gap: 10,
    header: Math.max(48, theme.layout.headingFontSize + 24),
    footer: Math.max(56, theme.layout.statusFontSize * 3 + 16),
    columns: Math.max(1, Math.min(3, Math.floor((width - 32 + 10) / 190))) };
}

export function windowSwitcherSize(theme, snapshot, outputWidth, outputHeight) {
  if (!Number.isInteger(outputWidth) || !Number.isInteger(outputHeight) ||
      outputWidth < 1 || outputHeight < 1 || !snapshot.items.length)
    throw new TypeError('Window preview sizing requires a current output and candidates');
  const maximumWidth = Math.max(1, Math.min(880, outputWidth - theme.layout.switcherInset * 2));
  const desiredColumns = Math.min(metrics(theme, maximumWidth).columns, snapshot.items.length);
  const width = Math.min(maximumWidth, 32 + desiredColumns * 276 + (desiredColumns - 1) * 10);
  const maximumHeight = Math.max(1, Math.min(736, outputHeight - theme.layout.switcherInset * 2));
  const { header, footer, gap, columns } = metrics(theme, width);
  const availableRows = Math.max(1, Math.min(3, Math.floor((maximumHeight - header - footer + gap) / 160)));
  const rows = Math.min(availableRows, Math.ceil(snapshot.items.length / columns));
  return { width, height: Math.min(maximumHeight, header + footer + rows * 200 + (rows - 1) * gap) };
}

export function windowSwitcherGrid(theme, snapshot, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      !Array.isArray(snapshot.items) || !snapshot.items.length ||
      !Number.isInteger(snapshot.selected) || snapshot.selected < 0 || snapshot.selected >= snapshot.items.length)
    throw new TypeError('A current switcher selection and positive viewport are required');
  const measured = metrics(theme, width);
  const { padding, gap, header, footer } = measured;
  const columns = Math.min(measured.columns, snapshot.items.length);
  const rows = Math.max(1, Math.min(3, Math.floor((height - header - footer + gap) / 160)));
  const cardWidth = Math.floor((width - padding * 2 - (columns - 1) * gap) / columns);
  const cardHeight = Math.floor((height - header - footer - (rows - 1) * gap) / rows);
  if (cardWidth < 128 || cardHeight < 100) return null;
  const capacity = rows * columns;
  const start = Math.floor(snapshot.selected / capacity) * capacity;
  const slots = snapshot.items.slice(start, start + capacity).map((item, offset) => ({
    item, index: start + offset,
    x: padding + offset % columns * (cardWidth + gap),
    y: header + Math.floor(offset / columns) * (cardHeight + gap),
    width: cardWidth, height: cardHeight,
    imageWidth: Math.min(256, cardWidth - 16), imageHeight: Math.min(160, cardHeight - 40),
  }));
  return { width, height, header, footer, start, capacity, slots };
}
