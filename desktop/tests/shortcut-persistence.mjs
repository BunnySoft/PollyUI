import { createDesktopShell } from './desktop/tests/configured-shell.mjs';
import { saveShortcuts } from './desktop/shell/shortcuts.mjs';
const mode = application.arguments[0];
const shell = createDesktopShell().start();
try {
  if (mode === 'save') {
    saveShortcuts(desktop, shell.configuration, desktop.shortcuts().map(binding => binding.action === 'minimize-window' ?
      { ...binding, modifiers: 2, key: 'm' } : binding));
  } else {
    const binding = desktop.shortcuts().find(binding => binding.action === 'minimize-window');
    if (binding.key !== 'm' || binding.modifiers !== 2) throw new Error('Shortcut was not restored into a fresh compositor');
  }
  console.log('PASS: shortcut persistence ' + mode);
} catch (error) {
  console.error('FAIL: ' + String(error));
}
shell.stop();
