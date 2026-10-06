import { WORKSPACES_KEY, workspaceName, readWorkspacePreferences, workspacePreferences,
  createWorkspacePersistence } from './desktop/shell/workspaces.mjs';

function check(value, message) {
  if (!value) throw new Error('FAIL: ' + message);
  console.log('PASS: ' + message);
}
function rejects(action, message) {
  let failed = false;
  try { action(); } catch { failed = true; }
  check(failed, message);
}
const initial = [
  { id: 51, name: 'Code', order: 1, active: true },
  { id: 82, name: '\u8d44\u6599', order: 0, active: false },
];
const preferences = workspacePreferences(initial);
check(JSON.stringify(preferences) === JSON.stringify({ version: 1, names: ['\u8d44\u6599', 'Code'], active: 1 }),
  'only names, order and active index are persisted, not live IDs');
check(workspaceName('\u00e9'.repeat(64)).length === 64, '128-byte UTF-8 name is accepted');
rejects(() => workspaceName('\u00e9'.repeat(65)), 'UTF-8 name byte limit is enforced');
for (const name of ['', '\0', '\ud800', 42])
  rejects(() => workspaceName(name), 'invalid workspace name is rejected');
for (const value of [null, [], { version: 2, names: ['x'], active: 0 },
  { version: 1, names: [], active: 0 }, { version: 1, names: ['x'], active: 1 },
  { version: 1, names: ['x'], active: 0.1 }, { version: 1, names: ['x'], active: 0, extra: 1 }])
  rejects(() => readWorkspacePreferences(JSON.stringify(value)), 'invalid preference schema is rejected');
rejects(() => readWorkspacePreferences(' '.repeat(1024 * 1024 + 1)), 'oversized preference document is rejected');
rejects(() => readWorkspacePreferences(JSON.stringify({ version: 1,
  names: Array(9000).fill('\u4e00'.repeat(42)), active: 0 })), 'preference size is bounded in UTF-8 bytes, not character count');
rejects(() => workspacePreferences(initial.map(item => ({ ...item, active: false }))), 'missing active workspace is rejected');
rejects(() => workspacePreferences(initial.map(item => ({ ...item, active: true }))), 'multiple active workspaces are rejected');

let stored = JSON.stringify(preferences), live = initial, writes = 0, restores = 0, failWrite = false;
const failures = [];
const storage = {
  getItem(key) { check(key === WORKSPACES_KEY, 'dedicated workspace preference key'); return stored; },
  setItem(key, text) { if (failWrite) throw new Error('disk full'); writes++; stored = text; },
};
const native = {
  workspaces: () => live,
  restoreWorkspaces(names, active) {
    restores++;
    live = names.map((name, order) => ({ id: order + 100, name, order, active: order === active }));
    return true;
  },
};
const create = () => createWorkspacePersistence({ native, storage, failure: error => failures.push(String(error)) });
let persistence = create();
persistence.start();
check(restores === 1 && live[1].active && live[0].name === '\u8d44\u6599', 'valid settings restore before first snapshot save');
const before = writes;
persistence.sync(live);
check(writes === before, 'unchanged snapshots do not rewrite storage');
failWrite = true;
live[1].name = 'Renamed';
persistence.sync(live);
check(failures.at(-1).includes('disk full') && JSON.parse(stored).names[1] === 'Code', 'save failure preserves last durable preferences');
failWrite = false;
persistence.sync(live);
check(JSON.parse(stored).names[1] === 'Renamed', 'later snapshot retries failed persistence');
stored = '{broken';
persistence = create();
persistence.start();
const brokenWrites = writes;
persistence.sync(live);
check(writes === brokenWrites && stored === '{broken', 'damaged settings are not silently overwritten');
persistence.saveCurrent();
check(JSON.parse(stored).names[1] === 'Renamed', 'explicit save-current recovers damaged preferences');
native.restoreWorkspaces = () => false;
live = [{ id: 999, name: 'Live state', order: 0, active: true }];
persistence = create();
persistence.start();
check(JSON.parse(stored).names[0] === 'Live state', 'Shell reconnect saves authoritative live state instead of stale stored layout');
