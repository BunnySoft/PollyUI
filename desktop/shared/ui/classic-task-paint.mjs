import { h } from './gui/sdk/js/reconciler.mjs';

const painters = new WeakMap();

export function paintClassicTask(canvas, theme, { selected = false, focused = false, document: owner = null } = {}) {
  let painter = painters.get(canvas);
  const colors = theme.colors.body + theme.colors.light + theme.colors.focus;
  if (!painter || painter.colors !== colors) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Classic task texture requires the GUI Canvas 2D context');
    const document = canvas.ownerDocument || painter?.document || owner;
    if (!document) throw new Error('Classic task painter requires its owning document');
    const tile = document.createElement('canvas');
    tile.width = 2; tile.height = 2;
    const ink = tile.getContext('2d');
    if (!ink) throw new Error('Cannot create the Classic task pattern tile');
    ink.fillStyle = theme.colors.body;
    ink.fillRect(0, 0, 2, 2);
    ink.fillStyle = theme.colors.light;
    ink.fillRect(0, 0, 1, 1);
    ink.fillRect(1, 1, 1, 1);
    const pattern = ctx.createPattern(tile, 'repeat');
    if (!pattern) throw new Error('Cannot create the Classic task repeat pattern');
    ink.clearRect(0, 0, 2, 2);
    ink.fillStyle = theme.colors.focus;
    ink.fillRect(0, 0, 1, 1); ink.fillRect(1, 1, 1, 1);
    const focusPattern = ctx.createPattern(tile, 'repeat');
    if (!focusPattern) throw new Error('Cannot create the Classic task focus pattern');
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
