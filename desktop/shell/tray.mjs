import { h, render } from './js/reconciler.mjs';

export function trayView(theme, items, activate, scroll) {
  return h('view', { id: 'shell-tray', role: 'toolbar',
    style: { flexDirection: 'row', alignItems: 'center', flexShrink: 1, maxWidth: 240, gap: 4, overflow: 'scroll' } },
  ...items.filter(item => item.status !== 'Passive').map(item => {
    const act = (event, kind) => {
      event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect();
      activate(item, kind, Math.round(event.clientX ?? rect.x), Math.round(event.clientY ?? rect.y));
    };
    return h('view', { id: 'shell-tray-' + item.id, role: 'button', tabIndex: 0, 'aria-label': item.title,
      style: { width: item.icon ? 28 : 64, height: 24, flexShrink: 0, padding: 2, overflow: 'hidden',
        alignItems: 'center', justifyContent: 'center', borderRadius: theme.button.radius,
        borderWidth: 1, borderColor: item.status === 'NeedsAttention' || item.error ? theme.colors.accent : theme.colors.border },
      focusStyle: { borderColor: '#ffb62b' },
      onClick: event => act(event, 'activate'),
      onAuxclick: event => { if (event.button === 1) act(event, 'secondary'); },
      onContextmenu: event => { event.preventDefault(); act(event, 'menu'); },
      onKeydown: event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); act(event, 'activate'); }
        else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
          event.preventDefault(); act(event, 'menu');
        }
      },
      onWheel: event => {
        event.preventDefault(); event.stopPropagation();
        const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
        scroll(item, Math.round(-(horizontal ? event.deltaX : event.deltaY) * 3), horizontal);
      },
    }, item.icon ? h('view', { style: { width: 20, height: 20, backgroundImage: item.icon } }) :
      h('view', { style: { fontSize: 10, color: theme.colors.text } }, item.title));
  }));
}

