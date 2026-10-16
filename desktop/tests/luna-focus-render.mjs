import { h, render } from './gui/sdk/js/reconciler.mjs';
import { button } from './desktop/shared/ui/button.mjs';
import { getDesktopTheme } from './desktop/shared/ui/themes.mjs';
import { lunaButtonDetail, lunaButtonPaint, lunaVisualEvents } from './desktop/shared/ui/luna-primitives.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const settle = () => { host.render(); host.render(); host.render(); };
const box = node => {
  const r = node.getBoundingClientRect();
  return [r.x, r.y, r.width, r.height];
};
function edges(control, color) {
  const ring = control.querySelector('.luna-focus-ring'), [x, y, width, height] = box(ring);
  const expected = (dx, dy) => ((dy === 0 || dy === height - 1) && dx % 2 === 0) ||
    ((dx === 0 || dx === width - 1) && dy % 2 === 0);
  const result = [
    Array.from({ length: width }, (_, i) => [i, 0]),
    Array.from({ length: width }, (_, i) => [i, height - 1]),
    Array.from({ length: height }, (_, i) => [0, i]),
    Array.from({ length: height }, (_, i) => [width - 1, i]),
  ].map(points => {
    let missing = 0, extra = 0, on = 0;
    for (const [dx, dy] of points) {
      const actual = host.pixel(x + dx, y + dy).toLowerCase() === color.toLowerCase();
      if (actual) on++;
      if (expected(dx, dy) && !actual) missing++;
      if (!expected(dx, dy) && actual) extra++;
    }
    return { length: points.length, on, missing, extra };
  });
  return { ring: [x, y, width, height], edges: result };
}
function panelControl(theme, variant) {
  return h('view', { id: 'luna-panel', tabIndex: 0, role: 'button',
    style: { width: 180, height: 30, position: 'relative', ...lunaButtonPaint(theme, { variant }) },
    ...lunaVisualEvents(theme, { variant }) }, lunaButtonDetail(theme, variant));
}

export function checkLunaFocus(directory, verify = true) {
  let theme = getDesktopTheme('xp'), disabled = false, selected = false, calls = 0, variant = 'tool';
  const scene = () => {
    const small = button('luna-small', '', theme, () => { if (!disabled) calls++; }, selected,
      { width: 120, height: 22 });
    small.props['aria-disabled'] = String(disabled);
    render(h('view', { style: { padding: 10, gap: 20, backgroundColor: theme.colors.body } }, small,
      button('luna-large', '', theme, () => {}, false, { width: 420, height: 80 }),
      panelControl(theme, variant)), document.body);
    settle();
  };
  scene();
  check(host.save(directory + '\\rest.png'), 'Save unchanged unfocused surface');
  const find = id => document.getElementById(id), results = [];
  const smallBox = find('luna-small').getBoundingClientRect();
  const center = [smallBox.x + smallBox.width / 2, smallBox.y + smallBox.height / 2];
  host.mouse('mousemove', ...center); settle();
  check(host.save(directory + '\\hover.png'), 'Save unchanged hover');
  host.mouse('mousedown', ...center); settle();
  find('luna-small').blur(); settle();
  lunaVisualEvents(theme).onMousedown({ currentTarget: find('luna-small'), button: 0 }); settle();
  check(host.save(directory + '\\held.png'), 'Save unchanged unfocused held');
  host.mouse('mousecancel', ...center); host.mouse('mousemove', 790, 590); settle();
  selected = true; scene();
  check(host.save(directory + '\\selected.png'), 'Save unchanged selected');
  disabled = true; scene();
  check(host.save(directory + '\\disabled.png'), 'Save unchanged disabled');
  selected = false; disabled = false; scene();
  for (const id of ['luna-small', 'luna-large']) {
    find(id).focus(); settle();
    const result = edges(find(id), theme.colors.focus);
    results.push({ id, ...result });
    check(host.save(directory + '\\focus-' + id + '.png'), 'Save measured actual focus edges');
    if (verify) {
      check(result.edges.every(edge => edge.missing === 0 && edge.extra === 0), id + ' exact full four-edge repeat');
      const canvas = find(id).querySelector('.luna-focus-paint');
      check(canvas && canvas.childNodes.length === 0 && canvas.style.pointerEvents === 'none',
        'One paint-only Canvas replaces fixed per-dot DOM');
    }
  }
  if (!verify) { console.log('LUNA_FOCUS_BEFORE ' + JSON.stringify(results)); return; }
  const retained = find('luna-small');
  retained.focus(); settle();
  theme = { ...theme, colors: { ...theme.colors, focus: '#a02080' }, panel: { ...theme.panel, text: '#f0d080' } };
  selected = true; scene();
  check(find('luna-small') === retained && retained.getAttribute('aria-pressed') === 'true' &&
    edges(retained, theme.colors.focus).edges.every(edge => !edge.missing && !edge.extra),
    'Immutable retheme preserves DOM/selected/focus and consumes current focus color');
  disabled = true; scene();
  check(Number(retained.querySelector('.luna-focus-ring').style.opacity) === 0 &&
    edges(retained, theme.colors.focus).edges.every(edge => edge.on === 0),
    'Disabled focused button hides the entire paint and stops owner observation');
  host.key('Enter', 'keydown', { text: false }); settle();
  check(calls === 0, 'Disabled keyboard does not activate');
  disabled = false; scene();
  check(edges(retained, theme.colors.focus).edges.every(edge => !edge.missing && !edge.extra), 'Enabled focus restores all edges');
  host.key('Enter', 'keydown', { text: false }); settle();
  const r = retained.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
  host.mouse('mousedown', x, y, { button: 2 }); host.mouse('mouseup', x, y, { button: 2 });
  host.mouse('click', x, y, { button: 2 }); settle();
  check(calls === 1, 'Enter once and non-primary pointer rejected');
  host.mouse('mousedown', x, y); host.mouse('mouseup', x, y); host.mouse('click', x, y); settle();
  check(calls === 2, 'Primary pointer callback once');
  for (variant of ['tool', 'task', 'launcher']) {
    scene(); find('luna-panel').focus(); settle();
    const result = edges(find('luna-panel'), theme.panel.text);
    check(result.edges.every(edge => !edge.missing && !edge.extra), variant + ' retains panel.text and full edges');
    results.push({ variant, ...result });
  }
  find('luna-panel').blur(); settle();
  check(Number(find('luna-panel').querySelector('.luna-focus-ring').style.opacity) === 0 &&
    edges(find('luna-panel'), theme.panel.text).edges.every(edge => edge.on === 0),
    'Blur clears panel focus opacity and actual edge pixels');
  render(null, document.body); settle();
  console.log('LUNA_FOCUS_EDGES ' + JSON.stringify(results));
  console.log('PASS: Luna full four-edge repeat, colors, retained retheme, disabled/blur and activation');
}

