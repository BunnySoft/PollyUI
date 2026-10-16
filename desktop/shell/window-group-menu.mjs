import { h } from './gui/sdk/js/reconciler.mjs';
import { verticalScrollMetrics } from './gui/sdk/js/scrollbar.mjs';
import { button } from './desktop/shared/ui/button.mjs';
import { desktopText, scrollDesktop } from './desktop/shared/ui/presentation.mjs';
import { themeTextSize } from './desktop/shared/ui/theme-layout.mjs';
import { panelAppearance, panelDetail } from './desktop/shared/ui/panel-appearance.mjs';
import { taskLabel } from './desktop/shell/window-groups.mjs';

const gestures = new WeakMap();
export function guardTaskGesture(node, identity) {
  const original = { ...node.props };
  node.props.onMousedown = event => {
    gestures.set(event.currentTarget, { identity, cancelled: false });
    original.onMousedown?.(event);
  };
  node.props.onUpdate = target => {
    const held = gestures.get(target);
    if (held && held.identity !== identity) held.cancelled = true;
    original.onUpdate?.(target);
  };
  for (const name of ['onMousecancel', 'onLostmousecapture'])
    node.props[name] = event => {
      const held = gestures.get(event.currentTarget);
      if (held) held.cancelled = true;
      original[name]?.(event);
    };
  for (const name of ['onClick', 'onContextmenu'])
    if (original[name]) node.props[name] = event => {
      const held = gestures.get(event.currentTarget);
      if (held && (held.cancelled || held.identity !== identity)) return false;
      return original[name](event);
    };
  node.props.onKeydown = event => {
    if (['Enter', ' ', 'ContextMenu', 'F10'].includes(event.key)) gestures.delete(event.currentTarget);
    return original.onKeydown?.(event);
  };
  return node;
}

function revealWindow(node) {
  let row = node;
  while (row.parentNode && row.parentNode.id !== 'shell-group-list') row = row.parentNode;
  const list = row.parentNode;
  if (!list) return;
  const top = node.offsetTop - list.offsetTop, start = Number(list.scrollTop);
  list.scrollTop = Math.max(0, Math.min(verticalScrollMetrics(list).maximum,
    top < start ? top : top + node.offsetHeight > start + list.offsetHeight ?
      top + node.offsetHeight - list.offsetHeight : start));
}

const layouts = new WeakMap();
const commands = node => [...(node.tabIndex >= 0 ? [node] : []), ...node.childNodes.flatMap(commands)];
function settleList(node) {
  let state = layouts.get(node);
  if (!state) { state = { frame: null, geometry: '' }; layouts.set(node, state); }
  if (state.frame !== null) return;
  const weak = new WeakRef(node);
  state.frame = requestAnimationFrame(() => {
    state.frame = requestAnimationFrame(() => {
      const current = weak.deref();
      if (!current) return;
      state.frame = null;
      if (current.ownerDocument?.getElementById('shell-group-list') !== current ||
          current.ownerDocument.defaultView?.closed) return;
      const metrics = verticalScrollMetrics(current);
      current.scrollTop = metrics.value;
      const geometry = [current.offsetWidth, metrics.height, metrics.maximum].join(':');
      const changed = geometry !== state.geometry;
      state.geometry = geometry;
      const owner = current.ownerDocument, focused = owner.activeElement;
      if (!focused || focused === owner.body || !focused.parentNode)
        (commands(current)[0] ?? owner.getElementById('shell-group-menu-close'))?.focus();
      else if (changed) revealWindow(focused);
    });
  });
}

