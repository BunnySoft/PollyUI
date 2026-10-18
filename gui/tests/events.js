// events.js — bubbling control, preventDefault, pointer types, hover, keyup.

let pass = 0, fail = 0;
function check(n, c) { if (c) { pass++; console.log('PASS: ' + n); } else { fail++; console.log('FAIL: ' + n); } }
const el = (s, p) => { const n = document.createElement('view'); if (s) for (const k in s) n.style[k] = s[k]; if (p) p.appendChild(n); return n; };

// Layout: a parent box with a child box inside it.
const parent = el({ width: 200, height: 200, margin: 20 }, document.body);
const child = el({ width: 100, height: 100, margin: 30 }, parent); // child at ~(50,50)..(150,150)

// --- bubbling: child click reaches parent ---
let log = [];
parent.addEventListener('click', () => log.push('parent'));
child.addEventListener('click', () => log.push('child'));
host.click(80, 80);   // inside child
check('event bubbles child -> parent', log.join(',') === 'child,parent');

// --- stopPropagation: child stops the bubble ---
log = [];
const stopper = (e) => { log.push('child'); e.stopPropagation(); };
child.addEventListener('click', stopper);
host.click(80, 80);
check('stopPropagation blocks the parent', log.indexOf('parent') === -1);
child.removeEventListener('click', stopper);

// --- preventDefault sets defaultPrevented ---
let wasPrevented = null;
child.addEventListener('mousedown', (e) => { e.preventDefault(); wasPrevented = e.defaultPrevented; });
host.mouse('mousedown', 80, 80);
check('preventDefault sets defaultPrevented', wasPrevented === true);

// --- clientX/clientY carried on pointer events ---
let pt = null;
child.addEventListener('mouseup', (e) => { pt = [e.clientX, e.clientY]; });
host.mouse('mouseup', 75, 85);
check('pointer event carries clientX/Y', pt && pt[0] === 75 && pt[1] === 85);

// --- mouseenter / mouseleave as hover moves between elements ---
let hover = [];
child.addEventListener('mouseenter', () => hover.push('enter'));
child.addEventListener('mouseleave', () => hover.push('leave'));
host.mouse('mousemove', 80, 80);    // enter child
host.mouse('mousemove', 5, 5);      // leave to empty space (outside parent)
check('mouseenter then mouseleave fire on hover change', hover.join(',') === 'enter,leave');

// --- keyup (distinct from keydown) ---
let keys = [];
child.tabIndex = 0;
child.focus();
child.addEventListener('keydown', (e) => keys.push('down:' + e.key));
child.addEventListener('keyup', (e) => keys.push('up:' + e.key));
host.key('a');            // default type = keydown
host.key('a', 'keyup');   // explicit keyup
check('keydown + keyup dispatch separately', keys.join(',') === 'down:a,up:a');

function listenerCase(run) {
  const outer = el({ position: 'absolute', left: 260, top: 0, width: 100, height: 80 }, document.body);
  const node = el({ width: 80, height: 60 }, outer);
  node.tabIndex = 0; node.focus();
  try { run(node, outer); }
  finally { if (outer.parentNode) outer.parentNode.removeChild(outer); }
}
const dispatchKey = () => host.key('F12', 'keydown', { text: false });

listenerCase(node => {
  let added = false, calls = [];
  const late = () => calls.push('late');
  node.addEventListener('keydown', () => {
    calls.push('first');
    if (!added) { added = true; node.addEventListener('keydown', late); }
  });
  node.addEventListener('keydown', () => calls.push('tail'));
  dispatchKey();
  check('same-node additions wait until the next dispatch phase', calls.join(',') === 'first,tail');
  calls = []; dispatchKey();
  check('a later dispatch includes the new registration once', calls.join(',') === 'first,tail,late');
});

listenerCase(node => {
  const calls = [], removed = () => calls.push('removed');
  node.addEventListener('keydown', () => { calls.push('first'); node.removeEventListener('keydown', removed); });
  node.addEventListener('keydown', removed);
  node.addEventListener('keydown', () => calls.push('tail'));
  dispatchKey();
  check('removing an unvisited registration suppresses only that registration', calls.join(',') === 'first,tail');
});

listenerCase(node => {
  const calls = [], self = () => { calls.push('self'); node.removeEventListener('keydown', self); };
  node.addEventListener('keydown', self);
  node.addEventListener('keydown', () => calls.push('next'));
  node.addEventListener('keydown', () => calls.push('tail'));
  dispatchKey();
  check('self-removal does not skip the next existing listener', calls.join(',') === 'self,next,tail');
});

