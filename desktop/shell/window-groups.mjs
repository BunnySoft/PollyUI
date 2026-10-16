// The caller supplies the current workspace's real window snapshots.
export function windowTasks(windows, grouping = 'windows', catalog = []) {
  if (!['windows', 'applications'].includes(grouping)) throw new TypeError('Unsupported task grouping');
  const ordered = [...windows].sort((a, b) => a.id - b.id);
  if (grouping === 'windows') return ordered;
  const names = new Map(catalog.map(entry => [entry.id, entry.name]));
  const groups = new Map(), tasks = [];
  for (const window of ordered) {
    if (typeof window.appId !== 'string' || !window.appId.length) {
      tasks.push(window);
      continue;
    }
    let group = groups.get(window.appId);
    if (!group) {
      group = { id: 'app-' + encodeURIComponent(window.appId), appId: window.appId,
        title: names.get(window.appId) || window.appId, grouped: true, windows: [] };
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
  return tasks;
}

export function taskLabel(task) {
  const title = task.title || task.appId || 'Untitled';
  return task.grouped ? title + ' (' + task.count + (task.count === 1 ? ' window' : ' windows') + ')' +
    (task.minimized ? ', all minimized' : task.partiallyMinimized ? ', some minimized' : '') : title;
}
