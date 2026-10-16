import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { test } from 'node:test';
import { parseThemeCatalog, parseThemeFile, applyThemeOverrides } from '../shared/ui/theme-schema.mjs';
import { dockSurfaceWidth } from '../shared/ui/theme-layout.mjs';
register('./root-loader.mjs', import.meta.url);
const { windowTasks, taskLabel, taskIdentity } = await import('../shell/window-groups.mjs');
const { applicationForWindow, parseDesktopEntry, applicationCatalog } = await import('../shell/applications.mjs');

const catalog = parseThemeCatalog(readFileSync(new URL('../resources/themes/builtin.json', import.meta.url), 'utf8'));
const encode = themes => JSON.stringify({ schemaVersion: 1, themes });

test('independent ordered pins merge only unambiguous real running groups and retain unavailable launchers', () => {
  const catalog = [{ id: 'files.desktop', appId: 'org.example.files', name: 'Files' },
    { id: 'notes.desktop', appId: 'org.example.notes', name: 'Notes', unavailable: 'Executable missing' }];
  const windows = [{ id: 10, appId: 'org.example.files', workspaceId: 7, active: true },
    { id: 11, appId: 'org.example.files', workspaceId: 7, minimized: true }, { id: 12 }];
  const pins = Object.freeze(['notes.desktop', 'files.desktop', 'gone.desktop']);
  const tasks = windowTasks(windows, 'applications', catalog, pins, 7);
  assert.equal(tasks.length, 4);
  assert.deepEqual(tasks.slice(0, 3).map(task => task.catalogId), pins);
  assert.equal(tasks[0].launcher, true);
  assert.equal(tasks[0].count, 0);
  assert.equal(tasks[0].unavailable, 'Executable missing');
  assert.equal(tasks[1].launcher, false);
  assert.equal(tasks[1].grouped, true);
  assert.equal(tasks[1].count, 2);
  assert.deepEqual(tasks[1].windows, windows.slice(0, 2));
  assert.equal(tasks[1].active, true);
  assert.equal(tasks[2].launcher, true);
  assert.match(taskLabel(tasks[2]), /unavailable/);
  assert.equal(tasks[3], windows[2], 'unknown windows remain real individual tasks');
  assert.deepEqual(windowTasks(windows, 'windows', catalog, pins, 7), windows, 'legacy mode ignores pins');
  const stopped = windowTasks([], 'applications', catalog, pins, 7);
  assert.equal(stopped[1].id, tasks[1].id, 'pin slot ID survives launcher/running transitions');
  assert.notEqual(taskIdentity(stopped[1]), taskIdentity(tasks[1]), 'held launch must not become window activation');
  assert.notEqual(taskIdentity(stopped[1]), taskIdentity({ ...stopped[1], workspaceId: 9 }));
  const conflicting = [...catalog, { id: 'other.desktop', appId: 'org.example.files', name: 'Other' }];
  const ambiguous = windowTasks(windows, 'applications', conflicting, ['files.desktop'], 7);
  assert.equal(ambiguous[0].launcher, true);
  assert.equal(ambiguous[1].appId, 'org.example.files');
  assert.equal(ambiguous[1].count, 2, 'ambiguous registration does not consume the real running group');
  const afterUninstall = windowTasks(windows, 'applications', [], ['files.desktop'], 7);
  assert.equal(afterUninstall[0].launcher, true);
  assert.equal(afterUninstall[1].appId, 'org.example.files');
});

test('registered runtime IDs are optional bounded metadata, not inferred desktop-file aliases', () => {
  const file = extra => ({ id: 'registered.desktop', path: '/apps/registered.desktop',
    contents: '[Desktop Entry]\nType=Application\nName=Registered\nExec=program\n' + extra });
  const original = parseDesktopEntry(file(''));
  assert.equal(Object.hasOwn(original, 'appId'), false, 'legacy catalog shape is unchanged');
  assert.equal(applicationForWindow([original], 'registered.desktop'), original);
  assert.equal(applicationForWindow([original], 'registered'), null, 'no suffix stripping');
  for (const appId of ['org.pollyui.files', 'Foo', 'Mixed_Case-App.2', 'a'.repeat(255)]) {
    const parsed = parseDesktopEntry(file('X-Polly-AppId=' + appId + '\n'));
    assert.equal(parsed.appId, appId);
    assert.deepEqual(parsed.argv, original.argv, 'display metadata cannot change launch argv');
    assert.equal(parsed.id, original.id, 'persisted desktop-entry IDs do not change');
    assert.equal(applicationForWindow([parsed], appId), parsed);
  }
  for (const invalid of ['', ' Foo', 'Foo ', 'with space', 'Foo\\sBar', 'Foo\\tBar', 'Foo\\n',
    '../app', '/app', 'C:\\\\app', 'https://app', 'polly-memory:1', 'a'.repeat(256), 'Foo\u007f']) {
    assert.throws(() => parseDesktopEntry(file('X-Polly-AppId=' + invalid + '\n')), /X-Polly-AppId/);
  }
  const reports = [];
  assert.equal(applicationCatalog([file('X-Polly-AppId=/invalid\n')], {}, message => reports.push(message)).length, 0);
  assert.match(reports[0], /Skipping.*X-Polly-AppId/, 'invalid registration is explicitly reported');
});

