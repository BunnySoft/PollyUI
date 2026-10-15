import { h } from './gui/sdk/js/reconciler.mjs';
import { verticalScrollMetrics } from './gui/sdk/js/scrollbar.mjs';
import { desktopCommand, desktopText, scrollDesktop } from './desktop/shared/ui/presentation.mjs';
import { bevel } from './desktop/shared/ui/surface-primitives.mjs';
import { themeTextSize } from './desktop/shared/ui/theme-layout.mjs';

const pendingLayouts = new WeakMap();
const commandStates = new WeakMap();
function revealProgram(node) {
  const list = node.parentNode;
  const top = node.offsetTop - list.offsetTop, start = Number(list.scrollTop);
  const next = top < start ? top : top + node.offsetHeight > start + list.offsetHeight ?
    top + node.offsetHeight - list.offsetHeight : start;
  list.scrollTop = Math.max(0, Math.min(verticalScrollMetrics(list).maximum, next));
}
function clampPrograms(node) {
  let state = pendingLayouts.get(node);
  if (!state) { state = { frame: null, geometry: null }; pendingLayouts.set(node, state); }
  if (state.frame !== null) return;
  const weak = new WeakRef(node);
  state.frame = requestAnimationFrame(() => {
    state.frame = requestAnimationFrame(() => {
      const current = weak.deref();
      if (!current) return;
      state.frame = null;
      if (current.ownerDocument?.getElementById('shell-program-list') !== current) return;
      const metrics = verticalScrollMetrics(current);
      if (Number(current.scrollTop) !== metrics.value) current.scrollTop = metrics.value;
      const geometry = [current.offsetWidth, metrics.height, metrics.maximum];
      const changed = !state.geometry || geometry.some((value, index) => value !== state.geometry[index]);
      state.geometry = geometry;
      const owner = current.ownerDocument, focused = owner.activeElement;
      if (!focused || focused === owner.body || focused.parentNode === current && focused.tabIndex < 0)
        owner.getElementById('shell-program-back')?.focus();
      else if (changed && focused.parentNode === current) revealProgram(focused);
    });
  });
}
function leavePrograms(node, done) {
  const state = pendingLayouts.get(node);
  if (state && state.frame !== null) cancelAnimationFrame(state.frame);
  pendingLayouts.delete(node);
  done();
}

export function programsPlacement(root, trigger, rowHeight) {
  const x = trigger.offsetLeft + trigger.offsetWidth - root.offsetLeft;
  const side = root.offsetWidth - x - 3;
  const below = trigger.offsetTop + trigger.offsetHeight - root.offsetTop;
  if (side >= 120) return { left: x, top: 3, width: side, height: Math.max(0, root.offsetHeight - 6) };
  const top = Math.min(below, Math.max(3, root.offsetHeight - rowHeight - 24 - 6));
  return { left: 3, top, width: Math.max(0, root.offsetWidth - 6), height: Math.max(0, root.offsetHeight - top - 3) };
}

