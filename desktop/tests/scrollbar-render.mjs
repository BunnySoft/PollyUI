import { createVerticalScrollbar } from './gui/sdk/js/scrollbar.mjs';
import { scrollbarScene } from './gui/tests/scrollbar-appearance.mjs';
import { scrollbarAppearance } from './desktop/shared/ui/scrollbar-appearance.mjs';
import { getDesktopTheme } from './desktop/shared/ui/themes.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
const box = node => node.getBoundingClientRect();
const draw = controller => { host.render(); controller.update(); host.render(); host.render(); };
const mouse = (type, x, y, options = {}) => host.mouse(type, x, y, options);
function click(x, y) { mouse('mousedown', x, y); mouse('mouseup', x, y); }
function pixels(node) {
  const b = box(node), result = [];
  for (let y = b.y; y < b.bottom; y++)
    for (let x = b.x; x < b.right; x++) result.push(host.pixel(x, y));
  return result;
}
function focusEdges(track, color) {
  const ring = track.querySelector('.theme-focus-ring') || track.querySelector('.luna-focus-ring');
  const r = box(ring), inset = 2;
  const points = [[r.x + inset, r.y], [r.x, r.y + inset],
    [r.x + inset, r.bottom - 1], [r.right - 1, r.y + inset]];
  return points.map(([x, y]) => host.pixel(x, y).toLowerCase() === color.toLowerCase());
}

