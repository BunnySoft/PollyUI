import { applicationForWindow } from './applications.mjs';

export function validateLauncherPins(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'applications,version' || value.version !== 1 ||
      !Array.isArray(value.applications) || value.applications.length > 32)
    throw new TypeError('Invalid launcher pin profile');
  const ids = new Set(), applications = [];
  for (const id of value.applications) {
    if (typeof id !== 'string' || !id.length || id.length > 255 ||
        /[\x00-\x1f\x7f/\\]/.test(id) || /[\uD800-\uDFFF]/u.test(id) || ids.has(id))
      throw new TypeError('Invalid or duplicate launcher catalog ID');
    ids.add(id); applications.push(id);
  }
  return { version: 1, applications };
}

export function pinnedTasks(tasks, pins, catalog, workspaceId, registrations = catalog) {
  // Display-only Shell entries must not shadow actual registered runtime identities.
  const used = new Set();
  const launchers = pins.map(id => {
    const entry = catalog.find(entry => entry.id === id);
    const matches = entry ? tasks.filter(task => task.grouped && !used.has(task) &&
      (task.appId === id || applicationForWindow(registrations, task.appId)?.id === id)) : [];
    const running = matches.length === 1 ? matches[0] : null;
    if (running) used.add(running);
    return { ...(running ?? { windows: [], count: 0, active: false, minimized: false, workspaceId }),
      id: 'pin-' + encodeURIComponent(id), catalogId: id, pinned: true, launcher: !running,
      title: entry?.name || id, unavailable: entry ? entry.unavailable || '' : 'Application is no longer in the catalog' };
  });
  return [...launchers, ...tasks.filter(task => !used.has(task))];
}