export function createTray({ native, report, changed, host, theme }) {
  let items = [], started = false, previous;
  let menu = null, position = null;
  const errors = new Set();
  function closeMenu() {
    if (menu && !menu.window.closed) menu.window.close();
    menu = null; position = null;
    if (started) native.closeTrayMenu();
  }
  function menuButton(id, label, callback, enabled = true) {
    const current = theme();
    return h('view', { id, className: 'tray-menu-entry', role: 'menuitem', 'aria-disabled': String(!enabled), tabIndex: enabled ? 0 : -1,
      style: { padding: 8, minHeight: 30, flexShrink: 0, color: enabled ? current.colors.text : current.colors.muted,
        fontSize: 12, borderRadius: current.button.radius, backgroundColor: current.colors.surface },
      hoverStyle: enabled ? { backgroundColor: current.colors.selection } : {},
      focusStyle: enabled ? { backgroundColor: current.colors.selection } : {},
      onClick: () => { if (enabled) callback(); },
      onKeydown: event => { if (enabled && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); callback(); } },
    }, label);
  }
  function openMenu(item, root) {
    try { native.openTrayMenu(item.id, item.revision, root); paintMenu(); }
    catch (error) { report('[shell] Cannot open tray menu: ' + String(error)); closeMenu(); }
  }
  function paintMenu() {
    if (!started) return;
    const state = native.trayMenu();
    if (!state.itemId) { if (menu && !menu.window.closed) menu.window.close(); menu = null; return; }
    const output = host.displays().find(output => position && position.x >= output.x && position.x < output.x + output.width &&
      position.y >= output.y && position.y < output.y + output.height) || host.displays()[0];
    if (!output) { closeMenu(); return; }
    const width = Math.max(1, Math.min(320, output.width - 16)), height = Math.max(1, Math.min(420, output.height - 16));
    const geometry = [output.id, output.x, output.y, output.width, output.height].join(':');
    if (menu && (menu.window.closed || menu.geometry !== geometry)) {
      if (!menu.window.closed) menu.window.close();
      menu = null;
    }
    if (!menu) {
      const x = Math.max(8, Math.min((position?.x ?? output.x) - output.x, output.width - width - 8));
      const y = Math.max(8, Math.min((position?.y ?? output.y) - output.y, output.height - height - 8));
      const window = host.create({ title: 'PollyShell.tray-menu.' + output.id, output: output.id,
        layer: 'overlay', keyboard: 'exclusive', anchors: ['top', 'left'], width, height,
        margins: { left: x, top: y }, exclusiveZone: -1, transparent: true });
      menu = { window, geometry };
      window.onclose = () => { if (menu?.window === window) { menu = null; if (started) native.closeTrayMenu(); } };
      window.document.body.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); closeMenu(); }
        else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const nodes = window.document.querySelectorAll('.tray-menu-entry').filter(node => node.tabIndex >= 0);
          const index = nodes.indexOf(window.document.activeElement), direction = event.key === 'ArrowDown' ? 1 : -1;
          if (nodes.length) nodes[index < 0 ? direction > 0 ? 0 : nodes.length - 1 :
            (index + direction + nodes.length) % nodes.length].focus();
        }
      });
    }
    const current = theme(), target = items.find(item => item.id === state.itemId);
    if (!target) { closeMenu(); return; }
    Object.assign(menu.window.document.body.style, { backgroundColor: current.colors.body, padding: 8 });
    const label = text => text.replace(/__|_/g, match => match === '__' ? '_' : '');
    const entries = state.items.map(entry => entry.separator ? h('view', { style: { height: 1, backgroundColor: current.colors.border } }) :
      menuButton('shell-tray-menu-item-' + entry.id,
        (entry.toggle ? entry.toggleState === 1 ? '[x] ' : entry.toggleState === 0 ? '[ ] ' : '[-] ' : '') +
          label(entry.label) + (entry.submenu ? ' >' : ''),
        () => {
          if (entry.submenu) openMenu(target, entry.id);
          else {
            try { native.invokeTrayMenu(state.itemId, state.revision, entry.id); closeMenu(); }
            catch (error) { report('[shell] Tray menu action failed: ' + String(error)); paintMenu(); }
          }
        }, entry.enabled));
    render(h('view', { id: 'shell-tray-menu', role: 'menu', style: { flex: 1, gap: 4, overflow: 'scroll' } },
      menuButton('shell-tray-menu-close', 'Close', closeMenu),
      state.root ? menuButton('shell-tray-menu-root', 'Main menu', () => openMenu(target, 0)) : null,
      state.pending ? h('view', { style: { color: current.colors.text, fontSize: 12 } }, 'Loading menu...') :
        state.error ? h('view', { role: 'alert', style: { color: current.colors.text, fontSize: 12 } }, state.error) : entries),
    menu.window.document.body);
    if (!menu.window.document.activeElement)
      menu.window.document.querySelectorAll('.tray-menu-entry').find(node => node.tabIndex >= 0)?.focus();
  }
  function refresh() {
    if (!started) return;
    try {
      items = native.trayItems().sort((a, b) => a.id - b.id);
      const currentErrors = new Set();
      for (const item of items) {
        const key = item.id + ':' + item.error;
        if (item.error) {
          currentErrors.add(key);
          if (!errors.has(key)) { errors.add(key); report('[shell] Tray item: ' + item.error); }
        }
      }
      for (const key of errors) if (!currentErrors.has(key)) errors.delete(key);
      paintMenu();
      changed();
    } catch (error) {
      items = []; report('[shell] Tray unavailable: ' + String(error));
      if (menu && !menu.window.closed) menu.window.close();
      menu = null; changed();
    }
  }
  const onChanged = () => { refresh(); if (typeof previous === 'function') previous(); };
  return {
    start() {
      if (!native?.trayAvailable) return;
      try {
        native.startTray();
        started = true; previous = native.onTrayChanged; native.onTrayChanged = onChanged;
        refresh();
      } catch (error) { report('[shell] Cannot start tray: ' + String(error)); }
    },
    stop() {
      if (!started) return;
      closeMenu();
      started = false; items = []; errors.clear();
      if (native.onTrayChanged === onChanged) native.onTrayChanged = previous;
      try { native.stopTray(); } catch (error) { report('[shell] Cannot stop tray: ' + String(error)); }
    },
    items: () => items,
    paint: paintMenu,
    activate(item, kind, x, y) {
      if ((kind === 'menu' || (kind === 'activate' && item.menuOnly)) && item.menu && item.menu !== '/') {
        position = { x, y }; openMenu(item, 0); return;
      }
      try { native.trayAction(item.id, item.revision, kind, x, y); }
      catch (error) { report('[shell] Tray action failed: ' + String(error)); refresh(); }
    },
    scroll(item, delta, horizontal) {
      try { native.trayScroll(item.id, item.revision, delta, horizontal); }
      catch (error) { report('[shell] Tray scroll failed: ' + String(error)); refresh(); }
    },
  };
}
