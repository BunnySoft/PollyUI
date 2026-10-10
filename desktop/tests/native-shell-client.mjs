import { createDesktopShell } from './desktop/tests/configured-shell.mjs';
import { DESKTOP_THEMES, getDesktopTheme } from './desktop/shell/themes.mjs';

function check(value, message) {
  if (!value) throw new Error(message);
  console.log('PASS: ' + message);
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function painted(shell) {
  for (let i = 0; i < 500; i++) {
    if (shell.getSurfaces().every(surface => !surface.window.closed &&
      surface.window.document.body.offsetWidth > 0)) return;
    await delay(10);
  }
  throw new Error('Shell surfaces did not present');
}
const shell = createDesktopShell().start();
async function run() {
  const [mode, prefix] = application.arguments;
  if (mode === 'reload') {
    check(shell.getState().themeId === 'bigsur', 'real shell reloads persisted appearance');
    await painted(shell);
  } else {
    for (const theme of DESKTOP_THEMES) {
      check(shell.selectTheme(theme.id), theme.id + ' theme applied');
      await painted(shell);
      check(shell.configuration.snapshot.theme.id === theme.id, theme.id + ' persisted in shell configuration');
      const output = shell.getState().outputs[0];
      const surfaces = shell.getSurfaces().filter(surface => surface.output === output);
      check(surfaces.length === (theme.panel.kind === 'dock' ? 3 : 2), theme.id + ' has the expected native surface count');
      for (const surface of surfaces) surface.window.capture(prefix + '-' + theme.id + '-' + surface.kind + '.png');
      const panel = surfaces.find(surface => surface.kind === 'panel');
      check(panel.window.document.body.childNodes.length === 1 &&
        panel.window.document.body.firstChild.style.gradientFrom === theme.panel.from,
        theme.id + ' updates the existing native panel tree');
      check(panel.window.document.body.offsetHeight === (theme.panel.kind === 'dock' ? 26 : theme.panel.height),
        theme.id + ' panel has correct logical height');
      const menu = shell.showSettings(output);
      check(menu && menu.document.getElementById('shell-theme-' + theme.id).getAttribute('aria-pressed') === 'true',
        theme.id + ' settings reflect actual selection');
      shell.showSettings(output);
    }
  }
  check(getDesktopTheme(shell.getState().themeId).id === 'bigsur', 'final theme is Big Sur');
  shell.stop();
  console.log('PASS: native themed shell ' + mode + ' complete');
}
run().catch(error => {
  console.error('FAIL: ' + String(error) + '\n' + (error.stack || ''));
  shell.stop();
  window.quit();
});
