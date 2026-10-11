let passed = 0;
function check(name, condition) {
  if (!condition) throw new Error('FAIL: ' + name);
  console.log('PASS: ' + name); passed++;
}
const root = document.createElement('view');
Object.assign(root.style, { width: 200, height: 90, overflow: 'auto' });
const content = document.createElement('view');
Object.assign(content.style, { width: 600, height: 260, flexShrink: 0, backgroundColor: '#e0efff' });
root.appendChild(content);
document.body.appendChild(root);
let blocked = false, wheel;
root.addEventListener('wheel', e => { wheel = e; if (blocked) e.preventDefault(); });
host.render();
host.scroll(20, 20, 13.5, 20.25, { ctrlKey: true });
check('two-axis wheel scrolls in logical pixels', root.scrollTop === 13.5 && root.scrollLeft === 20.25);
check('wheel metadata retains fractions and modifiers', wheel.deltaX === 20.25 &&
  wheel.deltaY === 13.5 && wheel.deltaMode === 0 && wheel.ctrlKey);
blocked = true;
host.scroll(20, 20, 50, 60);
check('preventDefault cancels default scrolling', root.scrollTop === 13.5 && root.scrollLeft === 20.25);
blocked = false;
host.scroll(20, 20, 10000, 10000);
check('both axes clamp at content bounds', root.scrollTop === 170 && root.scrollLeft === 400);
host.scroll(20, 20, -10000, -10000);
check('both axes clamp at zero', root.scrollTop === 0 && root.scrollLeft === 0);

let clicks = 0, contexts = 0, down, motion;
root.addEventListener('click', () => clicks++);
root.addEventListener('contextmenu', () => contexts++);
root.addEventListener('mousedown', e => { down = e; });
root.addEventListener('mousemove', e => { motion = e; });
host.mouse('mousedown', 20.5, 20.25, { button: 2, buttons: 2, altKey: true });
check('pointer metadata includes fractional position and button', down.button === 2 &&
  down.buttons === 2 && down.altKey && down.clientX === 20.5 && down.clientY === 20.25);
host.mouse('mousemove', 22, 22, { buttons: 2 });
check('motion reports held buttons separately', motion.buttons === 2 && motion.button === -1);
host.mouse('mouseup', 22, 22, { button: 2 });
host.mouse('contextmenu', 22, 22);
check('context events do not become primary clicks', clicks === 0 && contexts === 1);
host.click(22, 22);
check('primary click keeps existing behavior', clicks === 1);
let invalid = false;
try { host.mouse('mousedown', 10, 10, { button: 9 }); } catch (e) { invalid = e instanceof RangeError; }
check('invalid pointer metadata is rejected', invalid);

const sequence = [];
for (const type of ['mousedown', 'mouseup', 'click', 'dblclick'])
  root.addEventListener(type, e => { sequence.push(e.type + ':' + e.detail); });
host.click(22, 22);
for (const type of ['mousedown', 'mouseup', 'click', 'dblclick'])
  host.mouse(type, 22, 22, { detail: 2 });
check('double click follows both primary click sequences', sequence.join(',') ===
  'mousedown:1,mouseup:1,click:1,mousedown:2,mouseup:2,click:2,dblclick:2');
host.mouse('dblclick', 22, 22);
check('double click is consumed once', sequence.length === 7);
host.click(22, 22);
host.mouse('click', 220, 80, { detail: 2 });
host.mouse('dblclick', 220, 80);
check('nearby clicks on different targets cannot double click the old target',
  !sequence.slice(7).some(value => value.startsWith('dblclick')));
host.mouse('click', 22, 22, { detail: 1 });
host.mouse('click', 22, 22, { button: 2, detail: 2 });
host.mouse('dblclick', 22, 22, { button: 2 });
check('secondary button cannot activate double click',
  sequence.filter(value => value === 'dblclick:2').length === 1);

(function () {
  const node = document.createElement('view');
  node.id = 'removing-wheel-target';
  Object.assign(node.style, { position: 'absolute', left: 300, top: 0,
    width: 80, height: 80, overflow: 'auto' });
  node.addEventListener('wheel', e => { document.body.removeChild(e.currentTarget); });
  document.body.appendChild(node);
})();
host.render();
host.scroll(320, 20, 10);
check('wheel target can remove itself without invalidating dispatch',
  document.getElementById('removing-wheel-target') === null);
const removing = document.createElement('view');
Object.assign(removing.style, { position: 'absolute', left: 300, top: 0, width: 80, height: 80 });
let detachedDouble = false;
removing.addEventListener('dblclick', () => { detachedDouble = true; });
removing.addEventListener('click', e => { if (e.detail === 2) document.body.removeChild(removing); });
document.body.appendChild(removing);
host.render();
host.click(320, 20);
host.mouse('click', 320, 20, { detail: 2 });
host.mouse('dblclick', 320, 20);
check('removed second-click target cannot receive double click', !detachedDouble);
console.log(passed + ' pointer-event assertions passed');
