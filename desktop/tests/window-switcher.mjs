import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
register('./root-loader.mjs', import.meta.url);
const { windowSwitcherGrid, windowSwitcherStyle, windowSwitcherSize, windowSwitcherMotion,
  windowProjectionSize, windowProjectionViewport } = await import('./desktop/shared/ui/window-switcher.mjs');
const { BUILTIN_THEME_CATALOG } = await import('./desktop/shell/themes.mjs');
const { thumbnailSwitcherView, projectedSwitcherView } = await import('./desktop/shell/views.mjs');
const { memoryConfiguration } = await import('./desktop/tests/configuration-memory.mjs');
const theme = BUILTIN_THEME_CATALOG.themes.find(theme => theme.id === 'modern');
const selection = selected => ({ active: true, serial: 7, selected,
  items: Array.from({ length: 20 }, (_, index) => ({ title: 'Window ' + index, appId: 'fixture.' + index })) });
const nodes = node => [node, ...(node.children || []).flatMap(nodes)];

test('thumbnail grids page the exact selected candidates and keep bounded image slots inside the selector', () => {
  for (const [width, height] of [[880, 560], [768, 540], [320, 260], [4096, 768]]) {
    for (const selected of [0, 5, 6, 19]) {
      const grid = windowSwitcherGrid(theme, selection(selected), width, height);
      assert.ok(grid);
      assert.ok(grid.slots.length >= 1 && grid.slots.length <= 9);
      assert.ok(grid.slots.some(slot => slot.index === selected));
      for (const slot of grid.slots) {
        assert.equal(slot.item.title, 'Window ' + slot.index);
        assert.ok(slot.x >= 0 && slot.y >= 0);
        assert.ok(slot.x + slot.width <= width && slot.y + slot.height <= height);
        assert.ok(slot.imageWidth >= 1 && slot.imageWidth <= 256);
        assert.ok(slot.imageHeight >= 1 && slot.imageHeight <= 160);
        assert.ok(slot.imageWidth * 4 <= 1024 && slot.imageHeight * 4 <= 640);
      }
    }
  }
  assert.equal(windowSwitcherGrid(theme, selection(0), 100, 100), null);
  for (const snapshot of [{ ...selection(0), selected: -1 }, { ...selection(0), items: [] },
    { ...selection(0), selected: 20 }])
    assert.throws(() => windowSwitcherGrid(theme, snapshot, 880, 560));
});
test('small candidate sets use a compact selector while large sets remain bounded and paged', () => {
  const few = { ...selection(0), items: selection(0).items.slice(0, 3) };
  const one = windowSwitcherSize(theme, few, 1280, 720);
  const many = windowSwitcherSize(theme, selection(0), 1280, 720);
  assert.ok(one.height < many.height);
  assert.equal(windowSwitcherGrid(theme, few, one.width, one.height).capacity, 3);
  assert.ok(many.height <= 720 - theme.layout.switcherInset * 2);
  assert.ok(many.height <= 768 && many.width <= 4096);
});

test('native image holes clear only after acknowledgement; labels and borders retain their own opaque paint', () => {
  const snapshot = { ...selection(1), previewMask: 1 };
  const grid = windowSwitcherGrid(theme, snapshot, 880, 560);
  const pending = thumbnailSwitcherView(theme, snapshot, grid, () => {}, false);
  assert.notEqual(pending.props.style.backgroundColor, 'transparent');
  const current = thumbnailSwitcherView(theme, snapshot, grid, () => {}, true);
  assert.equal(current.props.style.backgroundColor, 'transparent');
  const all = nodes(current);
  assert.equal(all.find(node => node.props.id === 'shell-switcher-preview-0').props.style.backgroundColor, 'transparent');
  assert.equal(all.find(node => node.props.id === 'shell-switcher-preview-1').props.style.backgroundColor, theme.colors.surface);
  const cards = all.filter(node => node.props.id?.startsWith('shell-switcher-item-'));
  assert.ok(cards.every(node => node.props.style.borderWidth === 2 && node.props.style.opacity === undefined));
  assert.equal(cards.find(node => node.props.id === 'shell-switcher-item-1').props['aria-pressed'], 'true');
});

