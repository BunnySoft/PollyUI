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

export function validateShortcuts(bindings) {
  if (!Array.isArray(bindings) || bindings.length !== actions.length)
    throw new TypeError('Invalid shortcut preferences');
  const seen = new Set();
  return bindings.map(binding => {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding) ||
        Object.keys(binding).sort().join(',') !== 'action,key,modifiers' ||
        !actions.includes(binding.action) || seen.has(binding.action) ||
        typeof binding.key !== 'string' || binding.key.includes('\0') ||
        encodeUtf8(binding.key).length >= 128 || !Number.isInteger(binding.modifiers) ||
        binding.modifiers < 0 || binding.modifiers > 15)
      throw new TypeError('Invalid or duplicate shortcut preference');
    seen.add(binding.action);
    return { action: binding.action, modifiers: binding.modifiers, key: binding.key };
  });
}
export function saveShortcuts(native, configuration, bindings) {
  const previous = native.shortcuts();
  native.setShortcuts(bindings);
  const applied = native.shortcuts();
  try {
    configuration.update({ shortcuts: applied.map(({ action, modifiers, key }) => ({ action, modifiers, key })) });
  } catch (failure) {
    if (failure.committed) throw failure;
    try { native.setShortcuts(previous); }
    catch (rollback) { throw new Error(String(failure) + '; shortcut rollback failed: ' + String(rollback)); }
    throw failure;
  }
  return applied;
}
import { encodeUtf8 } from './sysrt/sdk/js/encoding.mjs';

const actions = ['switch-window', 'close-window', 'minimize-window', 'maximize-window',
  'fullscreen-window', 'previous-workspace', 'next-workspace'];
