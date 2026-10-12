export const DESKTOP_GRID = Object.freeze({ width: 96, height: 104, inset: 16 });
const identityFields = ['name', 'make', 'model', 'serialNumber'];
const keys = (value, names) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === names;
const text = (value, maximum) => typeof value === 'string' && value.length > 0 &&
  value.length <= maximum && !/[\0-\x1f\x7f]/.test(value);

export function outputIdentity(head) {
  if (!head || !text(head.name, 256)) throw new Error('A stable output name is required to save desktop shortcuts');
  return Object.fromEntries(identityFields.map(field => [field, head[field] ?? '']));
}
export function outputKey(identity) { return JSON.stringify(identityFields.map(field => identity[field])); }
export function desktopOutputIdentity(output, heads) {
  // SDL display IDs and output-management head IDs belong to different namespaces.
  const named = heads.filter(head => head.enabled && (!output.name ||
    head.name === output.name || head.description === output.name));
  const candidates = output.name && named.length === 1 ? named : named.filter(head => head.x === output.x && head.y === output.y);
  return candidates.length === 1 ? outputIdentity(candidates[0]) : null;
}
export function validateDesktopShortcuts(value) {
  if (!keys(value, 'shortcuts,version') || value.version !== 1 ||
      !Array.isArray(value.shortcuts) || value.shortcuts.length > 128)
    throw new TypeError('Invalid desktop shortcut profile');
  const ids = new Set();
  return { version: 1, shortcuts: value.shortcuts.map(item => {
    if (!keys(item, 'id,name,output,x,y') || !text(item.id, 255) || !text(item.name, 256) ||
        ids.has(item.id) || !keys(item.output, 'make,model,name,serialNumber') ||
        !text(item.output.name, 256) || identityFields.some(field =>
          typeof item.output[field] !== 'string' || item.output[field].length > 256 ||
          /[\0-\x1f\x7f]/.test(item.output[field])) ||
        ['x', 'y'].some(field => !Number.isInteger(item[field]) || item[field] < 0 || item[field] > 32768))
      throw new TypeError('Invalid or duplicate desktop shortcut');
    ids.add(item.id);
    return { id: item.id, name: item.name, output: { ...item.output }, x: item.x, y: item.y };
  }) };
}
export function desktopArea(width, height, top = 0, bottom = 0) {
  const { inset, width: cellWidth, height: cellHeight } = DESKTOP_GRID;
  return { x: inset, y: inset + top,
    columns: Math.max(0, Math.floor((width - inset * 2) / cellWidth)),
    rows: Math.max(0, Math.floor((height - top - bottom - inset * 2) / cellHeight)) };
}
export function gridPoint(area, column, row) {
  return { x: area.x + column * DESKTOP_GRID.width, y: area.y + row * DESKTOP_GRID.height };
}
export function gridOrder(items) {
  return [...items].sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
}
export function layoutDesktop(items, area) {
  const available = [];
  for (let row = 0; row < area.rows; row++)
    for (let column = 0; column < area.columns; column++) available.push(gridPoint(area, column, row));
  const positions = new Map();
  for (const item of gridOrder(items)) {
    if (!available.length) break;
    let index = 0, distance = Infinity;
    available.forEach((point, i) => {
      const next = Math.abs(point.x - item.x) + Math.abs(point.y - item.y);
      if (next < distance) { distance = next; index = i; }
    });
    positions.set(item.id, available.splice(index, 1)[0]);
  }
  // Keep source order, not visual order: the reconciler is positional, not keyed.
  return items.filter(item => positions.has(item.id)).map(item => ({ ...item, ...positions.get(item.id) }));
}
export function moveDesktopGroup(items, selected, dx, dy, area) {
  const moving = items.filter(item => selected.has(item.id));
  if (!moving.length) return items;
  const originX = Math.min(...moving.map(item => item.x)), originY = Math.min(...moving.map(item => item.y));
  const spanX = Math.max(...moving.map(item => item.x)) - originX;
  const spanY = Math.max(...moving.map(item => item.y)) - originY;
  const occupied = new Set(items.filter(item => !selected.has(item.id)).map(item => item.x + ':' + item.y));
  let best = null, distance = Infinity;
  for (let row = 0; row < area.rows; row++) for (let column = 0; column < area.columns; column++) {
    const point = gridPoint(area, column, row);
    if (point.x + spanX > area.x + (area.columns - 1) * DESKTOP_GRID.width ||
        point.y + spanY > area.y + (area.rows - 1) * DESKTOP_GRID.height) continue;
    const x = point.x - originX, y = point.y - originY;
    if (moving.some(item => occupied.has((item.x + x) + ':' + (item.y + y)))) continue;
    const next = Math.abs(x - dx) + Math.abs(y - dy);
    if (next < distance) { distance = next; best = { x, y }; }
  }
  if (!best) throw new Error('There is no free grid placement for this shortcut group');
  return items.map(item => selected.has(item.id) ? { ...item, x: item.x + best.x, y: item.y + best.y } : item);
}
export function rangeSelection(items, anchor, target) {
  const order = gridOrder(items).map(item => item.id);
  let start = order.indexOf(anchor), end = order.indexOf(target);
  if (end < 0) return [];
  if (start < 0) start = end;
  return order.slice(Math.min(start, end), Math.max(start, end) + 1);
}
export function marqueeSelection(items, rectangle, base = new Set(), mode = 'replace') {
  const selected = mode === 'replace' ? new Set() : new Set(base);
  for (const item of items) {
    if (item.x < rectangle.x + rectangle.width && item.x + DESKTOP_GRID.width > rectangle.x &&
        item.y < rectangle.y + rectangle.height && item.y + DESKTOP_GRID.height > rectangle.y) {
      if (mode === 'toggle' && selected.has(item.id)) selected.delete(item.id);
      else selected.add(item.id);
    }
  }
  return selected;
}
export function adjacentShortcut(items, current, direction) {
  const order = gridOrder(items), origin = items.find(item => item.id === current);
  if (!origin) return order[0]?.id ?? null;
  const horizontal = direction === 'ArrowLeft' || direction === 'ArrowRight';
  const sign = direction === 'ArrowLeft' || direction === 'ArrowUp' ? -1 : 1;
  return items.filter(item => sign * (horizontal ? item.x - origin.x : item.y - origin.y) > 0)
    .sort((a, b) => {
      const score = item => Math.abs(horizontal ? item.y - origin.y : item.x - origin.x) * 1000 +
        Math.abs(horizontal ? item.x - origin.x : item.y - origin.y);
      return score(a) - score(b) || a.id.localeCompare(b.id);
    })[0]?.id ?? current;
}
