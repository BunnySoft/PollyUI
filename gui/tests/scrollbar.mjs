import { createVerticalScrollbar, verticalScrollMetrics } from './gui/sdk/js/scrollbar.mjs';

let passed = 0;
function check(name, value) {
  if (!value) throw new Error('FAIL: ' + name);
  console.log('PASS: ' + name); passed++;
}
function box(parent, style) {
  const node = document.createElement('view');
  Object.assign(node.style, style); parent.appendChild(node); return node;
}
const viewport = box(document.body, { position: 'absolute', left: 20, top: 20, width: 300, height: 200, overflow: 'scroll' });
for (let index = 0; index < 100; index++) box(viewport, { height: 42, flexShrink: 0 });
const track = box(document.body, { position: 'absolute', left: 330, top: 20, width: 10, height: 200 });
const thumb = box(track, { position: 'absolute', left: 2, width: 6, pointerEvents: 'none' });
let current = true;
const scrollbar = createVerticalScrollbar({ viewport, track, thumb, isCurrent: () => current });
host.render(); scrollbar.update(); host.render();
let metrics = verticalScrollMetrics(viewport, track.offsetHeight);
check('thumb is proportional with a 28 pixel minimum', metrics.maximum === 4000 && metrics.thumbHeight === 28);
host.mouse('mousedown', 335, 30);
check('thumb press captures the track', track.hasMouseCapture());
host.mouse('mousemove', 500, 400, { buttons: 1 });
host.mouse('mouseup', 500, 400);
metrics = scrollbar.update();
check('drag outside the track clamps to actual bottom scrollTop', viewport.scrollTop === 4000 && !track.hasMouseCapture());
check('thumb and accessibility values match the scroll offset', Number(thumb.style.top) === metrics.travel &&
  Number(track.getAttribute('aria-valuenow')) === viewport.scrollTop);
track.focus(); host.key('Home'); scrollbar.update(); host.render();
host.mouse('mousedown', 335, 180); host.mouse('mouseup', 335, 180);
check('track press pages by the real viewport height', viewport.scrollTop === 200 && !track.hasMouseCapture());
host.key('End'); check('keyboard End scrolls to the bottom', viewport.scrollTop === 4000);
host.key('PageUp'); check('keyboard PageUp scrolls by one viewport', viewport.scrollTop === 3800);
host.key('ArrowUp'); check('keyboard arrow scrolls one row', viewport.scrollTop === 3758);
host.key('Home'); scrollbar.update(); host.render();
host.mouse('mousedown', 335, 30);
host.mouse('mousecancel', 0, 0);
host.mouse('mousemove', 335, 180); host.mouse('mouseup', 335, 180);
check('cancellation ignores late thumb input', viewport.scrollTop === 0 && !track.hasMouseCapture());
host.mouse('mousedown', 335, 30);
document.body.removeChild(track); document.body.appendChild(track); host.render();
host.mouse('mousemove', 335, 180); host.mouse('mouseup', 335, 180);
check('detach and reattach cannot resume scrolling', viewport.scrollTop === 0 && !track.hasMouseCapture());
host.mouse('mousedown', 335, 30); current = false; scrollbar.update();
host.mouse('mousemove', 335, 180); host.mouse('mouseup', 335, 180);
check('retired gesture callbacks cannot scroll a new state', viewport.scrollTop === 0 && !track.hasMouseCapture() && track.tabIndex === -1);
current = true; scrollbar.update();
while (viewport.childNodes.length > 1) viewport.removeChild(viewport.lastChild);
host.render(); scrollbar.update();
check('short list hides and disables the rail', viewport.scrollTop === 0 && track.style.pointerEvents === 'none' && track.tabIndex === -1);
scrollbar.stop();
console.log(passed + ' scrollbar assertions passed (headless capture adapter)');
