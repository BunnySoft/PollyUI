import { h } from './gui/sdk/js/reconciler.mjs';

const fill = { position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', pointerEvents: 'none' };
export const isLuna = (theme, group = 'button') => theme[group].surfaceStyle === 'luna';
export const gradient = (from, to) => ({ backgroundColor: from, gradientFrom: from, gradientTo: to });

export function mixColor(from, to, amount) {
  const a = parseInt(from.slice(1), 16), b = parseInt(to.slice(1), 16);
  return '#' + [16, 8, 0].map(shift => Math.floor(((a >> shift) & 255) +
    (((b >> shift) & 255) - ((a >> shift) & 255)) * amount).toString(16).padStart(2, '0')).join('');
}

export function lunaBandColor(theme, kind, y, height) {
  const panel = theme.panel, chrome = theme.window;
  let stops, colors;
  if (kind === 'title' || kind === 'inactive-title') {
    const active = kind === 'title', from = active ? chrome.titleFrom : chrome.inactiveFrom,
      to = active ? chrome.titleTo : chrome.inactiveTo;
    stops = [0, 1/30, 2/30, 3/30, 4/30, 7/30, 10/30, 14/30, 16/30, 22/30, 25/30, 27/30, 28/30, 1];
    colors = [mixColor(from, to, 0.3), mixColor(to, active ? '#7cc4ff' : '#ffffff', active ? 0.5 : 0.2),
      mixColor(to, active ? '#7cdcff' : '#ffffff', active ? 0.333 : 0.12),
      mixColor(to, active ? '#0fa0ff' : '#ffffff', active ? 0.15 : 0.05),
      mixColor(from, to, 0.5), from, mixColor(from, to, 0.04), mixColor(from, to, 0.07),
      mixColor(from, to, 0.25), to, to, active ? mixColor(to, '#0054fa', 0.4) : mixColor(from, to, 0.8),
      active ? mixColor(from, '#003fe3', 0.33) : from,
      active ? mixColor(from, '#0034b8', 0.5) : mixColor(from, '#000000', 0.12)];
  } else if (kind === 'panel') {
    stops = [0, 0.05, 0.1, 0.23, 0.5, 0.83, 0.93, 1];
    colors = [mixColor(panel.from, '#000000', 0.15), mixColor(panel.from, '#ffffff', 0.3),
      mixColor(panel.from, '#ffffff', 0.18), panel.from, panel.from, panel.to,
      mixColor(panel.to, '#000000', 0.05), mixColor(panel.to, '#000000', 0.28)];
  } else if (kind === 'launcher') {
    stops = [0, 0.07, 0.27, 0.67, 0.87, 1];
    colors = [panel.launcherTo, panel.launcherFrom, mixColor(panel.launcherFrom, panel.launcherTo, 0.6),
      mixColor(panel.launcherFrom, panel.launcherTo, 0.55), panel.launcherTo,
      mixColor(panel.launcherTo, '#000000', 0.12)];
  } else if (kind === 'tray') {
    stops = [0, 0.07, 0.23, 0.5, 0.83, 1];
    colors = ['#095bc9', '#19b8f2', '#1285e1', '#1285e1', '#0d90eb', '#095bc9'];
  } else throw new RangeError('Unknown Luna band: ' + kind);
  const title = kind === 'title' || kind === 'inactive-title';
  const position = Math.max(0, Math.min(1, (y - (title ? 0.5 : 0)) / height));
  for (let i = 1; i < stops.length; i++)
    if (position <= stops[i])
      return mixColor(colors[i - 1], colors[i], (position - stops[i - 1]) / (stops[i] - stops[i - 1]));
  return colors.at(-1);
}

export function lunaBands(theme, kind, height) {
  return h('view', { 'aria-hidden': 'true', style: { ...fill, overflow: 'hidden' } },
    Array.from({ length: height }, (_, y) => h('view', { style: {
      position: 'absolute', left: 0, right: 0, top: y, height: 1, pointerEvents: 'none',
      backgroundColor: lunaBandColor(theme, kind, y + 0.5, height),
    } })));
}

export function lunaButtonPaint(theme, { selected = false, hovered = false, pressed = false, focused = false,
  disabled = false, variant = 'button' } = {}) {
  const c = theme.colors;
  if (variant === 'task') {
    const from = selected ? mixColor(theme.panel.from, '#000000', 0.25) : mixColor(theme.panel.from, '#ffffff', 0.18);
    const to = selected ? mixColor(theme.panel.to, '#000000', 0.28) : theme.panel.to;
    return { ...gradient(pressed ? to : hovered ? mixColor(from, '#ffffff', 0.14) : from, pressed ? from : to),
      borderColor: mixColor(theme.panel.to, '#000000', 0.28), borderRadius: 2 };
  }
  if (variant === 'launcher') return {
    ...gradient(pressed ? theme.panel.launcherTo : theme.panel.launcherFrom, theme.panel.launcherTo),
    borderColor: mixColor(theme.panel.launcherTo, '#000000', 0.2), borderRadius: 0,
  };
  if (variant === 'tool') return {
    ...gradient(pressed ? theme.panel.to : theme.panel.from, theme.panel.to),
    borderColor: hovered || pressed || focused ? '#ffffff' : 'transparent', borderRadius: 2,
  };
  const from = selected ? mixColor(theme.button.from, c.selection, 0.35) : theme.button.from,
    to = selected ? mixColor(theme.button.to, c.selection, 0.35) : theme.button.to;
  return {
    ...gradient(disabled ? c.body : pressed ? to : from, disabled ? c.body : pressed ? from : to),
    borderColor: disabled ? c.dark : selected ? c.accent : c.border, borderRadius: theme.button.radius,
  };
}

export function lunaButtonDetail(theme, variant = 'button', disabled = false) {
  const focus = h('view', { className: 'luna-focus-ring', style: { ...fill, left: 3, top: 3, right: 3, bottom: 3,
    width: 'auto', height: 'auto', overflow: 'hidden', opacity: 0 } },
    [0, 1].map(side => h('view', { style: { position: 'absolute', left: 0, right: 0,
      [side ? 'bottom' : 'top']: 0, height: 1, pointerEvents: 'none' } },
      Array.from({ length: 80 }, (_, i) => h('view', { style: {
        position: 'absolute', left: i * 2, top: 0, width: 1, height: 1,
        backgroundColor: variant === 'button' ? theme.colors.focus : theme.panel.text, pointerEvents: 'none',
      } })))));
  if (variant === 'launcher') return h('view', { 'aria-hidden': 'true', style: { ...fill } },
    lunaBands(theme, 'launcher', theme.panel.height),
    h('view', { className: 'luna-launcher-tint', style: { ...fill, backgroundColor: '#ffffff', opacity: 0 } }), focus);
  if (variant === 'tool') return focus;
  return h('view', { 'aria-hidden': 'true', style: { ...fill, borderRadius: theme.button.radius } },
    h('view', { style: { position: 'absolute', left: 1, right: 1, top: 1, height: 1,
      pointerEvents: 'none', backgroundColor: disabled ? theme.colors.body : theme.colors.light, opacity: 0.65 } }),
    h('view', { className: 'luna-hot-ring', style: { ...fill, left: 1, top: 1,
      right: 1, bottom: 1, width: 'auto', height: 'auto', borderWidth: 2,
      borderColor: variant === 'task' ? theme.panel.text : '#efb73b', opacity: 0 } }), focus);
}

const visualStates = new WeakMap();

export function lunaVisualEvents(theme, options = {}) {
  const paint = (event, change) => {
    const node = event.currentTarget;
    const state = visualStates.get(node) || { hovered: false, pressed: false, focused: false };
    Object.assign(state, change);
    visualStates.set(node, state);
    const { hovered, pressed, focused } = state;
    Object.assign(node.style, lunaButtonPaint(theme, { ...options, hovered, pressed, focused }));
    const hot = node.querySelector('.luna-hot-ring'), focus = node.querySelector('.luna-focus-ring');
    if (hot) hot.style.opacity = hovered && !pressed ? '1' : '0';
    if (focus) focus.style.opacity = focused ? '1' : '0';
    const tint = node.querySelector('.luna-launcher-tint');
    if (tint) {
      tint.style.backgroundColor = pressed ? '#000000' : '#ffffff';
      tint.style.opacity = pressed ? '0.18' : hovered ? '0.12' : '0';
    }
  };
  return {
    onMouseenter: event => paint(event, { hovered: true }),
    onMouseleave: event => paint(event, { hovered: false, pressed: false }),
    onMousedown: event => { if (event.button === 0) paint(event, { pressed: true }); },
    onMouseup: event => paint(event, { pressed: false }),
    onFocus: event => paint(event, { focused: true }),
    onBlur: event => paint(event, { focused: false, pressed: false }),
  };
}

export function lunaSymbol(kind, color = '#ffffff', size = 16) {
  const mark = style => h('view', { style: { position: 'absolute', pointerEvents: 'none', backgroundColor: color, ...style } });
  return h('view', { 'aria-hidden': 'true', style: {
    width: size, height: size, flexShrink: 0, position: 'relative', pointerEvents: 'none',
  } }, kind === 'document' ? [
    mark({ left: 3, top: 1, width: 10, height: 14, borderWidth: 1, borderColor: '#3277b1' }),
    ...[6, 9].map(top => mark({ left: 5, top, width: 6, height: 1, backgroundColor: '#6b9fff' })),
  ] : kind === 'workspace' ? [
    mark({ left: 1, top: 2, width: 10, height: 8, borderWidth: 1, borderColor: '#003c74' }),
    mark({ left: 5, top: 6, width: 10, height: 8, borderWidth: 1, borderColor: '#003c74' }),
  ] : kind === 'notification' ? [
    mark({ left: 4, top: 3, width: 8, height: 9, borderRadius: 4 }),
    mark({ left: 2, top: 11, width: 12, height: 2 }), mark({ left: 7, top: 14, width: 2, height: 1 }),
  ] : kind === 'appearance' ? [
    mark({ left: 2, top: 2, width: 12, height: 12, borderRadius: 6 }),
    mark({ left: 6, top: 6, width: 4, height: 4, borderRadius: 2, backgroundColor: '#245edb' }),
  ] : kind === 'polly' ? [
    mark({ left: 1, top: 1, width: size - 2, height: size - 2, borderRadius: size / 2,
      backgroundColor: '#eaf6ff', borderWidth: 1, borderColor: '#1f5b8c' }),
    h('view', { style: { position: 'absolute', left: size * 0.25, top: 0,
      fontSize: size * 0.7, fontWeight: 700, color: '#2263ae', pointerEvents: 'none' } }, 'P'),
  ] : null);
}

export function lunaCaptionGlyph(theme, command, maximized = false) {
  const line = style => h('view', { style: { position: 'absolute', backgroundColor: theme.window.controlText,
    pointerEvents: 'none', ...style } });
  return h('view', { 'aria-hidden': 'true', style: { ...fill } },
    command === 'close' ? [-45, 45].map(rotate => line({ left: 4, top: 9, width: 11, height: 2, rotate })) :
      command === 'minimize' ? line({ left: 4, bottom: 5, width: 9, height: 3 }) :
        [maximized ? h('view', { style: { position: 'absolute', left: 8, top: 4, width: 8, height: 8,
          borderWidth: 1, borderColor: theme.window.controlText, pointerEvents: 'none' } }) : null,
        h('view', { style: { position: 'absolute', left: maximized ? 5 : 4, top: maximized ? 7 : 5,
          width: 10, height: 10, borderWidth: 1, borderColor: theme.window.controlText, pointerEvents: 'none' } }),
        line({ left: maximized ? 5 : 4, top: maximized ? 7 : 5, width: 10, height: 2 })]);
}
