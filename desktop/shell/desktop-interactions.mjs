import { gridOrder, rangeSelection, marqueeSelection, moveDesktopGroup,
  adjacentShortcut } from './desktop/shell/desktop-shortcuts.mjs';

export function createDesktopInteraction({ changed = () => {}, save = () => {}, launch = () => {},
  context = () => {}, failure = () => {} } = {}) {
  let items = [], area = null, selected = new Set(), focused = null, anchor = null, held = null;
  let rectangle = null, suppressed = false;
  function notify() { changed(); }
  function choose(id, modifiers = {}) {
    focused = id;
    if (modifiers.shiftKey) {
      const range = rangeSelection(items, anchor, id);
      selected = modifiers.ctrlKey ? new Set([...selected, ...range]) : new Set(range);
    } else {
      if (modifiers.ctrlKey) {
        selected = new Set(selected);
        if (selected.has(id)) selected.delete(id); else selected.add(id);
      } else selected = new Set([id]);
      anchor = id;
    }
  }
  function cancel() {
    if (held) {
      items = held.items; selected = held.selected; focused = held.focused; anchor = held.anchor;
      held = null; rectangle = null; suppressed = true; notify();
    }
  }
  function move(x, y) {
    if (!held) return;
    const dx = x - held.x, dy = y - held.y;
    if (!held.dragging && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    held.dragging = true; suppressed = true;
    if (held.id) {
      if (!selected.has(held.id)) { notify(); return; }
      try { items = moveDesktopGroup(held.items, selected, dx, dy, area); }
      catch (error) { cancel(); failure(error); return; }
    } else {
      rectangle = { x: Math.min(x, held.x), y: Math.min(y, held.y),
        width: Math.abs(dx), height: Math.abs(dy) };
      selected = marqueeSelection(held.items, rectangle, held.selected, held.mode);
      focused = gridOrder(items).find(item => selected.has(item.id))?.id ?? null;
    }
    notify();
  }
  return {
    update(nextItems, nextArea) {
      const signature = values => JSON.stringify(values.map(item => [item.id, item.x, item.y]));
      if (held && (signature(nextItems) !== signature(held.items) ||
          JSON.stringify(nextArea) !== JSON.stringify(area))) cancel();
      if (!held) items = nextItems;
      area = nextArea;
      const ids = new Set(items.map(item => item.id));
      selected = new Set([...selected].filter(id => ids.has(id)));
      if (!ids.has(focused)) focused = gridOrder(items)[0]?.id ?? null;
      if (!ids.has(anchor)) anchor = null;
    },
    down(id, x, y, modifiers = {}) {
      cancel(); suppressed = false;
      held = { id, x, y, items, selected: new Set(selected), focused, anchor, dragging: false,
        collapse: id && selected.has(id) && !modifiers.ctrlKey && !modifiers.shiftKey,
        mode: modifiers.shiftKey ? 'add' : modifiers.ctrlKey ? 'toggle' : 'replace' };
      if (id) {
        if (held.collapse) focused = id;
        else choose(id, modifiers);
      } else if (!modifiers.ctrlKey && !modifiers.shiftKey) {
        selected = new Set(); focused = null; anchor = null;
      }
      notify();
    },
    move,
    up(x, y) {
      if (!held) return;
      move(x, y);
      if (!held) return;
      const previous = held;
      held = null; rectangle = null;
      if (!previous.dragging && previous.collapse) choose(previous.id);
      if (previous.dragging && previous.id) {
        const before = new Map(previous.items.map(item => [item.id, item]));
        const moved = items.some(item => selected.has(item.id) &&
          (item.x !== before.get(item.id).x || item.y !== before.get(item.id).y));
        try { if (moved) save(items, new Set(selected)); }
        catch (error) {
          if (!error.committed) items = previous.items;
          failure(error);
        }
      }
      notify();
    },
    cancel,
    doubleClick(id, event) {
      if (!suppressed && !held && !event.ctrlKey && !event.shiftKey && selected.has(id)) launch(id);
    },
    context(id) {
      cancel();
      if (id && !selected.has(id)) choose(id);
      if (id) focused = id;
      notify(); context(id);
    },
    key(event) {
      const key = event.key;
      if (event.isComposing || event.altKey || event.metaKey) return false;
      if (key === 'Escape') {
        if (held) cancel();
        else { selected = new Set(); anchor = null; notify(); }
      } else if (held) return false;
      else if (event.ctrlKey && key.toLowerCase() === 'a') {
        selected = new Set(items.map(item => item.id));
        focused ??= gridOrder(items)[0]?.id ?? null;
        anchor ??= focused; notify();
      } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(key)) {
        const order = gridOrder(items);
        const next = key === 'Home' ? order[0]?.id : key === 'End' ? order.at(-1)?.id :
          adjacentShortcut(items, focused, key);
        if (next) {
          if (event.ctrlKey && !event.shiftKey) focused = next;
          else choose(next, event);
          notify();
        }
      } else if (key === ' ' && focused) {
        choose(focused, event); notify();
      } else if (key === 'Enter' && focused && selected.has(focused)) launch(focused);
      else if (key === 'ContextMenu' || (key === 'F10' && event.shiftKey)) this.context(focused);
      else return false;
      return true;
    },
    get state() {
      return { items, selected: new Set(selected), focused, anchor, rectangle, held: !!held, dragging: !!held?.dragging };
    },
  };
}

