import { h } from './gui/sdk/js/reconciler.mjs';
import { paintClassicTask, classicFocusPaint, paintClassicFocus } from './desktop/shared/ui/classic-task-paint.mjs';
import { controlStates as states } from './desktop/shared/ui/control-state.mjs';

const fill = { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, pointerEvents: 'none' };
export const surfaceStyle = (theme, group = 'button') => theme[group].surfaceStyle || 'generic';
export const hasSurfacePaint = theme => ['classic', 'aqua', 'fluent'].includes(surfaceStyle(theme));
export const selectionInk = (theme, legacy) => theme.colors.selectionText ?? legacy;
function paintIconInk(node, color) {
  if (node.className === 'theme-icon-ink-fill') node.style.backgroundColor = color;
  if (node.className === 'theme-icon-ink-border') node.style.borderColor = color;
  for (const child of node.childNodes) paintIconInk(child, color);
}
function paintSelectionParts(node, theme, highlighted) {
  if (node.getAttribute('role') === 'textbox') return;
  if (node.className === 'theme-selection-text') {
    const normal = node.getAttribute('data-selection-ink');
    node.style.color = highlighted ? selectionInk(theme, normal) : normal;
  }
  for (const child of node.childNodes) paintSelectionParts(child, theme, highlighted);
}

export function surfacePaint(theme, { selected = false, pressed = false, hovered = false,
  focused = false, disabled = false, quiet = false, variant = 'button' } = {}) {
  const style = surfaceStyle(theme), c = theme.colors;
  if (surfaceStyle(theme, 'panel') === 'fluent' && variant === 'task') return {
    backgroundColor: disabled ? 'transparent' : pressed ? theme.button.to :
      hovered ? c.selection : selected ? theme.button.from : 'transparent',
    gradientFrom: 'transparent', gradientTo: 'transparent',
    borderRadius: theme.button.radius, borderColor: 'transparent',
  };
  const face = variant === 'task' ? selected ? '#e8e6e0' : c.body :
    disabled ? c.body : selected ? c.selection : quiet ? 'transparent' :
    pressed ? theme.button.to : theme.button.from;
  const flatTask = surfaceStyle(theme, 'panel') === 'classic' && variant === 'task';
  return { backgroundColor: quiet && (hovered || pressed) ? c.selection : face,
    ...(flatTask || (style === 'classic' && !quiet) ? { borderWidth: 0 } : {}),
    gradientFrom: flatTask ? face : quiet ? 'transparent' : pressed ? theme.button.to : face,
    gradientTo: flatTask ? face : quiet ? 'transparent' : pressed ? theme.button.from : theme.button.to,
    borderRadius: theme.button.radius,
    borderColor: disabled ? c.border : focused && style !== 'classic' ? c.focus :
      quiet ? 'transparent' : c.border };
}

export function bevel(theme, { pressed = false, inset = false, frame = false } = {}) {
  const c = theme.colors;
  const side = (className, style, color) => h('view', { className, 'aria-hidden': 'true',
    style: { position: 'absolute', backgroundColor: color, pointerEvents: 'none', ...style } });
  return h('view', { className: 'theme-bevel', 'aria-hidden': 'true', style: { ...fill } },
    side('bevel-top', { left: 0, right: 0, top: 0, height: 1 },
      frame ? c.body : inset ? c.dark : pressed ? '#404040' : c.light),
    side('bevel-left', { left: 0, top: 0, bottom: 0, width: 1 },
      frame ? c.body : inset ? c.dark : pressed ? '#404040' : c.light),
    side('bevel-bottom', { left: 0, right: 0, bottom: 0, height: 1 }, pressed || inset ? c.light : '#404040'),
    side('bevel-right', { right: 0, top: 0, bottom: 0, width: 1 }, pressed || inset ? c.light : '#404040'),
    inset ? null : [
      side('bevel-inner-top', { left: 1, right: 1, top: 1, height: 1 }, frame ? c.light : pressed ? c.dark : c.body),
      side('bevel-inner-left', { left: 1, top: 1, bottom: 1, width: 1 }, frame ? c.light : pressed ? c.dark : c.body),
      side('bevel-inner-bottom', { left: 1, right: 1, bottom: 1, height: 1 }, pressed ? c.body : c.dark),
      side('bevel-inner-right', { right: 1, top: 1, bottom: 1, width: 1 }, pressed ? c.body : c.dark),
    ],
    frame ? [
      side('bevel-face-top', { left: 2, right: 2, top: 2, height: 1 }, c.body),
      side('bevel-face-left', { left: 2, top: 2, bottom: 2, width: 1 }, c.body),
      side('bevel-face-bottom', { left: 2, right: 2, bottom: 2, height: 1 }, c.body),
      side('bevel-face-right', { right: 2, top: 2, bottom: 2, width: 1 }, c.body),
    ] : null);
}

