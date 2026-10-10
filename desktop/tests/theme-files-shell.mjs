import { createDesktopShell } from './desktop/tests/configured-shell.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(value, message) { if (!value) throw new Error(message); console.log('PASS: ' + message); }
async function until(predicate, message) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out: ' + message);
    await delay(10);
  }
}
const exits = new Map();
desktop.onExit = event => exits.set(event.pid, event.status);
async function write(mode) {
  const pid = desktop.spawnApplication(['/usr/bin/node', 'desktop/tests/theme-file-writer.mjs', mode], '', 'theme-file-fixture');
  await until(() => exits.has(pid), 'theme file writer ' + mode);
  check(exits.get(pid) === 0, 'isolated theme file action: ' + mode);
}
async function marker(title) {
  const surface = window.create({ title, layer: 'overlay', width: 1, height: 1,
    anchors: ['top', 'right'], exclusiveZone: -1 });
  await until(() => surface.closed, title);
}
async function wallpaper() {
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await marker('fixture-bitmap-pixel 8 8 PollyShell.wallpaper.' + shell.getState().outputs[0]);
}
let shell;
async function run() {
  const [mode, executable] = application.arguments;
  shell = createDesktopShell().start();
  if (mode === 'initial') {
    desktop.spawnApplication(['foot', '--app-id=org.pollyui.window-fixture', '--title=Configurable theme',
      '/bin/sh', '-c', 'sleep 300'], '', 'theme-window-fixture');
    await until(() => desktop.windows().some(item => item.appId === 'org.pollyui.window-fixture' && item.active), 'native application');
    await write('create');
    check(shell.reloadThemes() && shell.selectTheme('file-theme'), 'user JSON loads without rebuilding any executable');
    await marker('fixture-frame-style 2 48 673ab7');
    await wallpaper();
    const subscriber = desktop.spawnApplication([executable, '--desktop', '--app-id', 'org.pollyui.theme-subscriber',
      'desktop/tests/theme-subscriber.mjs'], '', 'theme-subscriber');
    await until(() => desktop.windows().some(item => item.title === 'Theme subscriber ready'), 'ordinary theme subscriber');
    const applicationWindow = desktop.windows().find(item => item.appId === 'org.pollyui.window-fixture');
    desktop.activateWindow(applicationWindow.id);
    await until(() => desktop.windows().find(item => item.id === applicationWindow.id)?.active, 'restore application focus');
    await write('update');
    check(shell.reloadThemes(), 'explicit reload applies changed same-ID file');
    await marker('fixture-frame-style 2 56 28744d');
    await until(() => exits.has(subscriber), 'ordinary application theme update');
    check(exits.get(subscriber) === 0, 'public theme subscription works without Shell authority');
    await write('recolor');
    check(shell.reloadThemes(), 'a color-only edit applies without a geometry change');
    await marker('fixture-frame-style 2 56 245dc9');
    for (let i = 0; i < 10; i++) check(shell.reloadThemes(), 'repeated reload releases the previous bitmap ' + i);
    await wallpaper();
    await write('bad-image');
    check(!shell.reloadThemes(), 'invalid bitmap is rejected before committing a new appearance');
    await wallpaper();
    await write('recolor');
    await write('invalid');
    check(!shell.reloadThemes() && shell.getState().themeId === 'file-theme' && shell.getState().error,
      'invalid overrides keep the current theme and expose an error');
    await marker('fixture-frame-style 2 56 245dc9');
    await write('repair');
    await write('symlink');
    check(!shell.reloadThemes(), 'theme definitions cannot redirect through a symbolic link');
    await marker('fixture-frame-style 2 56 245dc9');
    await write('unsymlink');
    await write('details');
    check(shell.reloadThemes(), 'decoration and Shell layout parameters apply from the same file');
    await marker('fixture-frame-controls 20 8 10');
    const configuredPanel = JSON.parse(shell.getSurfaces().find(item => item.kind === 'panel').signature);
    check(configuredPanel.height === 34 && configuredPanel.exclusiveZone === 34,
      'configured menu-bar height updates both the surface and its reserved area');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const panel = shell.getSurfaces().find(item => item.kind === 'panel').window.document.getElementById('shell-panel');
    const dock = shell.getSurfaces().find(item => item.kind === 'dock').window.document.getElementById('shell-dock');
    check(panel.offsetHeight === 34 && dock.offsetWidth === 520, 'configured Shell geometry reaches native layout');
    check(shell.restoreThemes() && !shell.getState().themeFilesEnabled && shell.getState().themeId === 'xp',
      'restoring packaged data does not delete user configuration');
    await write('invalid');
  } else {
    check(!shell.getState().themeFilesEnabled && shell.getState().themeId === 'xp' && !shell.getState().error,
      'packaged-theme preference survives Shell restart and skips disabled invalid overrides');
    const target = desktop.windows().find(item => item.appId === 'org.pollyui.window-fixture');
    if (target) desktop.closeWindow(target.id);
  }
  await marker('fixture-success');
  shell.stop(); window.quit();
}
run().catch(error => {
  console.error('FAIL: ' + String(error) + '\n' + (error.stack || ''));
  shell?.stop(); window.quit();
});