export function windowGroupMenu(theme, group, state) {
  const label = (value, muted = false) => desktopText(value,
    muted ? theme.colors.muted : theme.colors.text, themeTextSize(theme));
  const command = (id, title, action, selected = false, style = {}, identity = id) => {
    const node = button(id, title, theme, action, selected, {
      height: theme.layout.compactButtonHeight, minWidth: 0, overflow: 'hidden', ...style });
    node.props.role = 'menuitem';
    const focus = node.props.onFocus;
    node.props.onFocus = event => { focus?.(event); revealWindow(event.currentTarget); };
    return guardTaskGesture(node, identity);
  };
  const current = new Map(group.windows.map(window => [window.id, window]));
  const known = new Set(state.slots);
  for (const window of group.windows) if (!known.has(window.id)) {
    state.slots.push(window.id); known.add(window.id);
  }
  const navigate = event => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Tab'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const nodes = commands(event.currentTarget), index = nodes.indexOf(event.currentTarget.ownerDocument.activeElement);
    if (!nodes.length) return;
    const forward = ['ArrowDown', 'ArrowRight'].includes(event.key) || event.key === 'Tab' && !event.shiftKey;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? nodes.length - 1 :
      index < 0 ? forward ? 0 : nodes.length - 1 : (index + (forward ? 1 : -1) + nodes.length) % nodes.length;
    nodes[next].focus();
  };
  return h('view', { id: 'shell-window-group', role: 'menu', 'aria-label': taskLabel(group),
    style: { ...panelAppearance(theme, 'menu'), width: '100%', height: '100%',
      minHeight: 0, minWidth: 0, overflow: 'hidden' },
    onKeydown: navigate },
  h('view', { style: { height: theme.layout.buttonHeight, minWidth: 0, overflow: 'hidden', flexShrink: 0 } },
    label(taskLabel(group))),
  h('view', { id: 'shell-group-list', style: { flexGrow: 1, flexBasis: 0, minHeight: 0,
    minWidth: 0, overflow: 'scroll', gap: theme.layout.controlGap }, onWheel: scrollDesktop,
    onMount: settleList, onUpdate: settleList,
    onLeave: (node, done) => { cancelAnimationFrame(layouts.get(node)?.frame); layouts.delete(node); done(); } },
  state.slots.map(id => {
    const window = current.get(id);
    const height = theme.layout.compactButtonHeight * 2 + theme.layout.controlGap;
    if (!window) return h('view', { tabIndex: -1, 'aria-hidden': 'true',
      style: { height, flexShrink: 0, pointerEvents: 'none' } });
    const title = window.title || window.appId || 'Untitled';
    const minimize = command('shell-group-minimize-' + id, window.minimized ? 'Restore' : 'Minimize',
      () => state.action(id, window.minimized ? 'restoreWindow' : 'minimizeWindow'), false,
      { flexGrow: 1, flexBasis: 0 }, id + ':' + !!window.minimized);
    minimize.props['aria-label'] = (window.minimized ? 'Restore ' : 'Minimize ') + title;
    const close = command('shell-group-close-' + id, 'Close window', () => state.action(id, 'closeWindow'),
      false, { flexGrow: 1, flexBasis: 0 });
    close.props['aria-label'] = 'Close window ' + title;
    return h('view', { id: 'shell-group-row-' + id, role: 'group', 'aria-label': title,
      style: { height, flexShrink: 0, minWidth: 0, gap: theme.layout.controlGap } },
    command('shell-group-activate-' + id, (window.minimized ? '[min] ' : '') + title,
      () => state.action(id, 'activateWindow'), window.active),
    h('view', { style: { flexDirection: 'row', minWidth: 0, gap: theme.layout.controlGap } },
      minimize, close));
  }),
  h('view', { style: { flexShrink: 0, gap: theme.layout.controlGap, display: state.pin ? 'flex' : 'none' } },
    state.pin ? command('shell-group-pin', state.pin.label + state.pin.target, state.pin.change,
      false, {}, state.pin.label + state.pin.target) : null,
    h('view', { style: { flexDirection: 'row', flexWrap: 'wrap', minWidth: 0,
      gap: theme.layout.controlGap, display: state.pin?.order?.earlier || state.pin?.order?.later ? 'flex' : 'none' } },
    state.pin?.order ? [-1, 1].filter(direction => direction < 0 ? state.pin.order.earlier : state.pin.order.later)
      .map(direction => command('shell-group-pin-' + (direction < 0 ? 'earlier' : 'later'),
        direction < 0 ? 'Earlier' : 'Later', () => state.pin.order.move(direction), false,
        { flexGrow: 1, flexBasis: 0 },
        JSON.stringify([state.pin.order.id, state.pin.order.position, direction]))) : []))),
  command('shell-group-menu-close', 'Close menu', state.close),
  state.error ? label(state.error) : null,
  panelDetail(theme, 'menu'));
}
