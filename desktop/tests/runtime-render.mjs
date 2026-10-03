// Same scene on raster/GLES; resize twice and let the host capture actual frames.
const add = (style, parent = document.body) => {
  const node = document.createElement('view');
  Object.assign(node.style, style);
  parent.appendChild(node);
  return node;
};
Object.assign(document.body.style, { backgroundColor: '#f4f6fa' });
add({ position: 'absolute', left: 20, top: 20, width: 80, height: 70, backgroundColor: '#ff0000' });
add({ position: 'absolute', left: 130, top: 20, width: 80, height: 70, backgroundColor: '#0000ff' });
add({ position: 'absolute', left: 20, top: 130, width: 190, height: 60,
  gradientFrom: '#00ff00', gradientTo: '#0000ff' });
const blend = add({ position: 'absolute', left: 240, top: 20, width: 80, height: 70, backgroundColor: '#0000ff' });
add({ position: 'absolute', left: 0, top: 0, width: 40, height: 70,
  backgroundColor: '#ff0000', opacity: 0.5 }, blend);
add({ position: 'absolute', left: 240, top: 130, width: 80, height: 60,
  borderRadius: 16, backgroundColor: '#123456' });
const label = add({ position: 'absolute', left: 20, top: 230, fontSize: 26, color: '#10243b' });
label.textContent = 'PollyUI rendering';
function waitForState(maximized, next, attempts = 50) {
  if (window.isMaximized() === maximized) { setTimeout(next, 200); return; }
  if (!attempts) {
    console.error('FAIL: window did not acknowledge maximize/restore');
    window.close();
    return;
  }
  setTimeout(() => waitForState(maximized, next, attempts - 1), 100);
}
setTimeout(() => {
  window.maximize();
  waitForState(true, () => {
    window.maximize();
    waitForState(false, () => { console.log('Render fixture complete'); window.close(); });
  });
}, 300);