export function surfaceDetail(theme, { selected = false, quiet = false, disabled = false } = {}) {
  const classic = surfaceStyle(theme) === 'classic';
  return h('view', { 'aria-hidden': 'true', style: { ...fill } },
    classic && !quiet ? bevel(theme, { pressed: selected }) : null,
    surfaceStyle(theme) === 'aqua' && !quiet ? h('view', { style: {
      ...fill, bottom: '50%', borderRadius: theme.button.radius,
      backgroundColor: '#ffffff', opacity: 0.45 } }) : null,
    h('view', { className: 'theme-focus-ring', style: {
      ...fill, left: 3, top: 3, right: 3, bottom: 3, borderWidth: classic ? 0 : 1,
      borderColor: theme.colors.focus, borderRadius: Math.max(0, theme.button.radius - 2),
      opacity: 0, overflow: 'hidden' } }, classic ? classicFocusPaint(theme, disabled) : null));
}

export function surfaceEvents(theme, options = {}) {
  const paint = (event, change) => {
    const node = event.currentTarget, previous = states.get(node);
    const disabled = options.disabled || node.getAttribute?.('aria-disabled') === 'true';
    const state = !disabled && previous ? previous : {
      theme, pressed: false, hovered: false, focused: node.ownerDocument?.activeElement === node,
    };
    state.theme = theme;
    if (disabled) {
      Object.assign(state, { pressed: false, hovered: false, focused: false });
      states.delete(node);
    } else {
      Object.assign(state, change);
      states.set(node, state);
    }
    if (!options.inkOnly) Object.assign(node.style, surfacePaint(theme, { ...options, ...state }));
    const highlighted = state.hovered || state.pressed || options.selected;
    const label = node.querySelector('.theme-command-label');
    if (label && options.quiet) label.style.color = disabled ? theme.colors.muted : highlighted ?
      selectionInk(theme, surfaceStyle(theme) === 'classic' ? theme.colors.accentText : theme.colors.text) : theme.colors.text;
    const icon = options.quiet && node.querySelector('.theme-command-icon');
    if (icon) {
      const normal = icon.getAttribute('data-selection-ink') ?? theme.colors.accent;
      const ink = disabled ? theme.colors.muted : highlighted ? selectionInk(theme, normal) : normal;
      paintIconInk(icon, ink);
    }
    if (options.selectionParts) paintSelectionParts(node, theme, !disabled && highlighted);
    if (options.inkOnly) return;
    const focus = node.querySelector('.theme-focus-ring');
    if (focus) focus.style.opacity = state.focused ? '1' : '0';
    const focusPaint = node.querySelector('.classic-focus-paint');
    if (focusPaint) paintClassicFocus(focusPaint, theme, state.focused);
    const texture = node.querySelector('.classic-task-paint');
    if (texture) paintClassicTask(texture, theme, { ...options, ...state });
    const down = state.pressed || options.selected;
    for (const [name, color] of Object.entries({
      top: down ? '#404040' : theme.colors.light,
      left: down ? '#404040' : theme.colors.light,
      bottom: down ? theme.colors.light : '#404040',
      right: down ? theme.colors.light : '#404040',
      'inner-top': down ? theme.colors.dark : theme.colors.body,
      'inner-left': down ? theme.colors.dark : theme.colors.body,
      'inner-bottom': down ? theme.colors.body : theme.colors.dark,
      'inner-right': down ? theme.colors.body : theme.colors.dark,
    })) {
      const edge = node.querySelector('.bevel-' + name);
      if (edge) edge.style.backgroundColor = color;
    }
    const content = node.querySelector('.classic-task-content');
    if (content) {
      content.style.left = down ? '1' : '0';
      content.style.top = down ? '1' : '0';
    }
  };
  const syncState = node => {
    if (options.selectionParts || options.disabled || node.getAttribute?.('aria-disabled') === 'true' ||
        states.has(node) || node.ownerDocument?.activeElement === node ||
        surfaceStyle(theme, 'panel') === 'fluent' && options.variant === 'task')
      paint({ currentTarget: node }, { focused: node.ownerDocument?.activeElement === node });
  };
  return {
    onMount: syncState,
    onUpdate: syncState,
    onMouseenter: event => paint(event, { hovered: true }),
    onMouseleave: event => paint(event, { hovered: false, pressed: false }),
    onMousedown: event => { if (event.button === 0) paint(event, { pressed: true }); },
    onMouseup: event => paint(event, { pressed: false }),
    onMousecancel: event => paint(event, { ...(options.inkOnly ? {} : { hovered: false }), pressed: false }),
    onLostmousecapture: event => paint(event, { pressed: false }),
    onFocus: event => paint(event, { focused: true }),
    onBlur: event => paint(event, { focused: false, pressed: false }),
  };
}
