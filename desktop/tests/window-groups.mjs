import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { windowTasks, taskLabel } from '../shell/window-groups.mjs';
import { parseThemeCatalog, parseThemeFile, applyThemeOverrides } from '../shared/ui/theme-schema.mjs';
import { dockSurfaceWidth } from '../shared/ui/theme-layout.mjs';

const catalog = parseThemeCatalog(readFileSync(new URL('../resources/themes/builtin.json', import.meta.url), 'utf8'));
const encode = themes => JSON.stringify({ schemaVersion: 1, themes });

test('exact nonempty app IDs only; unknown windows and the old Window.id interface stay independent', () => {
  const windows = [
    { id: 5, appId: 'org.real.App', title: 'Second', minimized: true },
    { id: 1, appId: 'org.real.App', title: 'First', active: true },
    { id: 3, appId: 'org.real.app', title: 'Different case' },
    { id: 4, appId: 'org.real.App.desktop', title: 'Not an alias' },
    { id: 6, appId: '', title: 'Unknown A' }, { id: 7, title: 'Unknown B' },
    { id: 8, appId: ' ', title: 'Exact whitespace is not an alias' },
  ].map(Object.freeze);
  Object.freeze(windows);
  const before = JSON.stringify(windows);
  const tasks = windowTasks(windows, 'applications', [{ id: 'org.real.App', name: 'Real application' }]);
  assert.equal(tasks.length, 6);
  assert.equal(tasks[0].title, 'Real application');
  assert.equal(tasks[0].id, 'app-org.real.App');
  assert.deepEqual(tasks[0].windows.map(window => window.id), [1, 5]);
  assert.equal(tasks[0].count, 2);
  assert.equal(tasks[0].active, true);
  assert.equal(tasks[0].minimized, false);
  assert.equal(tasks[0].partiallyMinimized, true);
  assert.match(taskLabel(tasks[0]), /2 windows.*some minimized/);
  assert.equal(tasks[1].title, 'org.real.app');
  assert.equal(tasks[3], windows[4]);
  assert.equal(tasks[4], windows[5]);
  assert.equal(JSON.stringify(windows), before);
  assert.deepEqual(windowTasks([...windows].reverse(), 'applications').map(task => task.id), tasks.map(task => task.id));
  for (const mode of [undefined, 'windows'])
    assert.deepEqual(windowTasks(windows, mode).map(window => window.id), windows.map(window => window.id));
  assert.throws(() => windowTasks(windows, 'automatic'), /Unsupported/);
});

test('live membership converges on close/workspace changes; all minimized is still running', () => {
  const windows = [
    { id: 1, appId: 'same', workspaceId: 7, minimized: true },
    { id: 2, appId: 'same', workspaceId: 7, minimized: true, active: true },
    { id: 3, appId: 'same', workspaceId: 9 },
  ];
  const first = windowTasks(windows.filter(window => window.workspaceId === 7), 'applications')[0];
  assert.equal(first.count, 2);
  assert.equal(first.active, true);
  assert.equal(first.minimized, true);
  assert.equal(first.partiallyMinimized, false);
  assert.equal(first.workspaceId, 7);
  const remaining = windowTasks([windows[1]], 'applications')[0];
  assert.equal(remaining.id, first.id);
  assert.equal(remaining.count, 1);
  assert.equal(windowTasks([], 'applications').length, 0);
  const secondWorkspace = windowTasks(windows.filter(window => window.workspaceId === 9), 'applications')[0];
  assert.deepEqual(secondWorkspace.windows.map(window => window.id), [3]);
  assert.equal(secondWorkspace.active, false);
  assert.equal(secondWorkspace.workspaceId, 9);
});

test('taskGrouping is optional schema-1 data, strict in file/catalog/overrides with no theme-ID heuristic', () => {
  const fallback = parseThemeCatalog(readFileSync(new URL('../resources/themes/fallback.json', import.meta.url), 'utf8'));
  for (const source of [catalog, fallback])
    for (const theme of source.themes) assert.equal(theme.panel.taskGrouping,
      ['modern', 'aqua', 'lion', 'bigsur'].includes(theme.id) ? 'applications' : undefined);
  const custom = JSON.parse(JSON.stringify(catalog.themes.find(theme => theme.id === 'modern')));
  custom.id = 'custom-legacy';
  delete custom.panel.taskGrouping;
  assert.equal(parseThemeFile(JSON.stringify({ schemaVersion: 1, theme: custom })).panel.taskGrouping, undefined);
  for (const mode of ['windows', 'applications']) {
    custom.panel.taskGrouping = mode;
    assert.equal(parseThemeFile(JSON.stringify({ schemaVersion: 1, theme: custom })).panel.taskGrouping, mode);
    assert.equal(applyThemeOverrides(catalog, encode({ modern: { panel: { taskGrouping: mode } } }))
      .themes.find(theme => theme.id === 'modern').panel.taskGrouping, mode);
    assert.equal(applyThemeOverrides(catalog, encode({ xp: { panel: { taskGrouping: mode } } }))
      .themes.find(theme => theme.id === 'xp').panel.taskGrouping, mode);
  }
  for (const invalid of [null, true, 1, '', 'auto', 'Applications', ['windows']]) {
    custom.panel.taskGrouping = invalid;
    assert.throws(() => parseThemeFile(JSON.stringify({ schemaVersion: 1, theme: custom })), /taskGrouping/);
    assert.throws(() => parseThemeCatalog(JSON.stringify({ schemaVersion: 1, default: custom.id, themes: [custom] })),
      /taskGrouping/);
    assert.throws(() => applyThemeOverrides(catalog, encode({ modern: { panel: { taskGrouping: invalid } } })),
      /taskGrouping/);
  }
});

test('Dock natural width counts display tasks, not group members, without changing fitting/gap math', () => {
  const theme = catalog.themes.find(theme => theme.id === 'bigsur'), l = theme.layout;
  const tasks = windowTasks([{ id: 1, appId: 'same' }, { id: 2, appId: 'same' },
    { id: 3, appId: 'other' }, { id: 4 }], theme.panel.taskGrouping);
  const count = tasks.length;
  assert.equal(count, 3);
  const natural = 2 * l.dockPadding + 3 * l.dockTileWidth + 13 +
    count * l.dockWindowWidth + (count + 3) * l.dockGap;
  assert.equal(dockSurfaceWidth(theme, count, Infinity), natural);
  assert.equal(dockSurfaceWidth(theme, count, natural - 1 + 2 * l.screenInset), natural - 1);
});
