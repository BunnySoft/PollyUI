import { applicationForWindow } from './applications.mjs';
import { pinnedTasks } from './launcher-pins.mjs';

// The caller supplies the current workspace's real window snapshots.
export function windowTasks(windows, grouping = 'windows', catalog = [], pins = [], workspaceId, registrations = catalog) {
  if (!['windows', 'applications'].includes(grouping)) throw new TypeError('Unsupported task grouping');
  if (grouping === 'windows') return [...windows];
  const ordered = [...windows].sort((a, b) => a.id - b.id);
  const groups = new Map(), tasks = [];
  for (const window of ordered) {
    if (typeof window.appId !== 'string' || !window.appId.length) {
      tasks.push(window);
      continue;
    }
    let group = groups.get(window.appId);
    if (!group) {
      group = { id: 'app-' + encodeURIComponent(window.appId), appId: window.appId,
        title: applicationForWindow(catalog, window.appId)?.name || window.appId, workspaceId: window.workspaceId,
        grouped: true, windows: [] };
      groups.set(window.appId, group);
      tasks.push(group);
    }
    group.windows.push(window);
  }
  for (const group of groups.values()) {
    group.count = group.windows.length;
    group.active = group.windows.some(window => window.active);
    group.minimized = group.windows.every(window => window.minimized);
    group.partiallyMinimized = !group.minimized && group.windows.some(window => window.minimized);
  }
  return pins.length ? pinnedTasks(tasks, pins, catalog, workspaceId, registrations) : tasks;
}

export function taskIdentity(task) {
  return JSON.stringify([task.id, task.appId, task.workspaceId,
    task.grouped ? task.windows.map(window => window.id) : null,
    task.catalogId, task.launcher, task.unavailable]);
}

export function taskLabel(task) {
  const title = task.title || task.appId || 'Untitled';
  if (task.launcher) return title + (task.unavailable ? ' (unavailable)' : ' (pinned, not running)');
  return task.grouped ? title + ' (' + task.count + (task.count === 1 ? ' window' : ' windows') + ')' +
    (task.minimized ? ', all minimized' : task.partiallyMinimized ? ', some minimized' : '') : title;
}