test('task naming and artwork entry selection share exact-first and unambiguous explicit runtime identity', () => {
  const registered = { id: 'polly-files.desktop', appId: 'org.pollyui.files', name: 'Files', icon: '/icons/files.png' };
  const other = { id: 'other.desktop', appId: 'org.pollyui.files', name: 'Other Files', icon: '/icons/other.png' };
  const exact = { id: 'org.pollyui.files', name: 'Exact Files', icon: '/icons/exact.png' };
  const snapshot = [{ id: 1, appId: 'org.pollyui.files', title: 'A document', workspaceId: 7 },
    { id: 2, appId: 'org.pollyui.files', title: 'B document', workspaceId: 7 }];
  for (const entries of [[registered, other], [other, registered]]) {
    assert.equal(applicationForWindow(entries, snapshot[0].appId), null);
    assert.equal(windowTasks(snapshot, 'applications', entries)[0].title, snapshot[0].appId,
      'conflicting claims keep the real ID/fallback instead of selecting arbitrary artwork');
  }
  for (const entries of [[registered, other, exact], [exact, other, registered]]) {
    assert.equal(applicationForWindow(entries, snapshot[0].appId), exact);
    assert.equal(windowTasks(snapshot, 'applications', entries)[0].title, exact.name);
  }
  const group = windowTasks(snapshot, 'applications', [registered])[0];
  assert.equal(applicationForWindow([registered], group.appId).icon, registered.icon);
  assert.equal(group.title, 'Files');
  assert.equal(group.id, 'app-org.pollyui.files', 'the grouping key remains the real runtime appId');
  assert.deepEqual(group.windows, snapshot, 'metadata does not change membership or snapshots');
  const settings = { id: 'org.pollyui.settings', name: 'Settings' };
  const registeredSettings = { id: 'polly-settings.desktop', appId: settings.id, name: 'Registered Settings',
    icon: '/icons/settings.png' };
  assert.equal(applicationForWindow([settings, registeredSettings], settings.id), settings);
  assert.equal(applicationForWindow([registeredSettings], settings.id), registeredSettings,
    'resource-only catalog resolves the actual registration without losing synthetic display identity');
  const bundle = { id: 'bundle:org.example.notes', appId: 'org.example.notes', name: 'Notes' };
  assert.equal(applicationForWindow([bundle], bundle.appId), bundle);
  assert.equal(applicationForWindow([{ id: bundle.id }], bundle.appId), null, 'no inferred bundle-prefix alias');
});

test('packaged desktop registrations declare their actual wrapper IDs and one shared hidden text handler', () => {
  const entries = [];
  for (const [name, appId] of [['files', 'org.pollyui.files'], ['settings', 'org.pollyui.settings'],
    ['processes', 'org.pollyui.processes'], ['file-text', 'org.pollyui.file-text'],
    ['file-text-open', 'org.pollyui.file-text']]) {
    const id = 'polly-' + name + '.desktop';
    const file = { id, path: '/applications/' + id,
      contents: readFileSync(new URL('../release/' + id, import.meta.url), 'utf8') };
    const parsed = parseDesktopEntry(file, { documentHandlers: true });
    const wrapper = readFileSync(new URL('../tools/polly-' + (name === 'file-text-open' ? 'file-text' : name) +
      '.in', import.meta.url), 'utf8');
    assert.match(wrapper, new RegExp('--app-id ' + appId.replaceAll('.', '\\.') + ' '));
    assert.equal(parsed.appId, appId);
    assert.equal(parsed.icon, '@CMAKE_INSTALL_FULL_DATADIR@/icons/hicolor/64x64/apps/polly-' +
      (name === 'file-text-open' ? 'file-text' : name) + '.png', 'parser leaves build configuration placeholders literal');
    if (name === 'file-text-open') assert.equal(parseDesktopEntry(file), null);
    else entries.push(parseDesktopEntry(file));
  }
  assert.equal(applicationForWindow(entries, 'org.pollyui.file-text').id, 'polly-file-text.desktop');
});

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
