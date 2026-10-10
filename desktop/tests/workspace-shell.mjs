import { createDesktopShell } from './desktop/tests/configured-shell.mjs';

const [mode, executable, script] = application.arguments;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(value, message) {
  if (!value) throw new Error(message);
  console.log('PASS: ' + message);
}
function rejects(action, message) {
  let rejected = false;
  try { action(); } catch { rejected = true; }
  check(rejected, message);
}
async function until(predicate, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error('Timed out: ' + message);
}
const workspaces = () => desktop.workspaces().sort((a, b) => a.order - b.order);
const current = () => workspaces().find(workspace => workspace.active);
const applicationWindow = () => desktop.windows().find(window => window.appId === 'org.pollyui.workspace-fixture');
const created = [], exits = new Map();
let shell, serial = 0;
function signal(title) {
  return window.create({ title, layer: 'overlay', width: 1, height: 1,
    anchors: ['top', 'right'], exclusiveZone: -1 });
}
async function acknowledge(title) {
  const marker = signal(title);
  await until(() => marker.closed, title);
}
async function click(surface, id, button = 0) {
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await until(() => surface.window.document.getElementById(id)?.offsetWidth > 0, id + ' layout');
  const node = surface.window.document.getElementById(id);
  const rect = node.getBoundingClientRect();
  await acknowledge(`fixture-click ${++serial} ${Math.floor(rect.x + rect.width / 2)} ` +
    `${Math.floor(rect.y + rect.height / 2)} ${button} ${surface.title}`);
}
function panel() {
  const surface = shell.getSurfaces().find(surface => surface.kind === 'panel');
  return { window: surface.window, title: `PollyShell.panel.${surface.output}` };
}
async function menu() {
  await until(() => created.some(item => item.title.startsWith('PollyShell.settings.') && !item.window.closed),
    'workspace menu');
  return created.find(item => item.title.startsWith('PollyShell.settings.') && !item.window.closed);
}
async function openWorkspaces() {
  await click(panel(), 'shell-workspaces');
  return menu();
}
async function remove(id) {
  const opened = created.find(item => item.title.startsWith('PollyShell.settings.') && !item.window.closed);
  const surface = opened || await openWorkspaces();
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await click(surface, 'shell-workspace-remove-' + id);
  await until(() => !workspaces().some(workspace => workspace.id === id) &&
    created.filter(item => item.title.startsWith('PollyShell.settings.') && !item.window.closed)
      .every(item => !item.window.document.getElementById('shell-workspace-' + id)), 'workspace removal ' + id);
}
function hasTaskButton(id, present = true) {
  const kind = shell.getState().themeId === 'xp' ? 'panel' : 'dock';
  return shell.getSurfaces().filter(surface => surface.kind === kind)
    .every(surface => !!surface.window.document.getElementById('shell-window-' + id) === present);
}
async function run() {
  if (mode === 'denied') {
    window.create({ title: 'Public workspace rejection', width: 160, height: 100 });
    rejects(() => desktop.workspaces(), 'public connection cannot list workspaces');
    rejects(() => desktop.createWorkspace(), 'public connection cannot create workspaces');
    rejects(() => desktop.restoreWorkspaces(['Private'], 0), 'public connection cannot restore workspace preferences');
    rejects(() => desktop.renameWorkspace(1, 'Private'), 'public connection cannot rename workspaces');
    rejects(() => desktop.reorderWorkspace(1, 1), 'public connection cannot reorder workspaces');
    rejects(() => desktop.activateWorkspace(1), 'public connection cannot switch workspaces');
    rejects(() => desktop.moveWindowToWorkspace(1, 1), 'public connection cannot move foreign windows');
    window.quit();
    return;
  }
  desktop.onExit = event => exits.set(event.pid, event.status);
  shell = createDesktopShell({ host: {
    close: () => window.close(), displays: () => window.displays(),
    create(options) {
      const native = window.create(options);
      created.push({ title: options.title, window: native });
      return native;
    },
  } }).start();
  check(shell.selectTheme('xp'), 'workspace fixture uses the taskbar');
  if (mode === 'initial') {
    const initial = workspaces();
    check(initial.length === 4 && initial.filter(workspace => workspace.active).length === 1,
      'four initial workspaces with one globally active workspace');
    desktop.spawnApplication(['foot', '--app-id=org.pollyui.workspace-fixture', '/bin/sh', '-c', 'sleep 300'],
      '', 'workspace-fixture');
    await until(() => applicationWindow()?.active, 'independent application');
    const id = applicationWindow().id;
    check(applicationWindow().workspaceId === initial[0].id, 'new window belongs to its creation workspace');
    check(!desktop.restoreWorkspaces(['Stale saved layout'], 0) &&
      workspaces()[0].id === initial[0].id && applicationWindow().workspaceId === initial[0].id,
      'restoration never replaces workspaces after an ordinary application is mapped');
    let editing = await openWorkspaces();
    await click(editing, 'shell-workspace-rename-' + initial[0].id);
    await until(() => editing.window.document.getElementById('shell-workspace-name'), 'workspace name input');
    await acknowledge('fixture-key 29 1');
    await acknowledge('fixture-key 30 1');
    await acknowledge('fixture-key 30 0');
    await acknowledge('fixture-key 29 0');
    await acknowledge('fixture-key 45 1');
    await acknowledge('fixture-key 45 0');
    await click(editing, 'shell-workspace-name-save');
    await until(() => workspaces()[0].name === 'x', 'native typing and save rename the workspace');
    check(current().id === initial[0].id && applicationWindow().workspaceId === initial[0].id,
      'renaming preserves workspace identity and window membership');
    await click(editing, 'shell-workspace-later-' + initial[0].id);
    await until(() => workspaces()[1].id === initial[0].id, 'native pointer reorders a workspace');
    check(current().id === initial[0].id, 'reordering does not activate a different workspace');
    await click(editing, 'shell-workspace-earlier-' + initial[0].id);
    await until(() => workspaces()[0].id === initial[0].id, 'restore order for workspace policy checks');
    await click(editing, 'shell-workspace-close');
    await acknowledge('fixture-workspace-state 0 1');
    await click(await openWorkspaces(), 'shell-workspace-' + initial[1].id);
    await until(() => current().id === initial[1].id && hasTaskButton(id, false), 'taskbar filters inactive windows');
    check(workspaces().length === 4 && !applicationWindow().minimized, 'empty workspaces persist; hiding is not minimizing');
    await acknowledge('fixture-workspace-state 1 0');
    await acknowledge('fixture-workspace-right');
    await until(() => current().id === initial[2].id, 'workspace keyboard shortcut');
    await acknowledge('fixture-workspace-left');
    await until(() => current().id === initial[1].id, 'workspace keyboard shortcut back');
    desktop.moveWindowToWorkspace(id, initial[1].id);
    await until(() => applicationWindow().workspaceId === initial[1].id && hasTaskButton(id), 'move into current workspace');
    desktop.maximizeWindow(id);
    await until(() => applicationWindow().maximized, 'maximize before moving');
    await click(panel(), 'shell-window-' + id, 2);
    await click(await menu(), 'shell-window-workspace-' + initial[2].id);
    await until(() => applicationWindow().workspaceId === initial[2].id && hasTaskButton(id, false), 'window-menu move');
    check(current().id === initial[1].id && applicationWindow().maximized, 'moving does not follow and preserves maximize');
    desktop.activateWindow(id);
    await until(() => current().id === initial[2].id && applicationWindow().active, 'activation selects owning workspace');
    desktop.fullscreenWindow(id);
    await until(() => applicationWindow().fullscreen, 'fullscreen on the same workspace');
    await acknowledge('fixture-workspace-left');
    await until(() => current().id === initial[1].id, 'leave fullscreen workspace');
    check(applicationWindow().fullscreen && workspaces().length === 4, 'fullscreen state survives without extra workspaces');
    await acknowledge('fixture-workspace-state 1 0');
    await acknowledge('fixture-workspace-right');
    await until(() => current().id === initial[2].id && applicationWindow().active, 'restore fullscreen workspace');
    desktop.unfullscreenWindow(id);
    await until(() => !applicationWindow().fullscreen, 'leave fullscreen');
    await click(await openWorkspaces(), 'shell-workspace-add');
    await until(() => workspaces().length === 5, 'manual workspace creation');
    check(current().id === initial[2].id, 'adding an empty workspace does not switch automatically');
    await remove(initial[0].id);
    await remove(initial[2].id);
    await until(() => current().id === initial[1].id && applicationWindow().workspaceId === initial[1].id,
      'occupied workspace deletion migrates to previous');
    rejects(() => desktop.activateWorkspace(initial[2].id), 'removed workspace ID is rejected');
    await remove(initial[1].id);
    await until(() => current().id === initial[3].id && applicationWindow().workspaceId === initial[3].id,
      'occupied first workspace deletion migrates to next');
    const last = workspaces().find(workspace => !workspace.active);
    await remove(last.id);
    check(workspaces().length === 1 && !current().canRemove, 'at least one workspace remains');
    rejects(() => desktop.removeWorkspace(current().id), 'cannot remove the last workspace');
    check(applicationWindow().id === id && applicationWindow().maximized, 'migration preserves window identity and state');
    if (created.some(item => item.title.startsWith('PollyShell.settings.') && !item.window.closed))
      await click(await menu(), 'shell-workspace-close');
    const probe = desktop.spawnApplication([executable, '--desktop', script, 'denied'], '', 'workspace-public');
    await until(() => exits.has(probe), 'public workspace probe');
    check(exits.get(probe) === 0, 'workspace APIs reject public clients');
    desktop.activateWindow(id);
    await until(() => applicationWindow().active, 'application remains running');
    const retained = current().id;
    desktop.createWorkspace();
    await until(() => workspaces().length === 2, 'extra workspace for Dock filtering');
    const extra = workspaces().find(workspace => workspace.id !== retained);
    check(shell.selectTheme('bigsur'), 'workspace state is independent of the appearance');
    await until(() => hasTaskButton(id), 'Dock shows current workspace windows');
    desktop.activateWorkspace(extra.id);
    await until(() => current().id === extra.id && hasTaskButton(id, false), 'Dock hides other workspaces');
    await acknowledge('fixture-workspace-state 1 0');
    desktop.activateWorkspace(retained);
    await until(() => current().id === retained && hasTaskButton(id), 'Dock restores workspace windows');
    desktop.removeWorkspace(extra.id);
    await until(() => workspaces().length === 1, 'remove extra workspace');
    await acknowledge('fixture-workspace-state 0 1');
  } else {
    check(workspaces().length === 1 && current().name === 'Workspace 4',
      'Shell reconnect preserves manual workspace layout, not initial defaults');
    await until(() => applicationWindow()?.workspaceId === current().id && hasTaskButton(applicationWindow().id),
      'reconnect rebuilds workspace membership');
    desktop.closeWindow(applicationWindow().id);
    await until(() => !applicationWindow(), 'application closes independently of workspace lifetime');
    check(workspaces().length === 1, 'empty workspace is retained after application exit');
  }
  check(!shell.getState().error, 'Shell workspace actions report no errors');
  await acknowledge('fixture-success');
  if (mode === 'reload') { desktop.createWorkspace(); desktop.createWorkspace(); }
  shell.stop();
  window.quit();
}
run().catch(error => {
  console.error('FAIL: ' + String(error) + '\n' + (error.stack || ''));
  shell?.stop();
  window.quit();
});