export async function checkNativeLunaFocus(directory) {
  let child = window.create({ title: 'Luna focus child', width: 240, height: 140 });
  let owner = child.document;
  const theme = getDesktopTheme('xp'), original = globalThis.document;
  const observe = child.observeState;
  let subscriptions = 0, business = 0;
  child.observeState = function(callback) {
    const remove = observe.call(this, callback);
    subscriptions++;
    let active = true;
    return () => { if (active) { active = false; subscriptions--; remove(); } };
  };
  const scene = (present, removePaint = false) => {
    const control = present ? button('luna-native', '', theme, () => {}, false, {
      position: 'absolute', left: 20, right: 20, top: 20, bottom: 20, height: 'auto',
    }) : null;
    if (removePaint) {
      const find = vnode => vnode.props?.className === 'luna-focus-ring' ? vnode :
        vnode.children?.map(find).find(Boolean);
      find(control).children = [];
    }
    globalThis.document = owner;
    try {
      render(control, owner.body);
    } finally { globalThis.document = original; }
  };
  scene(true); await delay(100);
  let node = owner.getElementById('luna-native');
  node.focus(); await delay(100);
  let canvas = node.querySelector('.luna-focus-paint');
  check(subscriptions === 1, 'One actual owner focus subscription');
  const before = { ring: box(canvas), backing: [canvas.width, canvas.height] };
  child.onstatechange = () => business++;
  const request = globalThis.requestAnimationFrame;
  let frames = 0;
  globalThis.requestAnimationFrame = callback => request(time => { frames++; callback(time); });
  ownerTest.resize('Luna focus child', 680, 330, ownerTest.nativeDpiMessage ? 96 : 0);
  await delay(140);
  globalThis.requestAnimationFrame = request;
  const after = { ring: box(canvas), backing: [canvas.width, canvas.height], scale: child.state.scale, frames, business };
  check(after.ring[2] > before.ring[2] && after.ring[3] > before.ring[3] &&
    after.backing[0] === Math.ceil(after.ring[2] * after.scale) &&
    after.backing[1] === Math.ceil(after.ring[3] * after.scale) && frames === 2 && business > 0,
    'Pure host resize, no render/VNode update, completes in two bounded frames with business handler');
  let ctx = canvas.getContext('2d'), pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const width = canvas.width, height = canvas.height;
  let missing = 0;
  for (const [length, point] of [[width, i => i], [width, i => (height - 1) * width + i],
    [height, i => i * width], [height, i => i * width + width - 1]]) {
    for (let i = 0; i < length; i += 2) if (pixels[point(i) * 4 + 3] !== 255) missing++;
  }
  check(missing === 0, 'Host-resized four-edge Canvas fully painted');
  ctx = null; pixels = null;
  child.capture(directory + '\\native-resized.png');
  node.blur(); await delay(50);
  check(subscriptions === 0 && Number(canvas.style.opacity) === 0, 'Blur unsubscribes');
  const cancel = globalThis.cancelAnimationFrame;
  let leaveCancellations = 0;
  globalThis.cancelAnimationFrame = frame => { leaveCancellations++; cancel(frame); };
  node.focus();
  scene(true, true); await delay(60);
  globalThis.cancelAnimationFrame = cancel;
  check(subscriptions === 0 && leaveCancellations === 1,
    'Canvas leave hook unsubscribes and cancels its pending bounded frame while retaining the control');
  scene(false); scene(true); await delay(60);
  node = owner.getElementById('luna-native'); node.focus(); await delay(60);
  const refs = { node: new WeakRef(node), document: new WeakRef(owner), window: new WeakRef(child) };
  canvas = null; node = null; owner = null; child.close(); child = null;
  for (let i = 0; i < 8; i++) { await delay(30); ownerTest.gc(); }
  const collected = Object.fromEntries(Object.entries(refs).map(([name, weak]) => [name, !weak.deref()]));
  check(Object.values(collected).every(Boolean), 'Focused closed Luna node/document/window collect');
  console.log('NATIVE_LUNA_FOCUS ' + JSON.stringify({
    before, after, missing, leaveCancellations, beforeCloseSubscriptions: subscriptions, collected,
  }));
  console.log('PASS: Luna owner resize, bounded frames, blur/leave unsubscribe and focused-window GC');
  window.quit();
}