test('strict optional switcher preference does not alter the default or unrelated persisted appearance', () => {
  const configuration = memoryConfiguration();
  assert.equal(configuration.snapshot.theme.switcherStyle, undefined);
  configuration.update({ theme: { ...configuration.snapshot.theme, switcherStyle: 'thumbnails' } });
  assert.equal(configuration.snapshot.theme.switcherStyle, 'thumbnails');
  configuration.update({ theme: { ...configuration.snapshot.theme, id: 'bigsur', windowOpacityPercent: 75 } });
  assert.equal(configuration.snapshot.theme.switcherStyle, 'thumbnails');
  const previous = configuration.snapshot;
  for (const value of [null, true, '', 'perspective', 'cube', 'THUMBNAILS']) {
    assert.throws(() => windowSwitcherStyle(value));
    assert.throws(() => configuration.update({ theme: { ...previous.theme, switcherStyle: value } }));
    assert.equal(configuration.snapshot, previous);
  }
  configuration.close();
});

test('3D preferences preserve defaults and strict motion, and the viewport stays bounded inside actual outputs', () => {
  const configuration = memoryConfiguration();
  assert.equal(configuration.snapshot.theme.switcherMotion, undefined);
  configuration.update({ theme: { ...configuration.snapshot.theme, switcherStyle: 'flip3d', switcherMotion: false } });
  assert.equal(configuration.snapshot.theme.switcherStyle, 'flip3d');
  assert.equal(configuration.snapshot.theme.switcherMotion, false);
  for (const value of [null, 0, 1, 'true'])
    assert.throws(() => windowSwitcherMotion(value));
  assert.throws(() => configuration.update({ theme: { ...configuration.snapshot.theme, switcherMotion: 1 } }));
  for (const [width, height] of [[1280, 720], [3840, 2160], [640, 480]]) {
    const size = windowProjectionSize(theme, width, height);
    assert.ok(size.width <= 1000 && size.height <= 640);
    const viewport = windowProjectionViewport(theme, size.width, size.height);
    assert.ok(viewport && viewport.x + viewport.width <= size.width && viewport.y + viewport.height <= size.height);
  }
  assert.equal(windowProjectionViewport(theme, 100, 100), null);
  configuration.close();
});

test('3D viewport holes require their own native projection acknowledgement and picking uses actual logical coordinates', () => {
  const snapshot = { ...selection(1), previewMask: 1 };
  const viewport = windowProjectionViewport(theme, 900, 600), picks = [];
  const find = view => nodes(view).find(node => node.props.id === 'shell-switcher-3d-viewport');
  assert.notEqual(find(projectedSwitcherView(theme, snapshot, viewport, () => {}, false)).props.style.backgroundColor,
    'transparent');
  const node = find(projectedSwitcherView(theme, snapshot, viewport, (...args) => picks.push(args), true));
  assert.equal(node.props.style.backgroundColor, 'transparent');
  node.props.onClick({ button: 0, clientX: 80, clientY: 90, preventDefault() {},
    currentTarget: { getBoundingClientRect: () => ({ x: 16, y: 48 }) } });
  assert.deepEqual(picks, [[snapshot.serial, 64, 42]]);
  const unavailable = find(projectedSwitcherView(theme, { ...snapshot, previewMask: 0 }, viewport,
    () => assert.fail('Unavailable imagery cannot be picked'), true));
  assert.notEqual(unavailable.props.style.backgroundColor, 'transparent');
  unavailable.props.onClick({ button: 0 });
  const target = {};
  node.props.onMousedown({ currentTarget: target });
  const changed = find(projectedSwitcherView(theme, { ...snapshot, selected: 2 }, viewport,
    () => assert.fail('A held gesture must not activate a different selection'), true));
  changed.props.onUpdate(target);
  changed.props.onClick({ currentTarget: target, button: 0 });
});