listenerCase(node => {
  let rebound = false, calls = [];
  const same = () => calls.push('same');
  node.addEventListener('keydown', () => {
    calls.push('first');
    if (!rebound) {
      rebound = true; node.removeEventListener('keydown', same); node.addEventListener('keydown', same);
    }
  });
  node.addEventListener('keydown', same);
  node.addEventListener('keydown', () => calls.push('tail'));
  dispatchKey();
  check('remove/readd of the same function is a new registration', calls.join(',') === 'first,tail');
  calls = []; dispatchKey();
  check('the rebound function participates in the following dispatch', calls.join(',') === 'first,tail,same');
});

listenerCase(node => {
  let calls = [];
  const replacement = () => calls.push('replacement');
  const original = () => {
    calls.push('original'); node.removeEventListener('keydown', original); node.addEventListener('keydown', replacement);
  };
  node.addEventListener('keydown', original);
  node.addEventListener('keydown', () => calls.push('tail'));
  dispatchKey();
  check('repaint-style handler replacement is not delivered twice', calls.join(',') === 'original,tail');
  calls = []; dispatchKey();
  check('replacement preserves registration order in its next phase', calls.join(',') === 'tail,replacement');
});

listenerCase(node => {
  let calls = 0;
  const duplicate = () => calls++;
  node.addEventListener('keydown', duplicate); node.addEventListener('keydown', duplicate);
  dispatchKey();
  check('duplicate registrations remain distinct deliveries', calls === 2);
  node.removeEventListener('keydown', duplicate); dispatchKey();
  check('removeEventListener removes only the first matching duplicate', calls === 3);
});

listenerCase((node, outer) => {
  const calls = [];
  outer.addEventListener('keydown', () => calls.push('parent'));
  node.addEventListener('keydown', event => { calls.push('first'); event.stopPropagation(); });
  node.addEventListener('keydown', () => calls.push('tail'));
  dispatchKey();
  check('stopPropagation permits remaining same-node registrations', calls.join(',') === 'first,tail');
});

listenerCase((node, outer) => {
  const calls = [];
  outer.addEventListener('keydown', () => calls.push('parent'));
  node.addEventListener('keydown', event => { calls.push('first'); event.stopImmediatePropagation(); });
  node.addEventListener('keydown', () => calls.push('tail'));
  dispatchKey();
  check('stopImmediatePropagation stops the current phase and bubbling', calls.join(',') === 'first');
});

listenerCase((node, outer) => {
  const flags = [];
  node.addEventListener('keydown', event => event.preventDefault());
  node.addEventListener('keydown', event => flags.push(event.defaultPrevented));
  outer.addEventListener('keydown', event => flags.push(event.defaultPrevented));
  dispatchKey();
  check('defaultPrevented is retained without suppressing listeners or bubbling', flags.length === 2 && flags.every(Boolean));
});

listenerCase(node => {
  const calls = [];
  node.addEventListener('keydown', () => { throw new Error('listener-dispatch-expected-error'); });
  node.addEventListener('keydown', () => calls.push('after'));
  dispatchKey();
  check('a reported listener exception does not suppress the next registration', calls.join(',') === 'after');
});

listenerCase(node => {
  const calls = [];
  let nested = false, added = false;
  node.addEventListener('keydown', () => {
    calls.push(nested ? 'nested-first' : 'outer-first');
    if (!added) {
      added = true;
      node.addEventListener('keydown', () => calls.push(nested ? 'nested-new' : 'outer-new'));
      nested = true; dispatchKey(); nested = false;
    }
  });
  node.addEventListener('keydown', () => calls.push(nested ? 'nested-tail' : 'outer-tail'));
  dispatchKey();
  check('nested dispatch takes an independent registration boundary',
    calls.join(',') === 'outer-first,nested-first,nested-tail,nested-new,outer-tail');
});

listenerCase((node, outer) => {
  const calls = [], detach = event => {
    calls.push('detach'); node.removeEventListener('keydown', detach); outer.removeChild(node);
    event.target = null; event.currentTarget = null;
  };
  outer.addEventListener('keydown', () => calls.push('parent'));
  node.addEventListener('keydown', detach);
  node.addEventListener('keydown', () => calls.push('tail'));
  dispatchKey();
  check('detaching the handler node keeps its phase alive without freezing the old bubble path',
    calls.join(',') === 'detach,tail' && node.ownerDocument === null);
});

listenerCase((node, outer) => {
  const calls = [];
  node.addEventListener('keydown', () => { calls.push('child'); outer.addEventListener('keydown', () => calls.push('parent-new')); });
  outer.addEventListener('keydown', () => calls.push('parent'));
  dispatchKey();
  check('each ancestor snapshots registrations only when its own phase starts', calls.join(',') === 'child,parent,parent-new');
});

listenerCase(node => {
  let calls = 0;
  const listener = () => calls++;
  for (let index = 0; index < 1100; index++) node.addEventListener('keydown', listener);
  dispatchKey();
  check('registration delivery has no replacement fixed listener cap', calls === 1100);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
