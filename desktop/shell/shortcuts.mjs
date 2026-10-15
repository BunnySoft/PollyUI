export * from './desktop/shared/shortcuts.mjs';
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
