export const SHORTCUTS_KEY = 'desktop.shortcuts.v1';

export function shortcutText(binding) {
  if (!binding.key) return 'Disabled';
  const parts = [];
  if (binding.modifiers & 2) parts.push('Ctrl');
  if (binding.modifiers & 4) parts.push('Alt');
  if (binding.modifiers & 8) parts.push('Super');
  if (binding.modifiers & 1) parts.push('Shift');
  const names = { space: 'Space', Return: 'Enter', Prior: 'Page Up', Next: 'Page Down' };
  parts.push(names[binding.key] || (binding.key.length === 1 ? binding.key.toUpperCase() : binding.key));
  return parts.join('+');
}

export function shortcutFromEvent(event) {
  if (event.repeat || ['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'NumLock'].includes(event.key)) return null;
  const names = { ' ': 'space', Enter: 'Return', ArrowLeft: 'Left', ArrowRight: 'Right',
    ArrowUp: 'Up', ArrowDown: 'Down', PageUp: 'Prior', PageDown: 'Next' };
  return {
    key: names[event.key] || event.key,
    modifiers: (event.shiftKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) |
      (event.altKey ? 4 : 0) | (event.metaKey ? 8 : 0),
  };
}

export function saveShortcuts(native, storage, bindings) {
  const previous = native.shortcuts();
  native.setShortcuts(bindings);
  const applied = native.shortcuts();
  try {
    storage.setItem(SHORTCUTS_KEY, JSON.stringify(applied.map(({ action, modifiers, key }) => ({ action, modifiers, key }))));
  } catch (failure) {
    try { native.setShortcuts(previous); }
    catch (rollback) { throw new Error(String(failure) + '; shortcut rollback failed: ' + String(rollback)); }
    throw failure;
  }
  return applied;
}
