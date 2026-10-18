// Presentation order only. The catalog's declared order and default stay authoritative
// for persistence and theme-file compatibility; the settings gallery shows Modern first.
export function appearanceThemes(themes) {
  if (!Array.isArray(themes)) throw new TypeError('A theme list is required');
  const modern = themes.filter(theme => theme?.id === 'modern');
  return modern.concat(themes.filter(theme => theme?.id !== 'modern'));
}
