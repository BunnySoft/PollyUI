import { render } from './gui/sdk/js/reconciler.mjs';
import { getDesktopTheme, DESKTOP_THEMES } from './desktop/shared/ui/themes.mjs';
import { settingsView } from './desktop/apps/settings/ui/appearance.mjs';
import { systemSettingsView } from './desktop/apps/settings/ui/frame.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
const box = node => {
  const r = node.getBoundingClientRect();
  return [r.x, r.y, r.width, r.height];
};
const sample = node => {
  const [x, y, w, h] = box(node), pixels = [];
  for (let py = Math.floor(y); py < Math.ceil(y + h); py++)
    for (let px = Math.floor(x); px < Math.ceil(x + w); px++) pixels.push(host.pixel(px, py));
  return pixels;
};
const changes = (before, after) => {
  check(before.length === after.length, 'Focused consumer box does not move');
  return before.filter((pixel, index) => pixel !== after[index]).length;
};
const settle = async () => {
  await Promise.resolve();
  host.render(); host.render(); host.render();
};
function classicEdges(card, color) {
  const ring = card.querySelector('.theme-focus-ring');
  if (!ring) return null;
  const [x, y, width, height] = box(ring);
  const canvas = ring.querySelector('.classic-focus-paint'), bounds = box(canvas);
  return { box: [x, y, width, height], canvas: bounds, backing: [canvas.width, canvas.height],
    paintClip: [Math.max(0, x - bounds[0]), Math.max(0, y - bounds[1]),
      Math.min(bounds[2], x + width - bounds[0]), Math.min(bounds[3], y + height - bounds[1])], missing: [
    Array.from({ length: width }, (_, at) => [at, 0]),
    Array.from({ length: width }, (_, at) => [at, height - 1]),
    Array.from({ length: height }, (_, at) => [0, at]),
    Array.from({ length: height }, (_, at) => [width - 1, at]),
  ].map(points => points.filter(([dx, dy]) =>
    (((dy === 0 || dy === height - 1) && dx % 2 === 0) ||
      ((dx === 0 || dx === width - 1) && dy % 2 === 0)) &&
    host.pixel(x + dx, y + dy) !== color.toUpperCase()).length) };
}

