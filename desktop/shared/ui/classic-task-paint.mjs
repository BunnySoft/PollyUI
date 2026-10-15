import { h } from './gui/sdk/js/reconciler.mjs';

const painters = new WeakMap();
const focuses = new WeakMap();
const windowFocuses = new WeakMap();
const focusFinalizers = new FinalizationRegistry(weak => weak.deref()?.());

function repeatPattern(ctx, owner, color, background = null) {
  const tile = owner.createElement('canvas');
  tile.width = 2; tile.height = 2;
  const ink = tile.getContext('2d');
  if (!ink) throw new Error('Cannot create the Classic repeat pattern tile');
  if (background) { ink.fillStyle = background; ink.fillRect(0, 0, 2, 2); }
  ink.fillStyle = color;
  ink.fillRect(0, 0, 1, 1); ink.fillRect(1, 1, 1, 1);
  const pattern = ctx.createPattern(tile, 'repeat');
  if (!pattern) throw new Error('Cannot create the Classic repeat pattern');
  return pattern;
}

function stopFocus(state) {
  if (state.frame !== null) cancelAnimationFrame(state.frame);
  state.frame = null;
  const remove = state.unsubscribe?.deref(), owner = state.owner?.deref();
  if (remove) remove();
  focusFinalizers.unregister(state.finalizerToken);
  if (owner && windowFocuses.get(owner) === remove)
    windowFocuses.delete(owner);
  state.unsubscribe = null;
  state.owner = null;
  state.signature = '';
}

function showFocus(canvas, visible) {
  const opacity = visible ? '1' : '0';
  canvas.style.opacity = opacity;
  if (canvas.parentNode) canvas.parentNode.style.opacity = opacity;
}

function drawFocus(canvas, state) {
  const control = canvas.parentNode?.parentNode?.parentNode, owner = control?.ownerDocument;
  if (!state.focused || !owner || owner !== state.document.deref() ||
      owner.activeElement !== control || control.getAttribute('aria-disabled') === 'true') {
    stopFocus(state);
    showFocus(canvas, false);
    return;
  }
  const width = canvas.offsetWidth, height = canvas.offsetHeight;
  if (width < 1 || height < 1) return;
  const windowState = state.owner?.deref()?.state;
  const scale = windowState ? windowState.scale : 1;
  if (windowState) state.windowSize = [windowState.width, windowState.height, scale].join(':');
  const signature = [width, height, scale, state.theme.colors.focus].join(':');
  if (state.signature === signature) { showFocus(canvas, true); return; }
  const pixelWidth = Math.ceil(width * scale), pixelHeight = Math.ceil(height * scale);
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  const ctx = state.ctx || canvas.getContext('2d');
  if (!ctx) throw new Error('Classic focus requires the GUI Canvas 2D context');
  state.ctx = ctx;
  if (!state.pattern || state.color !== state.theme.colors.focus) {
    state.pattern = repeatPattern(ctx, owner, state.theme.colors.focus);
    state.color = state.theme.colors.focus;
  }
  ctx.resetTransform();
  ctx.clearRect(0, 0, pixelWidth, pixelHeight);
  ctx.save();
  ctx.scale(scale, scale);
  ctx.fillStyle = state.pattern;
  // Each old edge began at its own zero, including the bottom and right edges.
  for (const [x, y, w, h] of [[0, 0, width, 1], [0, height - 1, width, 1],
    [0, 0, 1, height], [width - 1, 0, 1, height]]) {
    ctx.save(); ctx.translate(x, y); ctx.fillRect(0, 0, w, h); ctx.restore();
  }
  ctx.restore();
  state.signature = signature;
  showFocus(canvas, true);
}

function queueFocus(canvas, state) {
  if (state.frame !== null) return;
  // Native rAF precedes layout; the second one-shot sees the intervening layout.
  state.frame = requestAnimationFrame(() => {
    state.frame = requestAnimationFrame(() => {
      state.frame = null;
      drawFocus(canvas, state);
    });
  });
}