export function programsMenu(theme, entries, desktop, state) {
  const leave = event => {
    const root = event.currentTarget.ownerDocument.getElementById('shell-applications');
    const box = root.getBoundingClientRect();
    if (event.clientX < box.x || event.clientX >= box.x + box.width ||
        event.clientY < box.y || event.clientY >= box.y + box.height) state.change(false);
  };
  const command = (id, label, action, enabled = true, description = '') => {
    const node = desktopCommand(id, label, theme, action, {
      enabled, quiet: true, role: 'menuitem',
      style: { height: theme.layout.menuRowHeight ?? 32, minWidth: 0, borderWidth: 0 },
    });
    if (description) node.props['aria-description'] = description;
    const visual = { ...node.props };
    for (const [name, change] of Object.entries({
      onMouseenter: { hovered: true }, onMouseleave: { hovered: false, held: false },
      onMousedown: { held: true }, onMouseup: { held: false }, onMousecancel: { hovered: false, held: false },
      onLostmousecapture: { held: false }, onBlur: { held: false },
    })) node.props[name] = event => {
      visual[name]?.(event);
      const target = event.currentTarget;
      const previous = commandStates.get(target) ?? { theme, hovered: false, held: false };
      if (enabled && (name !== 'onMousedown' || event.button === 0)) Object.assign(previous, change);
      else if (!enabled) Object.assign(previous, { hovered: false, held: false });
      commandStates.set(target, previous);
    };
    node.props.onUpdate = target => {
      visual.onUpdate?.(target);
      const previous = commandStates.get(target);
      if (!previous) return;
      if (!enabled) { commandStates.delete(target); return; }
      if (previous.theme !== theme) {
        // Reapply the original painter's transient state with the new immutable theme.
        const event = { currentTarget: target, button: 0 };
        visual.onMouseleave?.(event);
        if (previous.hovered) visual.onMouseenter?.(event);
        if (previous.held) visual.onMousedown?.(event);
        previous.theme = theme;
      }
    };
    const focus = node.props.onFocus, cancel = node.props.onMousecancel, mouseleave = node.props.onMouseleave;
    node.props.onFocus = event => { focus?.(event); revealProgram(event.currentTarget); };
    node.props.onMousecancel = event => { cancel?.(event); event.stopPropagation(); state.change(false, 'trigger'); };
    node.props.onMouseleave = event => { mouseleave?.(event); leave(event); };
    return node;
  };
  const current = new Map(entries.flatMap(entry => [
    ['shell-program-' + entry.id, command('shell-program-' + entry.id, entry.name,
      () => state.launch(entry.id), !entry.unavailable, entry.unavailable ?? '')],
    ...(desktop ? [['shell-program-pin-' + entry.id, command('shell-program-pin-' + entry.id,
      (desktop.has(entry.id) ? 'Unpin ' : 'Pin ') + entry.name,
      () => state.pin(entry.id))]] : []),
  ]));
  // Positional reconciliation must not turn a held row into a different registered application.
  const known = new Set(state.slots);
  for (const id of current.keys()) if (!known.has(id)) { state.slots.push(id); known.add(id); }
  const items = current.size ? state.slots.map(id => current.get(id) || h('view', {
    'aria-hidden': 'true', tabIndex: -1, style: {
      height: theme.layout.menuRowHeight ?? 32, flexShrink: 0, pointerEvents: 'none',
    },
    onUpdate: node => commandStates.delete(node),
  })) : [];
  const key = event => {
    if (event.key === 'Escape' || event.key === 'ArrowLeft') {
      event.preventDefault(); event.stopPropagation(); state.change(false, 'trigger'); return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Tab'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const list = event.currentTarget.querySelector('#shell-program-list');
    const enabled = Array.from(list.childNodes).filter(node => node.tabIndex >= 0);
    if (!enabled.length) return;
    const index = enabled.indexOf(list.ownerDocument.activeElement);
    const forward = event.key === 'ArrowDown' || event.key === 'Tab' && !event.shiftKey;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 :
      index < 0 ? forward ? 0 : enabled.length - 1 : (index + (forward ? 1 : -1) + enabled.length) % enabled.length;
    enabled[next].focus();
  };
  const back = command('shell-program-back', '< All Programs', () => state.change(false, 'trigger'));
  back.props.style.height = 24;
  return h('view', { id: 'shell-program-overlay', style: {
    position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
  }, onMousedown: event => {
    if (event.target !== event.currentTarget) return;
    event.preventDefault(); event.stopPropagation();
    const trigger = event.currentTarget.ownerDocument.getElementById('shell-all-programs');
    const box = trigger.getBoundingClientRect();
    const onTrigger = event.clientX >= box.x && event.clientX < box.x + box.width &&
      event.clientY >= box.y && event.clientY < box.y + box.height;
    state.change(onTrigger, onTrigger ? 'first' : 'trigger');
  }, onKeydown: key, onMouseleave: leave },
  h('view', { id: 'shell-program-menu', role: 'menu', 'aria-label': 'All Programs', style: {
    position: 'absolute', ...state.placement,
    minWidth: 0, padding: 3, backgroundColor: theme.colors.body, overflow: 'hidden',
  }, onMouseleave: leave }, bevel(theme, { frame: true }),
  back,
  h('view', { id: 'shell-program-error', role: 'alert', style: { display: state.error ? 'flex' : 'none', padding: 4, flexShrink: 0 } },
    state.error ? desktopText(state.error, theme.colors.text, themeTextSize(theme)) : null),
  h('view', { id: 'shell-program-list', style: {
    flexGrow: 1, flexBasis: 0, minHeight: 0, minWidth: 0, overflow: 'scroll',
  }, onWheel: scrollDesktop, onMouseleave: leave,
    onMount: clampPrograms, onUpdate: clampPrograms, onLeave: leavePrograms }, items,
  !entries.length ? desktopText('No applications available', theme.colors.muted, themeTextSize(theme)) : null)));
}
