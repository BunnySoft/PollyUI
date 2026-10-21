export function workspaceCubePreferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'enabled,motion' ||
      typeof value.enabled !== 'boolean' || typeof value.motion !== 'boolean')
    throw new TypeError('Workspace cube requires boolean enabled and motion');
  return { enabled: value.enabled, motion: value.motion };
}
