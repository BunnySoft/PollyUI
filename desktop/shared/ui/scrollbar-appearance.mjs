import { h, render } from './gui/sdk/js/reconciler.mjs';
import { desktopIcon } from './desktop/shared/ui/presentation.mjs';
import { bevel, surfaceStyle, surfacePaint, surfaceDetail } from './desktop/shared/ui/surface-primitives.mjs';
import { isLuna, lunaButtonPaint, lunaButtonDetail } from './desktop/shared/ui/luna-primitives.mjs';
import { paintClassicFocus } from './desktop/shared/ui/classic-task-paint.mjs';

const appearances = { full: new WeakMap(), overlay: new WeakMap() };
const fill = { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, pointerEvents: 'none' };
function scrollbarBevel(theme, part, options = {}) {
  const node = bevel(theme, options);
  node.props.className = 'scrollbar-' + part + '-bevel';
  for (const edge of node.children) edge.props.className = 'scrollbar-' + part + '-' + edge.props.className;
  return node;
}

export function scrollbarAppearance(theme, variant = 'full') {
  if (!Object.hasOwn(appearances, variant)) throw new RangeError('Unknown scrollbar variant: ' + variant);
  const cache = appearances[variant];
  let appearance = cache.get(theme);
  if (appearance) return appearance;
  const c = theme.colors, style = surfaceStyle(theme), classic = style === 'classic', luna = isLuna(theme);
  const overlay = variant === 'overlay';
  const width = overlay ? 10 : Math.max(12, Math.min(24, theme.layout.fontSize + theme.layout.borderWidth * 4));
  const inset = classic || luna ? 1 : overlay ? 2 : Math.max(2, Math.min(4, theme.layout.controlGap / 2));
  const arrows = classic || luna || style === 'aqua';
  function face(disabled, hovered, pressed) {
    return { ...(luna ? lunaButtonPaint(theme, { disabled, hovered, pressed }) :
      surfacePaint(theme, { disabled, hovered, pressed })),
      borderWidth: classic ? 0 : theme.layout.borderWidth,
      borderColor: disabled ? c.border : hovered ? c.accent : c.border,
      borderRadius: theme.button.radius, opacity: disabled ? theme.layout.disabledOpacity : 1 };
  }
  function detail(pressed, part) {
    if (classic) return scrollbarBevel(theme, part, { pressed });
    if (luna) {
      const node = lunaButtonDetail(theme);
      node.children = node.children.filter(child => child.props?.className !== 'luna-focus-ring');
      for (const child of node.children)
        if (child.props?.className === 'luna-hot-ring') child.props.className = 'scrollbar-' + part + '-hot-ring';
      return node;
    }
    if (style === 'aqua') {
      const node = surfaceDetail(theme);
      node.children = node.children.filter(child => child.props?.className !== 'theme-focus-ring');
      return node;
    }
    return null;
  }
  const thumbDetail = pressed => h('view', { 'aria-hidden': 'true', style: { ...fill } },
    detail(pressed, 'thumb'), classic || luna ? h('view', { 'aria-hidden': 'true', style: {
      position: 'absolute', left: '25%', right: '25%', top: '40%', gap: 2, pointerEvents: 'none' } },
      [0, 1, 2].map(() => h('view', { 'aria-hidden': 'true', style: {
        height: 1, backgroundColor: luna ? c.border : c.dark, pointerEvents: 'none' } }))) : null);
  const arrowDetail = (down, disabled, pressed) => h('view', { 'aria-hidden': 'true',
    style: { ...fill, alignItems: 'center', justifyContent: 'center' } },
    detail(pressed, down ? 'increment' : 'decrement'),
    h('view', { 'aria-hidden': 'true', style: { rotate: down ? 180 : 0, pointerEvents: 'none' } },
      desktopIcon('up', disabled ? c.muted : c.text, Math.max(4, Math.min(12, width - 4)))));
  appearance = Object.freeze({
    metrics: Object.freeze({ width, thumbInset: inset, arrowSize: arrows ? width : 0 }),
    decorate(parts) {
      render(classic ? scrollbarBevel(theme, 'track', { inset: true }) : h('view', { 'aria-hidden': 'true', style: {
        ...fill, borderWidth: theme.layout.borderWidth, borderColor: c.border, borderRadius: theme.button.radius } }),
      parts.trackDetail);
      const detail = luna ? lunaButtonDetail(theme) : surfaceDetail(theme, { quiet: true });
      const ring = detail.children.find(node => ['theme-focus-ring', 'luna-focus-ring'].includes(node.props?.className));
      // The provided slot is the detail wrapper: Canvas -> ring -> slot -> track.
      render(ring, parts.trackFocus);
      return () => {
        for (const key of ['trackDetail', 'trackFocus', 'thumbDetail', 'decrementDetail', 'incrementDetail'])
          if (parts[key]) render(null, parts[key]);
      };
    },
    paint(state, parts) {
      const { disabled, hovered, held, dragging, focused, atStart, atEnd } = state;
      const pressed = dragging || held === 'thumb';
      render(thumbDetail(pressed), parts.thumbDetail);
      const hot = parts.thumbDetail.querySelector('.scrollbar-thumb-hot-ring');
      if (hot) hot.style.opacity = !disabled && hovered === 'thumb' && !pressed ? '1' : '0';
      const ring = parts.trackFocus.firstChild;
      ring.style.opacity = !disabled && focused ? '1' : '0';
      const canvas = ring.querySelector('.classic-focus-paint') || ring.querySelector('.luna-focus-paint');
      if (canvas) paintClassicFocus(canvas, theme, !disabled && focused);
      for (const [part, down, end] of [['decrement', false, atStart], ['increment', true, atEnd]])
        if (parts[part + 'Detail'])
          render(arrowDetail(down, disabled || end, held === part), parts[part + 'Detail']);
      return { track: { backgroundColor: held === 'track' ? c.selection : c.body,
        borderWidth: 0, borderRadius: theme.button.radius },
      thumb: classic || luna || style === 'aqua' ? face(disabled, hovered === 'thumb', pressed) : {
        backgroundColor: disabled ? c.border : pressed ? c.accent : hovered === 'thumb' ? c.text : c.muted,
        gradientFrom: 'transparent', gradientTo: 'transparent', borderWidth: 0, borderRadius: theme.button.radius,
        opacity: disabled ? theme.layout.disabledOpacity : 1 },
      decrement: face(disabled || atStart, hovered === 'decrement', held === 'decrement'),
      increment: face(disabled || atEnd, hovered === 'increment', held === 'increment') };
    },
  });
  cache.set(theme, appearance);
  return appearance;
}
