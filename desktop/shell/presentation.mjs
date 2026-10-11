import { h } from './gui/sdk/js/reconciler.mjs';

export const desktopType = { fontFamily: 'sans-serif', fontSize: 14 };
export const horizontal = { flexDirection: 'row', alignItems: 'center' };

// Original, native rectangle/line artwork. No platform icon font or downloaded assets.
export function desktopIcon(name, color, size = 20) {
  const box = (left, top, width, height, extra = {}) => h('view', { style: {
    position: 'absolute', left: left * size / 24, top: top * size / 24,
    width: width * size / 24, height: height * size / 24, pointerEvents: 'none', ...extra,
  } });
  const outline = (x, y, w, z, radius = 2) => box(x, y, w, z,
    { borderWidth: 1.5, borderColor: color, borderRadius: radius });
  const line = (x, y, w, rotation = 0) => box(x, y, w, 1.5, { backgroundColor: color, rotate: rotation });
  let art;
  if (name === 'folder' || name === 'home' || name === 'downloads' || name === 'desktop')
    art = [outline(3, 7, 18, 13), box(3, 4, 8, 4, { borderWidth: 1.5, borderColor: color, borderRadius: 2 }),
      name === 'downloads' ? line(9, 14, 6, 90) : null];
  else if (name === 'file' || name === 'documents')
    art = [outline(5, 3, 14, 18), line(8, 9, 8), line(8, 13, 8), line(8, 17, 5)];
  else if (name === 'back' || name === 'forward' || name === 'up')
    art = name === 'up' ? [line(7, 8, 7, -45), line(11, 8, 7, 45), line(7, 13, 10, 90)] :
      name === 'back' ? [line(4, 12, 16), line(4, 9, 8, -45), line(4, 15, 8, 45)] :
        [line(4, 12, 16), line(12, 9, 8, 45), line(12, 15, 8, -45)];
  else if (name === 'search') art = [outline(4, 3, 12, 12, 7), line(14, 17, 7, 45)];
  else if (name === 'refresh') art = [outline(4, 4, 16, 16, 8), line(14, 6, 6, 45), line(14, 3, 6)];
  else if (name === 'appearance') art = [outline(3, 3, 18, 18, 5),
    box(6, 6, 6, 6, { borderRadius: 3, backgroundColor: color }), line(7, 17, 10, -35)];
  else if (name === 'displays') art = [outline(2, 4, 20, 13), line(8, 21, 8), line(10, 19, 4, 90)];
  else if (name === 'network') art = [outline(3, 3, 18, 18, 10), outline(7, 7, 10, 10, 5),
    box(10, 10, 4, 4, { borderRadius: 2, backgroundColor: color })];
  else if (name === 'audio') art = [outline(3, 8, 5, 8), outline(8, 5, 7, 14),
    line(18, 8, 7, 65), line(18, 16, 7, -65)];
  else if (name === 'keyboard') art = [outline(2, 5, 20, 14),
    ...[5, 9, 13, 17].map(x => box(x, 9, 2, 2, { backgroundColor: color })), line(6, 15, 12)];
  else if (name === 'rename') art = [line(4, 12, 18, -45), line(3, 21, 8), outline(15, 3, 5, 5, 1)];
  else if (name === 'open') art = [outline(3, 8, 13, 13), line(9, 9, 14, -45), line(15, 3, 7), line(21, 3, 7, 90)];
  else if (name === 'apps') art = [outline(3, 3, 7, 7), outline(14, 3, 7, 7),
    outline(3, 14, 7, 7), outline(14, 14, 7, 7)];
  else if (name === 'add') art = [line(4, 12, 16), line(4, 12, 16, 90)];
  else art = [outline(3, 3, 18, 18, 10), line(9, 13, 6, 90),
    box(11, 6, 2, 2, { backgroundColor: color, borderRadius: 1 })];
  return h('view', { 'aria-hidden': 'true', style: {
    width: size, height: size, flexShrink: 0, position: 'relative', pointerEvents: 'none',
  } }, art);
}

export function desktopText(text, color, size = 14, extra = {}) {
  return h('view', { style: { ...desktopType, color, fontSize: size, flexShrink: 0, ...extra } }, text);
}

export function desktopCommand(id, text, theme, action, { icon = '', selected = false, enabled = true,
  quiet = false, style = {}, role = 'button' } = {}) {
  const activate = event => {
    if (!enabled || (event?.button !== undefined && event.button !== 0)) return false;
    event?.stopPropagation?.(); return action();
  };
  return h('view', { id, role, tabIndex: enabled ? 0 : -1, 'aria-label': text,
    'aria-disabled': String(!enabled), 'aria-pressed': String(selected),
    style: { ...horizontal, height: 36, gap: 9, paddingLeft: 12, paddingRight: 12, flexShrink: 0,
      borderWidth: 1, borderRadius: 6, borderColor: selected ? theme.colors.accent :
        quiet ? 'transparent' : theme.colors.border,
      backgroundColor: selected ? theme.colors.selection : quiet ? 'transparent' : theme.colors.surface,
      opacity: enabled ? 1 : 0.5, ...style },
    hoverStyle: enabled ? { backgroundColor: theme.colors.selection } : {},
    focusStyle: { borderColor: theme.colors.focus },
    onClick: activate, onKeydown: event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(event); }
    },
  }, icon ? desktopIcon(icon, theme.colors.accent) : null,
  desktopText(text, theme.colors.text, 14, { pointerEvents: 'none', flexShrink: 1, minWidth: 0 }));
}

export function settingsCard(theme, title, subtitle, children = [], id) {
  return h('view', { id, style: { padding: 18, gap: 12, flexShrink: 0,
    borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface } },
  title ? desktopText(title, theme.colors.text, 16, { fontWeight: 600 }) : null,
  subtitle ? desktopText(subtitle, theme.colors.muted, 13, { flexShrink: 1 }) : null, children);
}

export function scrollDesktop(event, horizontalScroll = false) {
  event.preventDefault();
  const node = event.currentTarget;
  const axis = horizontalScroll ? 'Left' : 'Top', extent = horizontalScroll ? 'Width' : 'Height';
  const end = node.childNodes.reduce((maximum, child) => Math.max(maximum,
    child['offset' + axis] + child['offset' + extent] - node['offset' + axis]), 0);
  const maximum = Math.max(0, end - node['offset' + extent]);
  node['scroll' + axis] = Math.max(0, Math.min(maximum,
    Number(node['scroll' + axis]) + (horizontalScroll ? event.deltaX || event.deltaY : event.deltaY)));
}
