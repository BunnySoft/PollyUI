import { createDesktopShell } from './desktop/shell/shell.mjs';
import { defaultShellConfiguration } from './desktop/shell/configuration.mjs';
import { memoryConfiguration } from './desktop/tests/configuration-memory.mjs';
import { BUILTIN_THEME_CATALOG, installThemeCatalog } from './desktop/shared/ui/themes.mjs';
import { encodeDecorationLayout } from './desktop/shared/ui/caption-layout.mjs';

const configuration = memoryConfiguration({ ...defaultShellConfiguration(),
  theme: { id: 'bigsur', filesEnabled: false } });
const shell = createDesktopShell({ configuration }).start();
const control = window.create({ title: 'Backdrop.fixture.control', width: 160, height: 64 });
control.document.body.style.backgroundColor = '#314159';
control.document.body.tabIndex = 0;
control.document.body.focus();
let phase = 0;
control.document.body.addEventListener('keydown', event => {
  if (event.key !== ' ' || event.repeat) return;
  event.preventDefault();
  if (phase === 0) {
    const surfaces = shell.getSurfaces(), dock = surfaces.find(surface => surface.kind === 'dock');
    const panel = surfaces.find(surface => surface.kind === 'panel');
    const theme = BUILTIN_THEME_CATALOG.themes.find(theme => theme.id === 'bigsur');
    const material = [2, 1, 16000, 8, 0xe7e7e7, 28];
    for (const targets of [[[panel.window, material]], [[control, material]],
      [[dock.window, [1, 1, 16000, 8, 0xe7e7e7, 28]]],
      [[dock.window, [2, 1, 64000, 8, 0xe7e7e7, 28]]],
      [[dock.window, [2, 1, 16000, 33, 0xe7e7e7, 28]]],
      [[dock.window, material], [dock.window, material]]]) {
      let rejected = false;
      try { desktop.configureAppearance(theme, encodeDecorationLayout(theme), targets); }
      catch (error) { rejected = true; console.log('EXPECTED_BACKDROP_REJECTION ' + String(error)); }
      if (!rejected || surfaces.some(surface => surface.window.closed))
        throw new Error('Invalid target/material transaction altered committed Shell resources');
    }
    control.document.body.style.backgroundColor = '#112233';
  } else if (phase === 1) {
    const legacy = JSON.parse(JSON.stringify(BUILTIN_THEME_CATALOG));
    delete legacy.themes.find(theme => theme.id === 'bigsur').panel.regionalBackdrop;
    installThemeCatalog(legacy);
    if (!shell.selectTheme('bigsur')) throw new Error(shell.getState().error);
    control.document.body.style.backgroundColor = '#271828';
  } else if (phase === 2) {
    installThemeCatalog(BUILTIN_THEME_CATALOG);
    if (!shell.selectTheme('bigsur')) throw new Error(shell.getState().error);
    control.document.body.style.backgroundColor = '#161803';
  } else {
    shell.stop();
    window.quit();
  }
  phase++;
});
control.onclose = () => { shell.stop(); window.quit(); };
window.close();
