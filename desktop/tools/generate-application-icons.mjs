// Original Polly artwork in a Fluent 2 style; regenerate with a 64x64 playground --test viewport.
const output = (typeof application !== 'undefined' && application.arguments?.[0]) ||
  'desktop/resources/application-icons';
if (host.width !== 64 || host.height !== 64)
  throw new Error('Application icons require a 64x64 test viewport');
const separator = output.includes('\\') ? '\\' : '/';

function box(parent, x, y, width, height, color, extra = {}) {
  const node = document.createElement('view');
  Object.assign(node.style, { position: 'absolute', left: x, top: y, width, height,
    backgroundColor: color, pointerEvents: 'none', ...extra });
  parent.appendChild(node);
  return node;
}
function clear() {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
  document.body.style.backgroundColor = '#00000000';
  return box(document.body, 0, 0, 64, 64, '#00000000');
}
function save(name) {
  host.render();
  host.render();
  if (!host.save(output + separator + name + '.png'))
    throw new Error('Cannot save ' + name + '.png');
}

// Files: layered Fluent folder, transparent canvas.
let root = clear();
box(root, 8, 17, 24, 11, '#d99a2b', { borderRadius: 4 });
box(root, 7, 24, 50, 29, '#e8ab36', { borderRadius: 7, borderWidth: 1, borderColor: '#c78718' });
box(root, 9, 26, 46, 25, '#ffcf5c', { gradientFrom: '#ffe18a', gradientTo: '#f5b93c',
  gradientDir: 'vertical', borderRadius: 5 });
box(root, 13, 31, 30, 3, '#fff3c4', { borderRadius: 1.5 });
box(root, 13, 37, 22, 2, '#f8d888', { borderRadius: 1 });
save('polly-files');

// Settings: five-lobe Fluent gear with a transparent center.
root = clear();
for (let i = 0; i < 4; i++)
  box(root, 26, 3, 12, 58, '#496b9b', { borderRadius: 4, rotate: i * 45 });
box(root, 12, 12, 40, 40, '#00000000', { borderRadius: 20, borderWidth: 9, borderColor: '#5b7fb0' });
box(root, 18, 18, 28, 28, '#00000000', { borderRadius: 14, borderWidth: 2, borderColor: '#7fa6d6' });
save('polly-settings');

// Processes: a monitor with a live activity trace, distinct from the terminal.
root = clear();
box(root, 6, 9, 52, 39, '#143756', { gradientFrom: '#245c83', gradientTo: '#102c49',
  gradientDir: 'vertical', borderRadius: 7, borderWidth: 2, borderColor: '#417d9b' });
for (const x of [18, 30, 42]) box(root, x, 16, 1, 24, '#28526b');
for (const y of [22, 32]) box(root, 12, y, 40, 1, '#28526b');
for (const [x, y, width, height, rotate] of [
  [12, 32, 9, 3, 0], [18, 26, 12, 3, -60], [23, 27, 20, 3, 72],
  [32, 30, 14, 3, -64], [40, 29, 12, 3, 0],
]) box(root, x, y, width, height, '#79edb9', { rotate, borderRadius: 1.5 });
box(root, 28, 48, 8, 6, '#56839c');
box(root, 19, 54, 26, 4, '#305874', { borderRadius: 2 });
save('polly-processes');

// Foot: an original terminal tile, not the process monitor artwork.
root = clear();
box(root, 6, 9, 52, 46, '#15223a', { gradientFrom: '#253c5e', gradientTo: '#10192b',
  gradientDir: 'vertical', borderRadius: 8, borderWidth: 1, borderColor: '#536e95' });
box(root, 7, 10, 50, 9, '#4b6384', { borderRadius: 5 });
for (const x of [13, 19, 25]) box(root, x, 13, 3, 3, '#b2c6e0', { borderRadius: 1.5 });
box(root, 15, 28, 12, 3, '#85e3c1', { borderRadius: 1.5, rotate: 42 });
box(root, 15, 35, 12, 3, '#85e3c1', { borderRadius: 1.5, rotate: -42 });
box(root, 30, 39, 13, 3, '#e3ebf7', { borderRadius: 1.5 });
save('polly-foot');

// File Text: Fluent document with a blue header and folded corner.
root = clear();
box(root, 15, 7, 34, 50, '#ffffff', { borderRadius: 4, borderWidth: 1, borderColor: '#c9d4e2' });
box(root, 41, 7, 8, 8, '#e8eef7', { borderRadius: 2, borderWidth: 1, borderColor: '#c9d4e2' });
box(root, 20, 15, 22, 4, '#2f6fd0', { borderRadius: 2 });
for (const y of [25, 31, 37, 43])
  box(root, 20, y, y === 43 ? 16 : 24, 2, '#b7c4d4', { borderRadius: 1 });
save('polly-file-text');

console.log('Generated five original Polly application icons');