export function checkThemedScrollbars(directory) {
  const samples = [];
  for (const id of ['server2003', 'xp', 'modern', 'aqua']) {
    const theme = getDesktopTheme(id), skin = scrollbarAppearance(theme), scene = scrollbarScene();
    const { viewport, track, thumb } = scene;
    let current = true, paints = 0, decorations = 0;
    const appearance = { ...skin, paint: (...args) => { paints++; return skin.paint(...args); },
      decorate: parts => { decorations++; return skin.decorate(parts); } };
    host.render();
    const controller = createVerticalScrollbar({ ...scene, isCurrent: () => current, appearance });
    draw(controller);
    const initial = controller.update(), b = box(track), x = b.x + b.width / 2;
    check(b.width === skin.metrics.width && initial.top === skin.metrics.arrowSize &&
      Number(thumb.style.height) === 28, 'Themed width and arrow lanes share the generic measured geometry');
    const beforeCount = paints;
    for (let i = 0; i < 20; i++) controller.update();
    controller.setAppearance(appearance);
    check(paints === beforeCount && decorations === 1, 'Unchanged caller update/setAppearance does not paint or recreate decoration');
    check(!track.querySelector('.bevel-top'), 'Scrollbar bevel edges have their own semantic classes');
    check(host.save(directory + '\\' + id + '-normal.png'), 'Save actual themed resting scrollbar');
    const before = pixels(track);
    track.focus(); draw(controller);
    const after = pixels(track);
    check(before.some((pixel, index) => pixel !== after[index]), 'Keyboard focus is visible without moving scrollbar geometry');
    if (['server2003', 'xp'].includes(id))
      check(focusEdges(track, theme.colors.focus).every(Boolean), 'Reused Classic/Luna focus painter retains all four edges');
    check(host.save(directory + '\\' + id + '-focus.png'), 'Save actual themed focus');
    mouse('mousemove', x, b.y + initial.top + 5); draw(controller);
    check(host.save(directory + '\\' + id + '-hover.png'), 'Save actual themed thumb hover');
    viewport.scrollTop = 1000; draw(controller);
    const mid = controller.update(), midY = b.y + mid.top + 5;
    mouse('mousedown', x, midY); mouse('mousemove', x, midY, { buttons: 1 }); mouse('mouseup', x, midY);
    check(viewport.scrollTop === 1000, 'Native same-coordinate down/move/up does not scroll an arrow lane');
    mouse('mousedown', x, midY); mouse('mousemove', x, midY + 14, { buttons: 1 });
    const expectedMid = 1000 + 14 / mid.travel * mid.maximum, movedMid = Number(viewport.scrollTop);
    // The existing native scroll property stores doubles with C's six-digit %g.
    check(movedMid === Number(expectedMid.toPrecision(6)),
      'Native midrange pointer delta follows the one measured travel mapping: ' + JSON.stringify({ id, mid, midY, expectedMid, movedMid }));
    mouse('mouseup', x, midY + 14);
    check(viewport.scrollTop === movedMid, 'Same-coordinate native release preserves the exact stored scroll value');
    host.key('Home', 'keydown', { text: false }); draw(controller);
    if (skin.metrics.arrowSize) {
      click(x, b.bottom - skin.metrics.arrowSize / 2); draw(controller);
      check(viewport.scrollTop === 42 && !track.hasMouseCapture(), 'End arrow takes exactly the existing generic 42px step without a second capture owner');
      host.key('Home', 'keydown', { text: false }); draw(controller);
    }
    click(x, b.y + skin.metrics.arrowSize + initial.thumbHeight + 30); draw(controller);
    check(viewport.scrollTop === 200, 'Theme decoration does not turn the page region into an arrow or thumb');
    viewport.scrollTop = 1000; draw(controller);
    const heldY = b.y + controller.update().top + 5;
    mouse('mousedown', x, heldY);
    check(track.hasMouseCapture(), 'The original track owns themed thumb capture');
    draw(controller);
    check(host.save(directory + '\\' + id + '-held.png'), 'Save actual themed held thumb');
    const originalTrack = track, originalThumb = thumb;
    controller.setAppearance(scrollbarAppearance(getDesktopTheme(id === 'modern' ? 'server2003' : 'modern')));
    draw(controller);
    check(track === originalTrack && thumb === originalThumb && document.activeElement === track && track.hasMouseCapture(),
      'Retheme retains the same track/thumb DOM, keyboard focus and sole capture owner');
    mouse('mousemove', x, heldY, { buttons: 1 });
    check(viewport.scrollTop === 1000, 'Changing arrow inset during native capture does not jump at the same pointer coordinate');
    mouse('mousemove', x + 200, b.bottom + 200, { buttons: 1 });
    mouse('mouseup', x + 200, b.bottom + 200); draw(controller);
    check(viewport.scrollTop === 4000 && !track.hasMouseCapture(), 'Rethemed outside drag clamps to the actual bottom and releases');
    controller.setAppearance(appearance); draw(controller);
    host.key('Home', 'keydown', { text: false }); draw(controller);
    mouse('mousedown', x, b.y + controller.update().top + 5);
    current = false; controller.update();
    mouse('mousemove', x, b.bottom + 200, { buttons: 1 }); mouse('mouseup', x, b.bottom + 200);
    check(viewport.scrollTop === 0 && !track.hasMouseCapture() && track.tabIndex === -1,
      'Retired state cancels themed capture and rejects late motion');
    current = true; draw(controller);
    while (viewport.childNodes.length > 1) viewport.removeChild(viewport.lastChild);
    draw(controller);
    check(track.style.opacity === '0' && track.getAttribute('aria-disabled') === 'true' && viewport.scrollTop === 0,
      'Short content hides the themed rail and resets the actual scroll offset');
    check(host.save(directory + '\\' + id + '-short.png'), 'Save actual short-list hidden rail');
    for (let i = 0; i < 99; i++) {
      const row = document.createElement('view');
      Object.assign(row.style, { height: 42, flexShrink: 0 }); viewport.appendChild(row);
    }
    viewport.style.height = '16'; track.style.height = '16'; draw(controller);
    check(track.getAttribute('aria-disabled') === 'false', 'Tiny themed track still reports actual overflow, not a false fitted list');
    const tiny = box(track);
    if (skin.metrics.arrowSize) {
      check(thumb.style.display === 'none', 'An arrow-only tiny rail does not paint a zero-height thumb decoration outside its lane');
      click(tiny.x + tiny.width / 2, tiny.bottom - 2); draw(controller);
      check(viewport.scrollTop === 42, 'Tiny arrows still use the common bounded step');
    } else {
      track.focus(); host.key('ArrowDown', 'keydown', { text: false }); draw(controller);
      check(viewport.scrollTop === 42, 'A tiny flat scrollbar keeps the common keyboard step');
    }
    viewport.style.height = '200'; track.style.height = '200'; draw(controller);
    check(controller.update().thumbHeight === 28, 'Growing the viewport restores the measured thumb');
    controller.setAppearance(undefined); draw(controller);
    check(track.style.width === '10' && thumb.style.width === '6' && track.childNodes.length === 1,
      'Instance opt-out restores caller-owned styles and removes only owned decorations/arrows');
    controller.stop(); scene.root.parentNode.removeChild(scene.root);
    samples.push({ id, width: b.width, arrowSize: skin.metrics.arrowSize, initial, paints, decorations });
  }
  console.log('THEMED_SCROLLBAR_PASS ' + JSON.stringify({ samples, scale: 1,
    scope: 'One generic controller and desktop adapter on actual GUI DOM/input; not original-OS pixels or physical/compositor input' }));
}
