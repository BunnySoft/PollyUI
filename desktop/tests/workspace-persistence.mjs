import { createDesktopShell } from './desktop/shell/shell.mjs';
import { WORKSPACES_KEY, workspacePreferences } from './desktop/shell/workspaces.mjs';
const mode = application.arguments[0];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const snapshot = () => desktop.workspaces().sort((a, b) => a.order - b.order);
const expected = { version: 1, names: ['Console', '\u8d44\u6599', 'Code'], active: 1 };
let shell;
function check(value, message) { if (!value) throw new Error(message); console.log('PASS: ' + message); }
async function until(predicate) {
  const end = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > end) throw new Error('Snapshot did not settle'); await delay(10); }
}
async function run() {
  window.close();
  if (mode === 'bulk') {
    const names = Array.from({ length: 100 }, (_, index) => String(index).padStart(3, '0') + 'x'.repeat(125));
    let denied = false;
    try { desktop.restoreWorkspaces(['Good', 'x'.repeat(129)], 0); } catch { denied = true; }
    check(denied && snapshot().length === 4, 'invalid restore is rejected before staging any changes');
    check(desktop.restoreWorkspaces(names, 99) && snapshot().length === 100 && snapshot()[99].active,
      'multi-message restore exceeds 4 KiB without truncated names or partial activation');
    console.log('PASS: workspace persistence ' + mode);
    window.quit(); return;
  }
  if (mode === 'save') {
    check(desktop.restoreWorkspaces(['Code', 'Reading', 'Console'], 1), 'initial workspace restore is atomic');
  } else if (mode === 'damaged') localStorage.setItem(WORKSPACES_KEY, '{broken');
  shell = createDesktopShell().start();
  if (mode === 'save') {
    const initial = snapshot();
    desktop.renameWorkspace(initial[1].id, '\u8d44\u6599');
    desktop.reorderWorkspace(initial[2].id, 0);
    desktop.reorderWorkspace(initial[1].id, 1);
    await until(() => JSON.stringify(workspacePreferences(snapshot())) === JSON.stringify(expected) &&
      localStorage.getItem(WORKSPACES_KEY) === JSON.stringify(expected));
    check(snapshot()[1].id === initial[1].id && snapshot()[1].active, 'rename/reorder preserve identity and active workspace');
    check(!desktop.restoreWorkspaces(['Stale'], 0), 'later restore cannot overwrite current compositor state');
  } else if (mode === 'reload') {
    check(JSON.stringify(workspacePreferences(snapshot())) === JSON.stringify(expected),
      'fresh compositor restores names/order/current workspace, without persisted Wayland IDs');
    const before = snapshot().map(workspace => workspace.id).join(',');
    shell.stop();
    localStorage.setItem(WORKSPACES_KEY, JSON.stringify({ version: 1, names: ['Stale'], active: 0 }));
    shell = createDesktopShell().start();
    check(snapshot().map(workspace => workspace.id).join(',') === before &&
      localStorage.getItem(WORKSPACES_KEY) === JSON.stringify(expected),
      'same-compositor Shell reconnect retains live identities and ignores stale saved state');
  } else if (mode === 'damaged') {
    check(snapshot().length === 4 && shell.getState().error.includes('Workspace settings') &&
      localStorage.getItem(WORKSPACES_KEY) === '{broken', 'damaged preferences keep defaults and report without overwriting');
    localStorage.setItem(WORKSPACES_KEY, JSON.stringify(expected));
  } else {
    check(JSON.stringify(workspacePreferences(snapshot())) === JSON.stringify(expected), 'corrected preferences recover on next session');
  }
  console.log('PASS: workspace persistence ' + mode);
  shell.stop();
  window.quit();
}
run().catch(error => { console.error('FAIL: ' + String(error)); shell?.stop(); window.quit(); });
