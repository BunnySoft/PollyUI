import { createVerticalScrollbar } from './gui/sdk/js/scrollbar.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
export function scrollbarScene() {
  const add = (parent, style) => {
    const node = document.createElement('view');
    Object.assign(node.style, style); parent.appendChild(node); return node;
  };
  const root = add(document.body, { position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', backgroundColor: '#eef0f3' });
  const viewport = add(root, { position: 'absolute', left: 20, top: 20, width: 300, height: 200, overflow: 'scroll' });
  for (let index = 0; index < 100; index++) add(viewport, { height: 42, flexShrink: 0,
    backgroundColor: index % 2 ? '#ffffff' : '#e5e7eb' });
  const track = add(root, { position: 'absolute', left: 330, top: 20, width: 10, height: 200,
    borderRadius: 5, backgroundColor: '#f3f3f3' });
  track.setAttribute('role', 'scrollbar'); track.setAttribute('aria-orientation', 'vertical');
  const thumb = add(track, { position: 'absolute', left: 2, width: 6, pointerEvents: 'none',
    borderRadius: 2, backgroundColor: '#616161' });
  return { root, viewport, track, thumb };
}

export function checkLegacyScrollbar(directory) {
  const scene = scrollbarScene(), { viewport, track, thumb } = scene;
  const controller = createVerticalScrollbar(scene);
  host.render(); controller.update(); host.render();
  check(Number(thumb.style.height) === 28, 'Legacy minimum thumb height is unchanged');
  check(host.save(directory + '\\normal.png'), 'Save complete legacy resting PNG');
  track.focus(); host.key('End', 'keydown', { text: false }); host.render();
  check(viewport.scrollTop === 4000, 'Legacy keyboard path reaches the same actual bottom');
  check(host.save(directory + '\\end.png'), 'Save complete legacy focused/bottom PNG');
  host.key('Home', 'keydown', { text: false }); host.render();
  host.mouse('mousedown', 335, 30); host.mouse('mousemove', 335, 110, { buttons: 1 }); host.render();
  check(track.hasMouseCapture(), 'Legacy drag retains the original track capture owner');
  check(host.save(directory + '\\drag.png'), 'Save complete legacy held PNG');
  host.mouse('mouseup', 335, 110);
  controller.stop(); scene.root.parentNode.removeChild(scene.root);
  console.log('SCROLLBAR_LEGACY_PASS');
}
