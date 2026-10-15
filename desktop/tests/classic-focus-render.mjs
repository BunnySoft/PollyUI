import { h, render } from './gui/sdk/js/reconciler.mjs';
import { button } from './desktop/shared/ui/button.mjs';
import { desktopCommand } from './desktop/shared/ui/presentation.mjs';
import { getDesktopTheme } from './desktop/shared/ui/themes.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
const box = node => {
  const r = node.getBoundingClientRect();
  return [r.x, r.y, r.width, r.height];
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const theme = getDesktopTheme('server2003');
const settle = () => { host.render(); host.render(); host.render(); };
function edges(node, color) {
  const ring = node.querySelector('.theme-focus-ring'), [x, y, width, height] = box(ring);
  return { control: box(node), ring: [x, y, width, height], missing: [
    Array.from({ length: width }, (_, at) => [at, 0]),
    Array.from({ length: width }, (_, at) => [at, height - 1]),
    Array.from({ length: height }, (_, at) => [0, at]),
    Array.from({ length: height }, (_, at) => [width - 1, at]),
  ].map(points => points.filter(([dx, dy]) =>
    (((dy === 0 || dy === height - 1) && dx % 2 === 0) ||
      ((dx === 0 || dx === width - 1) && dy % 2 === 0)) &&
    host.pixel(x + dx, y + dy) !== color.toUpperCase()).length) };
}
export function checkClassicFocus(directory) {
  check(host.width === 800 && host.height === 600, 'Unscaled 800x600 actual GUI fixture');
  let calls = 0;
  const scene = ({ width = 420, height = 80, enabled = true, selected = false, current = theme } = {}) => {
    const large = button('focus-large', 'Large shared button', current, () => { if (enabled) calls++; }, selected,
      { width, height, opacity: enabled ? 1 : 0.37 });
    large.props['aria-disabled'] = String(!enabled);
    render(h('view', { style: { width: '100%', height: '100%', position: 'relative', backgroundColor: current.colors.body } },
      h('view', { style: { position: 'absolute', left: 20, top: 20, width: 120, height: 22 } },
        button('focus-small', 'Small', current, () => calls++, false, { width: 120, height: 22 })),
      h('view', { style: { position: 'absolute', left: 20, top: 80, width, height } }, large),
      h('view', { style: { position: 'absolute', left: 20, top: 220, width: 500, height: 96 } },
        desktopCommand('focus-command', 'Large shared command', current, () => calls++,
          { style: { width: 500, height: 96 } }))), document.body);
    settle();
  };
  scene();
  const find = id => document.getElementById(id), results = {};
  for (const id of ['focus-small', 'focus-large', 'focus-command']) {
    find(id).focus(); settle();
    results[id] = edges(find(id), theme.colors.focus);
    check(results[id].missing.every(n => n === 0), id + ' complete four full-length edges');
    check(host.save(directory + '/' + id + '.png'), 'Save actual focus evidence');
    check(find(id).querySelector('.classic-focus-paint').childNodes.length === 0, 'No per-dot DOM growth');
  }
  const retained = find('focus-large');
  retained.focus(); settle();
  scene({ width: 540, height: 110 });
  check(find('focus-large') === retained && document.activeElement === retained, 'Same node/focus after resize');
  results.resized = edges(retained, theme.colors.focus);
  check(results.resized.missing.every(n => n === 0), 'Focused resize redraws the far edges');
  scene({ width: 540, height: 110, enabled: false, selected: true });
  const ring = retained.querySelector('.theme-focus-ring');
  check(document.activeElement === retained && retained.getAttribute('aria-pressed') === 'true' &&
    Number(ring.style.opacity) === 0 && Number(retained.style.opacity) === 0.37,
    'Disabled preserves actual focus, selection truth and caller opacity but removes focus pixels');
  scene({ width: 540, height: 110, selected: true });
  check(edges(retained, theme.colors.focus).missing.every(n => n === 0), 'Re-enabled retained focus restores the ring');
  const tinted = { ...theme, colors: { ...theme.colors, focus: '#8040a0' } };
  scene({ width: 540, height: 110, selected: true, current: tinted });
  results.rethemed = edges(retained, tinted.colors.focus);
  check(results.rethemed.missing.every(n => n === 0), 'Retheme redraws the complete repeat');
  const paint = retained.querySelector('.classic-focus-paint');
  check(paint.getAttribute('aria-hidden') === 'true' && paint.style.pointerEvents === 'none',
    'Paint-only Canvas is not interactive or exposed to accessibility');
  const [x, y, w, height] = box(retained);
  host.mouse('mousedown', x + w / 2, y + height / 2);
  host.mouse('mouseup', x + w / 2, y + height / 2);
  host.mouse('click', x + w / 2, y + height / 2); settle();
  check(calls === 1 && document.activeElement === retained, 'One activation with original focus');
  retained.blur(); settle();
  check(Number(ring.style.opacity) === 0, 'Blur hides the ring');
  console.log('CLASSIC_FOCUS_EDGES ' + JSON.stringify(results));
  console.log('PASS: actual Classic size/state/palette lifecycle and one click');
}

export async function checkNativeClassicFocus(directory) {
  const child = window.create({ title: 'Focus.child', width: 460, height: 220 });
  const owner = child.document, original = globalThis.document;
  let business = 0, replacement = 0;
  child.onstatechange = () => business++;
  globalThis.document = owner;
  try {
    render(h('view', { style: { position: 'relative', width: '100%', height: '100%' } },
      button('native-focus', 'Native host-only resize', theme, () => {}, false, {
        position: 'absolute', left: 20, right: 20, top: 20, bottom: 20, height: 'auto',
      })), owner.body);
  } finally { globalThis.document = original; }
  const control = owner.getElementById('native-focus'), ring = control.querySelector('.classic-focus-paint');
  await delay(100);
  ownerTest.resize('Focus.child', 460, 220, ownerTest.nativeDpiMessage ? 96 : 0);
  await delay(100);
  control.focus();
  await delay(100);
  const before = { control: box(control), ring: box(ring), state: child.state,
    backing: [ring.width, ring.height], business };
  child.capture(directory + '/native-before.png');
  child.onstatechange = () => replacement++;
  const frames = [], requestFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = callback => requestFrame(time => {
    const entry = { time, layout: [ring.offsetWidth, ring.offsetHeight], before: [ring.width, ring.height] };
    frames.push(entry);
    callback(time);
    entry.after = [ring.width, ring.height];
  });
  ownerTest.resize('Focus.child', 680, 330, ownerTest.nativeDpiMessage ? 96 : 0);
  // No render(), host.render(), or VNode update follows the native resize.
  await delay(120);
  globalThis.requestAnimationFrame = requestFrame;
  const after = { control: box(control), ring: box(ring), state: child.state,
    backing: [ring.width, ring.height], business, replacement };
  check(after.ring[2] > before.ring[2] && after.ring[3] > before.ring[3] &&
    after.backing[0] === Math.ceil(after.ring[2] * after.state.scale) &&
    after.backing[1] === Math.ceil(after.ring[3] * after.state.scale),
    'Real host-only child resize completes backing resize without VNode or forced rendering');
  check(frames.length === 2 && frames[1].after[0] === after.backing[0] &&
    frames[1].after[1] === after.backing[1], 'Exactly two bounded native rAF callbacks complete post-layout backing');
  check(replacement > 0 && owner.activeElement === control, 'Business reassignment and actual focus coexist');
  child.capture(directory + '/native-after.png');
  if (ownerTest.nativeDpiMessage) {
    ownerTest.resize('Focus.child', 540, 280, 120);
    await delay(120);
    check(child.state.scale === 1.25 && ring.width === Math.ceil(ring.offsetWidth * 1.25),
      'Host-adapter WM_DPICHANGED 1.25 boundary refreshes backing (not a monitor setting change)');
    child.capture(directory + '/native-scale125.png');
  }
  control.blur(); await delay(50);
  check(Number(ring.style.opacity) === 0, 'Native blur clears focus');
  console.log('NATIVE_CLASSIC_FOCUS ' + JSON.stringify({ before, after, frames }));
  console.log('PASS: actual native owner/host resize/scale and business-handler coexistence');
  child.close(); window.quit();
}

export async function checkNativeClassicFocusCollection() {
  const collect = async () => {
    for (let i = 0; i < 8; i++) { await delay(30); ownerTest.gc(); }
  };
  const alive = refs => Object.fromEntries(Object.entries(refs).map(([name, weak]) => [name, Boolean(weak.deref())]));
  const closed = async focused => {
    let child = window.create({ title: 'Classic collection ' + focused, width: 240, height: 140 });
    let owner = child.document;
    const original = globalThis.document;
    globalThis.document = owner;
    try {
      render(h('view', { style: { width: '100%', height: '100%' } },
        button('collect-control', 'Collect', theme, () => {}, false, { width: 120, height: 22 })), owner.body);
    } finally { globalThis.document = original; }
    await delay(90);
    let node = owner.getElementById('collect-control');
    if (focused) node.focus();
    await delay(90);
    const refs = { node: new WeakRef(node), document: new WeakRef(owner), window: new WeakRef(child) };
    node = null; owner = null; child.close(); child = null;
    return refs;
  };
  const plain = await closed(false), focused = await closed(true);
  await collect();
  const result = { unfocused: alive(plain), focused: alive(focused) };
  console.log('CLASSIC_CLOSED_WINDOW_GC ' + JSON.stringify(result));
  check(Object.values(result.unfocused).every(value => !value), 'Unfocused closed child baseline collects');
  check(Object.values(result.focused).every(value => !value), 'Focused closed child node/Document/window collect');

  const child = window.create({ title: 'Classic detached Canvas', width: 240, height: 140 });
  const owner = child.document, observe = child.observeState;
  let subscriptions = 0;
  child.observeState = function(callback) {
    const remove = observe.call(this, callback);
    let active = true;
    subscriptions++;
    return () => { if (active) { active = false; subscriptions--; remove(); } };
  };
  const draw = replace => {
    const control = button('live-focus', 'Live owner', theme, () => {}, false, { width: 120, height: 22 });
    if (replace) {
      const find = vnode => vnode.props?.className === 'classic-focus-paint' ? vnode :
        vnode.children?.map(find).find(Boolean);
      const paint = find(control);
      // Type replacement drops this Canvas without its normal onLeave hook.
      paint.type = 'view';
      paint.props = { className: 'focus-replacement', style: paint.props.style };
    }
    const original = globalThis.document;
    globalThis.document = owner;
    try { render(control, owner.body); } finally { globalThis.document = original; }
  };
  draw(false); await delay(90);
  owner.getElementById('live-focus').focus(); await delay(90);
  check(subscriptions === 1, 'Focused live owner has one state subscription');
  const detached = new WeakRef(owner.getElementById('live-focus').querySelector('.classic-focus-paint'));
  draw(true);
  check(subscriptions === 1 && owner.activeElement === owner.getElementById('live-focus'),
    'Type replacement exercises finalizer cleanup without blurring the live control');
  await collect();
  const detachedResult = { canvasAlive: Boolean(detached.deref()), subscriptions, ownerClosed: child.closed };
  console.log('CLASSIC_DETACHED_CANVAS_GC ' + JSON.stringify(detachedResult));
  check(!detachedResult.canvasAlive && subscriptions === 0 && !child.closed,
    'Detached Canvas collects and unsubscribes while the native owner remains live');
  child.close();
  console.log('PASS: real focused/unfocused child collection and live-owner detached Canvas cleanup');
  window.quit();
}