export function paintClassicFocus(canvas, theme, focused) {
  let state = focuses.get(canvas);
  if (!state) {
    // Native Canvas roots must not retain their owner through this cache or its finalizer token.
    state = { document: new WeakRef(canvas.ownerDocument || document),
      frame: null, owner: null, finalizerToken: {} };
    focuses.set(canvas, state);
  }
  const control = canvas.parentNode?.parentNode?.parentNode, owner = control?.ownerDocument;
  state.theme = theme;
  state.focused = Boolean(focused) && control?.getAttribute('aria-disabled') !== 'true';
  if (!state.focused || !owner) {
    stopFocus(state);
    showFocus(canvas, false);
    return;
  }
  if (state.document.deref() !== owner) state.document = new WeakRef(owner);
  const view = owner.defaultView;
  if (view !== (state.owner?.deref() || null)) {
    stopFocus(state);
    state.owner = view ? new WeakRef(view) : null;
    if (view) {
      const previous = windowFocuses.get(view);
      if (previous) previous();
      const weak = new WeakRef(canvas);
      let remove;
      remove = view.observeState(next => {
        const node = weak.deref(), current = node && focuses.get(node);
        if (!current || current.owner?.deref() !== view) { remove(); return; }
        const size = [next.width, next.height, next.scale].join(':');
        if (size !== current.windowSize) {
          current.windowSize = size;
          queueFocus(node, current);
        }
      });
      state.unsubscribe = new WeakRef(remove);
      windowFocuses.set(view, remove);
      focusFinalizers.register(canvas, new WeakRef(remove), state.finalizerToken);
    }
  }
  drawFocus(canvas, state);
  queueFocus(canvas, state);
}

export function classicFocusPaint(theme, disabled = false) {
  const sync = canvas => {
    const control = canvas.parentNode?.parentNode?.parentNode;
    paintClassicFocus(canvas, theme, !disabled && Boolean(control) && control.ownerDocument?.activeElement === control);
  };
  return h('canvas', { className: 'classic-focus-paint', 'aria-hidden': 'true',
    style: { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0,
      opacity: 0, pointerEvents: 'none' },
    onMount: canvas => {
      paintClassicFocus(canvas, theme, false);
      Promise.resolve().then(() => { if (canvas.parentNode) sync(canvas); });
    },
    onUpdate: sync,
    onLeave: (canvas, done) => { stopFocus(focuses.get(canvas)); done(); },
  });
}

export function paintClassicTask(canvas, theme, { selected = false, focused = false, document: owner = null } = {}) {
  let painter = painters.get(canvas);
  const colors = theme.colors.body + theme.colors.light + theme.colors.focus;
  if (!painter || painter.colors !== colors) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Classic task texture requires the GUI Canvas 2D context');
    const document = canvas.ownerDocument || painter?.document || owner;
    if (!document) throw new Error('Classic task painter requires its owning document');
    const pattern = repeatPattern(ctx, document, theme.colors.light, theme.colors.body);
    const focusPattern = repeatPattern(ctx, document, theme.colors.focus);
    painter = { ctx, pattern, focusPattern, colors, document };
    painters.set(canvas, painter);
  }
  const { ctx, pattern, focusPattern } = painter, width = canvas.width, height = canvas.height;
  const signature = [width, height, Boolean(selected), Boolean(focused)].join(':');
  painter.theme = theme; painter.selected = selected;
  if (painter.signature === signature) return;
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  if (selected) {
    ctx.fillStyle = pattern;
    ctx.fillRect(2, 2, Math.max(0, width - 4), Math.max(0, height - 4));
  }
  if (focused) {
    ctx.fillStyle = focusPattern;
    ctx.fillRect(3, 3, Math.max(0, width - 6), 1);
    ctx.fillRect(3, height - 4, Math.max(0, width - 6), 1);
    ctx.fillRect(3, 3, 1, Math.max(0, height - 6));
    ctx.fillRect(width - 4, 3, 1, Math.max(0, height - 6));
  }
  ctx.restore();
  painter.signature = signature;
}

export function classicTaskPaint(theme, width, height, selected) {
  const paint = canvas => {
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    paintClassicTask(canvas, theme, { selected, document,
      focused: canvas.parentNode?.ownerDocument?.activeElement === canvas.parentNode });
  };
  return h('canvas', {
    className: 'classic-task-paint', 'aria-hidden': 'true',
    style: { position: 'absolute', left: 0, top: 0, width, height, pointerEvents: 'none' },
    onMount: canvas => {
      // Capture the synchronous reconciliation document before this node is attached.
      paint(canvas);
      // Mount runs before attachment; retained task focus is known after reconciliation.
      Promise.resolve().then(() => {
        const task = canvas.parentNode;
        const current = painters.get(canvas);
        if (task && current) paintClassicTask(canvas, current.theme, {
          selected: current.selected, focused: task.ownerDocument.activeElement === task,
        });
      });
    },
    onUpdate: paint,
  });
}