export async function checkAppearanceFocus(directory, verify = true) {
  check(host.width === 800 && host.height === 600, 'Actual scale-1 fixed Settings viewport');
  const selections = [], navigation = [], defaults = {};
  let restoredClassic = null;
  const scene = async theme => {
    const content = settingsView(theme, id => selections.push(id), () => {}, () => {},
      '', false, null, null, null, null, null, null, true);
    render(systemSettingsView(theme, 'appearance', id => navigation.push(id), () => {},
      content, null, 'Settings', [], {
        version: 'appearance fixture', revision: '15364dd292559bd3eba5d695b517d2f58ab94e3e', sourceDirty: false,
      }), document.body);
    await settle();
  };
  for (const preset of DESKTOP_THEMES) {
    document.activeElement?.blur();
    await scene(getDesktopTheme(preset.id));
    defaults[preset.id] = DESKTOP_THEMES.map(item => box(document.getElementById('shell-theme-' + item.id)));
    check(host.save(directory + '/unfocused-' + preset.id + '.png'), 'Save unchanged default-skin guard');
  }
  const classic = getDesktopTheme('server2003');
  await scene(classic);
  const card = document.getElementById('shell-theme-server2003'), originalBox = box(card), before = sample(card);
  check(host.save(directory + '/classic-before-focus.png'), 'Save unfocused real Settings consumer');
  document.getElementById('shell-settings-page-about').focus();
  host.key('Tab', 'keydown', { text: false });
  check(document.activeElement === document.getElementById('shell-theme-xp'), 'Tab reaches the first card');
  host.key('Tab', 'keydown', { text: false }); await settle();
  check(document.activeElement === card, 'Tab reaches the selected Classic card');
  const focusedPixels = changes(before, sample(card)), edges = classicEdges(card, classic.colors.focus);
  if (verify) check(focusedPixels > 0 && edges?.missing.every(n => n === 0), 'Classic card has four complete focus edges');
  check(host.save(directory + '/classic-focused.png'), 'Save actual focused consumer');
  await scene(classic);
  check(document.getElementById(card.id) === card && document.activeElement === card,
    'Same-theme repaint retains card DOM and actual focus');
  check(JSON.stringify(box(card)) === JSON.stringify(originalBox), 'Focus/repaint leaves gallery geometry unchanged');
  card.blur(); await settle();
  const blurredPixels = changes(before, sample(card));
  check(blurredPixels === 0, 'Blur restores every original card pixel');
  check(host.save(directory + '/classic-after-blur.png'), 'Save byte-comparable blurred consumer');

  const xp = document.getElementById('shell-theme-xp');
  xp.focus(); host.key('Enter', 'keydown', { text: false }); await settle();
  check(selections.length === 1 && selections[0] === 'xp', 'Enter invokes one original view callback');
  host.key(' ', 'keydown', { code: 'Space', text: false }); await settle();
  check(selections.length === 2 && selections[1] === 'xp', 'Space invokes one original view callback');
  const [x, y] = box(xp);
  host.mouse('mousemove', x + 30, y + 30);
  host.mouse('mousedown', x + 30, y + 30);
  host.mouse('mouseup', x + 30, y + 30);
  host.mouse('click', x + 30, y + 30); await settle();
  check(selections.length === 3 && selections[2] === 'xp' && navigation.length === 0,
    'Pointer over original preview artwork passes through the focus layer and activates once');
  await scene(getDesktopTheme('xp'));
  const lunaRing = xp.querySelector('.luna-focus-ring');
  const retheme = { sameDOM: document.getElementById('shell-theme-xp') === xp,
    sameFocus: document.activeElement === xp, selected: xp.getAttribute('aria-pressed'),
    formerSelected: document.getElementById('shell-theme-server2003').getAttribute('aria-pressed') };
  check(retheme.sameDOM && retheme.sameFocus && retheme.selected === 'true' && retheme.formerSelected === 'false',
    'Retheme preserves DOM/focus and updates selected truth without a backend fixture');
  if (verify) {
    check(lunaRing && !xp.querySelector('.luna-hot-ring'), 'Luna uses its existing focus class without adding hot/gloss chrome');
    xp.blur(); await settle();
    const lunaBefore = sample(xp);
    xp.focus(); await settle();
    check(changes(lunaBefore, sample(xp)) > 0 && Number(lunaRing.style.opacity) === 1,
      'Luna focus/blur follows its real current visual-event contract');
    await scene(classic);
    const paint = xp.querySelector('.classic-focus-paint');
    const restored = { active: document.activeElement?.id, edges: classicEdges(xp, classic.colors.focus),
      canvasOpacity: paint.style.opacity, ringOpacity: paint.parentNode.style.opacity,
      backing: [paint.width, paint.height], canvasBox: box(paint),
      layout: [paint.offsetWidth, paint.offsetHeight], cssWidth: paint.style.width };
    restoredClassic = restored;
    check(document.activeElement === xp && restored.edges.missing.every(n => n === 0),
      'Retained focus restores Classic Canvas: ' + JSON.stringify(restored));
    check(paint.parentNode.className === 'theme-focus-ring' && paint.parentNode.parentNode.parentNode === xp &&
      paint.style.pointerEvents === 'none', 'Focus-only wrapper preserves Canvas ownership and pointer policy');
    await scene(getDesktopTheme('xp'));
    check(document.activeElement === xp && xp.querySelector('.luna-focus-ring'),
      'Repeated retained theme switch preserves the actual Luna focus contract');
    await scene(classic);
    check(document.activeElement === xp && classicEdges(xp, classic.colors.focus).missing.every(n => n === 0),
      'Repeated theme switch repaints every full Classic edge');
    xp.blur(); await settle();
    check(host.save(directory + '/classic-after-roundtrip-blur.png'), 'Save whole-frame roundtrip/blur byte guard');
  }
  console.log('APPEARANCE_FOCUS ' + JSON.stringify({ verify, defaults, originalBox, focusedPixels, edges,
    blurredPixels, retheme, restoredClassic, selections, navigation,
    callbackScope: 'Real view callback recorder, not Settings RPC/persistence' }));
}
