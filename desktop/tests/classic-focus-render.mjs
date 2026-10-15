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
