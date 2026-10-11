let passed = 0;
function check(name, value) {
  if (!value) throw new Error('FAIL: ' + name);
  console.log('PASS: ' + name); passed++;
}
function rejects(name, callback) {
  let rejected = false;
  try { callback(); } catch (error) { rejected = error instanceof TypeError; }
  check(name, rejected);
}
function box(x) {
  const node = document.createElement('view');
  Object.assign(node.style, { position: 'absolute', left: x, top: 20, width: 80, height: 80 });
  document.body.appendChild(node);
  return node;
}
const left = box(20), right = box(160);
const events = [];
let capture = true;
left.addEventListener('mousedown', e => {
  events.push('down');
  if (capture) e.currentTarget.setMouseCapture();
});
left.addEventListener('gotmousecapture', () => events.push('got'));
left.addEventListener('lostmousecapture', () => events.push('lost'));
left.addEventListener('mousemove', e => events.push('move:' + e.clientX));
left.addEventListener('mouseup', () => events.push('up'));
left.addEventListener('click', () => events.push('click-left'));
left.addEventListener('mousecancel', e => {
  events.push('cancel:' + e.reason);
  rejects('cancel callback cannot reacquire capture', () => left.setMouseCapture());
});
right.addEventListener('click', () => events.push('click-right'));
host.render();
rejects('capture requires an active press', () => left.setMouseCapture());
rejects('capture accepts no arguments', () => left.setMouseCapture(1));
host.mouse('mousedown', 40, 40);
check('capture belongs to exactly one node', left.hasMouseCapture() && !right.hasMouseCapture());
host.mouse('mousemove', 180, 40, { buttons: 1 });
host.mouse('mouseup', 180, 40);
host.mouse('click', 180, 40);
check('captured motion and release reach the original node outside its bounds',
  events.includes('move:180') && events.includes('up'));
check('last button release automatically loses capture', !left.hasMouseCapture() && events.at(-1) === 'lost');
check('release over another node cannot activate either node',
  !events.includes('click-left') && !events.includes('click-right'));
events.length = 0;
host.mouse('mousedown', 40, 40);
host.mouse('mousemove', 70, 40, { buttons: 1 });
host.mouse('mousemove', 40, 40, { buttons: 1 });
host.mouse('mouseup', 40, 40);
host.mouse('click', 40, 40);
check('dragging out and back suppresses a click', !events.includes('click-left'));
events.length = 0;
host.mouse('mousedown', 40, 40);
host.mouse('mouseup', 41, 40);
host.mouse('click', 41, 40);
check('small movement preserves a normal click', events.includes('click-left'));
events.length = 0;
host.mouse('mousedown', 40, 40);
host.mouse('mouseup', 43.99, 40);
host.mouse('click', 43.99, 40);
check('movement below four logical pixels remains a click', events.includes('click-left'));
events.length = 0;
host.mouse('mousedown', 40, 40);
host.mouse('mouseup', 44, 40);
host.mouse('click', 44, 40);
check('four logical pixels suppress click even without a motion event', !events.includes('click-left'));
events.length = 0;
host.mouse('mousedown', 40, 40);
host.mouse('mousedown', 180, 40, { button: 1, buttons: 5 });
host.mouse('mouseup', 180, 40, { button: 1, buttons: 1 });
host.mouse('auxclick', 180, 40, { button: 1, buttons: 1 });
check('releasing one of multiple buttons retains capture', left.hasMouseCapture());
host.mouse('mouseup', 40, 40);
host.mouse('click', 40, 40);
check('only the last held button releases capture', !left.hasMouseCapture());
events.length = 0;
host.mouse('mousedown', 40, 40);
host.mouse('mousecancel', 0, 0);
host.mouse('mouseup', 40, 40);
host.mouse('click', 40, 40);
check('host cancellation releases capture and suppresses a late click',
  events.includes('cancel:host-cancelled') && events.includes('lost') &&
  !left.hasMouseCapture() && !events.includes('click-left'));
const cancellations = events.filter(value => value.startsWith('cancel:')).length;
host.mouse('mousecancel', 0, 0);
check('duplicate cancellation does not replay the interaction',
  events.filter(value => value.startsWith('cancel:')).length === cancellations);
events.length = 0;
host.mouse('mousedown', 40, 40);
document.body.removeChild(left);
check('detaching the capture owner cancels and releases immediately',
  events.includes('cancel:node-detached') && events.includes('lost'));
rejects('detached nodes cannot inspect or acquire live capture', () => left.hasMouseCapture());
document.body.appendChild(left);
host.render();
check('reattachment cannot resurrect capture', !left.hasMouseCapture());
capture = false;
events.length = 0;
host.mouse('mousedown', 40, 40);
document.body.removeChild(left);
document.body.appendChild(left);
host.render();
host.mouse('mouseup', 40, 40);
host.mouse('click', 40, 40);
check('detaching an uncaptured press invalidates its click even after reattachment',
  !events.includes('click-left'));
const sibling = box(300);
host.mouse('mousedown', 40, 40);
left.setMouseCapture();
sibling.setMouseCapture();
check('capture transfer releases the prior owner', !left.hasMouseCapture() && sibling.hasMouseCapture());
sibling.releaseMouseCapture();
check('explicit release is idempotent', !sibling.hasMouseCapture());
sibling.releaseMouseCapture();
host.mouse('mouseup', 40, 40);
host.mouse('click', 40, 40);
host.mouse('mousedown', 40, 40);
left.setMouseCapture();
const recapture = () => sibling.setMouseCapture();
left.addEventListener('lostmousecapture', recapture);
rejects('a reentrant capture transfer is not overwritten', () => sibling.setMouseCapture());
check('the reentrant capture owner remains valid', sibling.hasMouseCapture() && !left.hasMouseCapture());
left.removeEventListener('lostmousecapture', recapture);
host.mouse('mouseup', 40, 40);
host.mouse('click', 40, 40);
host.mouse('click', 180, 40);
check('an unpaired click cannot activate a target', !events.includes('click-right'));
console.log(passed + ' mouse-capture assertions passed (headless capture adapter)');