export function bindDesktopInteraction(body, controller, failure) {
  const listeners = [];
  let stopped = false, captured = false;
  const listen = (type, callback) => {
    body.addEventListener(type, callback); listeners.push([type, callback]);
  };
  const shortcut = target => {
    for (let node = target; node && node !== body; node = node.parentNode) {
      const id = node.getAttribute('data-desktop-shortcut');
      if (id !== null) return id;
    }
    return null;
  };
  const point = event => {
    const bounds = body.getBoundingClientRect();
    return { x: Math.max(0, Math.min(body.offsetWidth, event.clientX - bounds.x)),
      y: Math.max(0, Math.min(body.offsetHeight, event.clientY - bounds.y)) };
  };
  function release() {
    if (!captured) return;
    captured = false;
    try { body.releaseMouseCapture(); }
    catch (error) { failure(error); }
  }
  function cancel() { controller.cancel(); release(); }
  listen('mousedown', event => {
    if (stopped || event.button !== 0) return;
    const id = shortcut(event.target), position = point(event);
    event.preventDefault();
    const focus = id === null ? body : event.target;
    focus.focus();
    controller.down(id, position.x, position.y, event);
    try { body.setMouseCapture(); captured = true; }
    catch (error) { controller.cancel(); failure(error); }
  });
  listen('mousemove', event => {
    if (!controller.state.held) return;
    if (!(event.buttons & 1)) { cancel(); return; }
    const position = point(event);
    controller.move(position.x, position.y);
  });
  listen('mouseup', event => {
    if (event.button !== 0 || !controller.state.held) return;
    const position = point(event);
    controller.up(position.x, position.y); release();
  });
  listen('mousecancel', () => { captured = false; controller.cancel(); });
  listen('lostmousecapture', () => { captured = false; controller.cancel(); });
  listen('dblclick', event => {
    if (event.button === 0) controller.doubleClick(shortcut(event.target), event);
  });
  listen('contextmenu', event => {
    event.preventDefault(); event.stopPropagation();
    cancel(); controller.context(shortcut(event.target));
  });
  listen('keydown', event => {
    if (event.defaultPrevented) return;
    if (controller.key(event)) {
      event.preventDefault(); event.stopPropagation();
      if (!controller.state.held) release();
      const id = controller.state.focused;
      const node = id && body.ownerDocument.getElementById('shell-desktop-icon-' + id);
      node?.focus();
    }
  });
  return {
    cancel,
    stop() {
      stopped = true; cancel();
      for (const [type, callback] of listeners) body.removeEventListener(type, callback);
    },
  };
}
