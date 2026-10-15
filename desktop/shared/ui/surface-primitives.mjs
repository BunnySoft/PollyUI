import { h } from './gui/sdk/js/reconciler.mjs';

const fill = { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, pointerEvents: 'none' };
export const surfaceStyle = (theme, group = 'button') => theme[group].surfaceStyle || 'generic';
export const hasSurfacePaint = theme => ['classic', 'aqua', 'fluent'].includes(surfaceStyle(theme));
const states = new WeakMap();

export function surfacePaint(theme, { selected = false, pressed = false, hovered = false,
  focused = false, disabled = false, quiet = false, variant = 'button' } = {}) {
  const style = surfaceStyle(theme), c = theme.colors;
  const face = variant === 'task' ? selected ? '#e8e6e0' : c.body :
    disabled ? c.body : selected ? c.selection : quiet ? 'transparent' :
    pressed ? theme.button.to : theme.button.from;
  return { backgroundColor: quiet && (hovered || pressed) ? c.selection : face,
    gradientFrom: quiet ? 'transparent' : pressed ? theme.button.to : face,
    gradientTo: quiet ? 'transparent' : pressed ? theme.button.from : theme.button.to,
    borderRadius: theme.button.radius,
    borderColor: disabled ? c.border : focused && style !== 'classic' ? c.focus :
      quiet ? 'transparent' : c.border,
    opacity: 1 };
}

export function bevel(theme, { pressed = false, inset = false } = {}) {
  const c = theme.colors, down = pressed || inset;
  const side = (className, style, color) => h('view', { className, 'aria-hidden': 'true',
    style: { position: 'absolute', backgroundColor: color, pointerEvents: 'none', ...style } });
  return h('view', { className: 'theme-bevel', 'aria-hidden': 'true', style: { ...fill } },
    side('bevel-top', { left: 0, right: 0, top: 0, height: 1 }, down ? c.dark : c.light),
    side('bevel-left', { left: 0, top: 0, bottom: 0, width: 1 }, down ? c.dark : c.light),
    side('bevel-bottom', { left: 0, right: 0, bottom: 0, height: 1 }, down ? c.light : '#404040'),
    side('bevel-right', { right: 0, top: 0, bottom: 0, width: 1 }, down ? c.light : '#404040'),
    side('bevel-inner-bottom', { left: 1, right: 1, bottom: 1, height: 1 }, down ? c.body : c.dark),
    side('bevel-inner-right', { right: 1, top: 1, bottom: 1, width: 1 }, down ? c.body : c.dark));
}

export function surfaceDetail(theme, { selected = false, quiet = false } = {}) {
  const classic = surfaceStyle(theme) === 'classic';
  return h('view', { 'aria-hidden': 'true', style: { ...fill } },
    classic && !quiet ? bevel(theme, { pressed: selected }) : null,
    surfaceStyle(theme) === 'aqua' && !quiet ? h('view', { style: {
      ...fill, bottom: '50%', borderRadius: theme.button.radius,
      backgroundColor: '#ffffff', opacity: 0.45 } }) : null,
    h('view', { className: 'theme-focus-ring', style: {
      ...fill, left: 3, top: 3, right: 3, bottom: 3, borderWidth: classic ? 0 : 1,
      borderColor: theme.colors.focus, borderRadius: Math.max(0, theme.button.radius - 2),
      opacity: 0, overflow: 'hidden' } },
    classic ? [false, true].flatMap(end => [
      h('view', { style: { position: 'absolute', left: 0, right: 0, [end ? 'bottom' : 'top']: 0,
        height: 1, pointerEvents: 'none' } },
      Array.from({ length: 160 }, (_, i) => h('view', { style: { position: 'absolute',
        left: i * 2, top: 0, width: 1, height: 1, backgroundColor: theme.colors.focus, pointerEvents: 'none' } }))),
      h('view', { style: { position: 'absolute', top: 0, bottom: 0, [end ? 'right' : 'left']: 0,
        width: 1, pointerEvents: 'none' } },
      Array.from({ length: 32 }, (_, i) => h('view', { style: { position: 'absolute',
        left: 0, top: i * 2, width: 1, height: 1, backgroundColor: theme.colors.focus, pointerEvents: 'none' } }))),
    ]) : null));
}

export function surfaceEvents(theme, options = {}) {
  const paint = (event, change) => {
    const node = event.currentTarget, state = states.get(node) || {};
    Object.assign(state, change); states.set(node, state);
    Object.assign(node.style, surfacePaint(theme, { ...options, ...state }));
    const focus = node.querySelector('.theme-focus-ring');
    if (focus) focus.style.opacity = state.focused ? '1' : '0';
    const label = node.querySelector('.theme-command-label');
    if (label && options.quiet && surfaceStyle(theme) === 'classic')
      label.style.color = state.hovered || state.pressed || options.selected ?
        theme.colors.accentText : theme.colors.text;
    const down = state.pressed || options.selected;
    for (const [name, color] of Object.entries({
      top: down ? theme.colors.dark : theme.colors.light,
      left: down ? theme.colors.dark : theme.colors.light,
      bottom: down ? theme.colors.light : '#404040',
      right: down ? theme.colors.light : '#404040',
      'inner-bottom': down ? theme.colors.body : theme.colors.dark,
      'inner-right': down ? theme.colors.body : theme.colors.dark,
    })) {
      const edge = node.querySelector('.bevel-' + name);
      if (edge) edge.style.backgroundColor = color;
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
