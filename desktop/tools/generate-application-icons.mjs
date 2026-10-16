// Original Polly artwork; regenerate with a 64x64 playground --test viewport.
const output = application.arguments[0] || 'desktop/resources/application-icons';
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
function tile(from, to) {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
  document.body.style.backgroundColor = '#00000000';
  return box(document.body, 0, 0, 64, 64, from, { gradientFrom: from, gradientTo: to,
    gradientDir: 'vertical' });
}
function save(name) {
  host.render();
  host.render();
  if (!host.save(output + separator + name + '.png'))
    throw new Error('Cannot save ' + name + '.png');
}

let root = tile('#fff3d3', '#f5d58e');
box(root, 9, 17, 22, 12, '#e3a835', { borderRadius: 3 });
box(root, 8, 24, 48, 29, '#e9ac34', { borderRadius: 4, borderWidth: 1, borderColor: '#a56b12' });
box(root, 10, 27, 44, 23, '#ffdb76', { gradientFrom: '#ffe494', gradientTo: '#f4bd48',
  gradientDir: 'vertical', borderRadius: 3 });
box(root, 14, 30, 35, 2, '#fff0bd', { borderRadius: 1 });
save('polly-files');

root = tile('#419dde', '#1261ae');
for (let i = 0; i < 4; i++)
  box(root, 27, 11, 10, 42, '#eaf5ff', { borderRadius: 2, rotate: i * 45 });
box(root, 16, 16, 32, 32, '#eaf5ff', { borderRadius: 16 });
box(root, 24, 24, 16, 16, '#226fb5', { borderRadius: 8, borderWidth: 2, borderColor: '#b6ddf6' });
save('polly-settings');

root = tile('#5da586', '#23715b');
box(root, 8, 12, 48, 34, '#eaf7f0', { borderRadius: 4, borderWidth: 2, borderColor: '#d2e9df' });
box(root, 12, 16, 40, 26, '#1a443c', { borderRadius: 1 });
box(root, 17, 29, 6, 9, '#79d4a4');
box(root, 29, 21, 6, 17, '#b3e9c8');
box(root, 41, 25, 6, 13, '#79d4a4');
box(root, 29, 46, 6, 5, '#c4e3d5');
box(root, 21, 51, 22, 3, '#eaf7f0', { borderRadius: 1 });
save('polly-processes');

root = tile('#c1d5ed', '#7b9fc6');
box(root, 15, 7, 35, 50, '#fcfcf7', { borderRadius: 3, borderWidth: 1, borderColor: '#4e7199' });
box(root, 20, 15, 18, 3, '#426b9e', { borderRadius: 1 });
for (const y of [24, 31, 38, 45])
  box(root, 20, y, y === 45 ? 16 : 24, 2, '#91acc7', { borderRadius: 1 });
save('polly-file-text');
console.log('Generated four original Polly application icons');
