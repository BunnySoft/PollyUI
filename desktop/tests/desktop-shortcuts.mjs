import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
register('./root-loader.mjs', import.meta.url);
const { outputIdentity, outputKey, desktopOutputIdentity, desktopArea, layoutDesktop, gridPoint, moveDesktopGroup,
  rangeSelection, marqueeSelection, validateDesktopShortcuts } = await import('../shell/desktop-shortcuts.mjs');
const { createDesktopInteraction } = await import('../shell/desktop-interactions.mjs');
const { createShellConfiguration, defaultShellConfiguration } = await import('../shell/configuration.mjs');
const { encodeUtf8, decodeUtf8 } = await import('../../sysrt/sdk/js/encoding.mjs');
const output = outputIdentity({ name: 'DP-1', make: 'Fixture', model: 'Display', serialNumber: 'A' });
const area = desktopArea(512, 512, 0, 30);
const items = ['a.desktop', 'bundle:org.fixture.b', 'c.desktop', 'd.desktop'].map((id, i) =>
  ({ id, name: id, output, ...gridPoint(area, i, 0) }));
const ids = set => [...set].sort();

test('profile bounds, duplicate identity rejection, stable logical grid and collision-free constrained output reflow', () => {
  assert.equal(outputKey(output), outputKey({ ...output }));
  const head = { ...output, id: 1, description: 'Fixture monitor', enabled: true, x: 0, y: 0 };
  assert.deepEqual(desktopOutputIdentity({ id: 99, name: 'Fixture monitor', x: 0, y: 0 }, [head]), output);
  assert.equal(desktopOutputIdentity({ id: 1, name: 'unrelated', x: 0, y: 0 }, [head]), null);
  assert.equal(desktopOutputIdentity({ name: 'Fixture monitor', x: 0, y: 0 }, [head, { ...head, name: 'DP-2' }]), null);
  assert.deepEqual(validateDesktopShortcuts({ version: 1, shortcuts: items }).shortcuts, items);
  for (const bad of [{ version: 2, shortcuts: [] }, { version: 1, shortcuts: [...items, items[0]] },
    { version: 1, shortcuts: [{ ...items[0], x: -1 }] },
    { version: 1, shortcuts: [{ ...items[0], output: { ...output, name: '' } }] }])
    assert.throws(() => validateDesktopShortcuts(bad));
  const small = desktopArea(230, 360, 26, 64);
  const laid = layoutDesktop(items.map(item => ({ ...item, x: 30000, y: 30000 })), small);
  assert.equal(laid.length, 4);
  assert.equal(new Set(laid.map(item => item.x + ':' + item.y)).size, 4);
  assert.ok(laid.every(item => item.x >= 16 && item.x + 96 <= 214 && item.y >= 42 && item.y + 104 <= 280));
  assert.deepEqual(layoutDesktop(items, area).map(item => item.id), items.map(item => item.id));
  assert.deepEqual(layoutDesktop(items, desktopArea(50, 50)), []);
});
test('ordered bidirectional ranges, rectangle intersection, additive and toggle marquee', () => {
  assert.deepEqual(rangeSelection(items, items[3].id, items[1].id), items.slice(1).map(item => item.id));
  const rectangle = { x: 100, y: 10, width: 120, height: 40 };
  assert.deepEqual(ids(marqueeSelection(items, rectangle)), ids(new Set(items.slice(0, 3).map(item => item.id))));
  assert.deepEqual(ids(marqueeSelection(items, rectangle, new Set([items[0].id]), 'toggle')),
    ids(new Set(items.slice(1, 3).map(item => item.id))));
  assert.equal(marqueeSelection(items, rectangle, new Set([items[3].id]), 'add').size, 4);
});
test('group translation preserves relative offsets and avoids occupied cells and work-area edges', () => {
  const selected = new Set(items.slice(0, 2).map(item => item.id));
  const moved = moveDesktopGroup(items, selected, 0, 104, area);
  assert.equal(moved[1].x - moved[0].x, 96);
  assert.equal(moved[1].y - moved[0].y, 0);
  assert.equal(moved[0].y - items[0].y, 104);
  assert.equal(new Set(moved.map(item => item.x + ':' + item.y)).size, 4);
  assert.deepEqual(moveDesktopGroup(items, selected, 96, 0, area), items);
  const end = gridPoint(area, area.columns - 1, area.rows - 1);
  assert.ok(moveDesktopGroup(items, selected, 1e9, 1e9, area).every(item => item.x <= end.x && item.y <= end.y));
});
function fixture(save = () => {}) {
  const launches = [], errors = [];
  const controller = createDesktopInteraction({ save, launch: id => launches.push(id), failure: error => errors.push(error) });
  controller.update(items, area);
  const click = (id, modifiers = {}) => { controller.down(id, 0, 0, modifiers); controller.up(0, 0); };
  return { controller, click, launches, errors };
}
test('selection, Ctrl toggle, Shift range, empty clear, Ctrl+A, arrows and focused-only Enter', () => {
  const { controller: c, click, launches } = fixture();
  click(items[0].id); click(items[2].id, { ctrlKey: true });
  assert.deepEqual(ids(c.state.selected), [items[0].id, items[2].id]);
  click(items[0].id, { ctrlKey: true });
  assert.deepEqual(ids(c.state.selected), [items[2].id]);
  click(items[3].id, { shiftKey: true });
  assert.equal(c.state.selected.size, 4);
  c.key({ key: 'a', ctrlKey: true }); c.key({ key: 'Enter' });
  assert.deepEqual(launches, [items[3].id]);
  c.key({ key: 'ArrowLeft' }); assert.equal(c.state.focused, items[2].id);
  click(null); assert.equal(c.state.selected.size, 0);
  click(items[1].id); c.key({ key: 'Escape' }); assert.equal(c.state.selected.size, 0);
});
test('4 logical pixel slop, double-click without single-click launch, drag suppression, cancel restoration and persistent failure', () => {
  let saves = 0, fault = null;
  const { controller: c, click, launches, errors } = fixture(() => { saves++; if (fault) throw fault; });
  click(items[0].id);
  c.down(items[0].id, 0, 0); c.move(3.9, 3.9); c.up(3.9, 3.9);
  assert.equal(saves, 0);
  c.doubleClick(items[0].id, {}); assert.deepEqual(launches, [items[0].id]);
  c.down(items[0].id, 0, 0); c.move(0, 104); c.doubleClick(items[0].id, {});
  assert.equal(launches.length, 1);
  c.key({ key: 'Escape' }); assert.equal(c.state.items[0].y, 16);
  c.up(0, 104); assert.equal(saves, 0);
  fault = new Error('disk full');
  c.down(items[0].id, 0, 0); c.move(0, 104); c.up(0, 104);
  assert.equal(c.state.items[0].y, 16); assert.equal(errors.length, 1);
  fault = Object.assign(new Error('directory durability'), { committed: true });
  c.down(items[0].id, 0, 0); c.move(0, 104); c.up(0, 104);
  assert.equal(c.state.items[0].y, 120);
});
test('reverse-direction marquee, repaint retention, output geometry change cancels and independent controllers', () => {
  const { controller: c, click } = fixture(), { controller: other } = fixture();
  click(items[3].id);
  c.down(null, 220, 100, { ctrlKey: true }); c.move(100, 10);
  assert.equal(c.state.selected.size, 4);
  assert.equal(other.state.selected.size, 0);
  c.update(items, area); assert.equal(c.state.held, true);
  c.update(layoutDesktop(items, desktopArea(230, 360)), desktopArea(230, 360));
  assert.equal(c.state.held, false); assert.equal(c.state.rectangle, null);
  assert.deepEqual(ids(c.state.selected), [items[3].id]);
});
test('v1 JSON atomically upgrades once preserving all original domains; failed migration never falls back', () => {
  const { desktop, ...defaults } = defaultShellConfiguration();
  const legacy = { ...defaults, version: 1, theme: { id: 'xp', filesEnabled: false },
    workspace: { version: 1, names: ['Code', 'Notes'], active: 1 } };
  let bytes = encodeUtf8(JSON.stringify(legacy)), writes = 0;
  const files = { read: () => bytes, close() {}, write(next, initial) {
    assert.equal(initial, false); bytes = next; writes++;
  } };
  const store = createShellConfiguration(files, () => assert.fail('legacy storage read'));
  assert.deepEqual(store.snapshot, { ...legacy, version: 2, desktop });
  store.close();
  createShellConfiguration(files, () => assert.fail('legacy storage read')).close();
  assert.equal(writes, 1);
  assert.equal(JSON.parse(decodeUtf8(bytes)).version, 2);
  for (const committed of [false, true]) {
    const badFiles = { read: () => encodeUtf8(JSON.stringify(legacy)), close() {},
      write() { throw Object.assign(new Error('migration write failure'), { committed }); } };
    assert.throws(() => createShellConfiguration(badFiles, () => assert.fail('fallback')), error => error.committed === committed);
  }
});
