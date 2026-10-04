import { createApplicationLauncher } from './desktop/shell/applications.mjs';
const [mode, helper, result, work] = application.arguments;
function check(value, message) {
  if (!value) throw new Error(message);
  console.log('PASS: ' + message);
}
if (mode === 'survive') {
  desktop.spawnApplication([helper, result, '--later'], work, 'survive.desktop');
  window.close();
} else {
  let exited = false, echoed = false;
  desktop.onExit = event => {
    try {
      if (event.id === 'echo.desktop') {
        check(event.status === 0, 'expanded application arguments reached the process');
        echoed = true;
      }
      if (event.id === 'exit.desktop') {
        check(event.status === 23, 'application exit status is reported');
        exited = true;
      }
      if (exited && echoed) window.close();
    } catch (error) { console.error('FAIL: ' + error); window.quit(); }
  };
  try {
    const launcher = createApplicationLauncher(desktop);
    const entries = launcher.refresh();
    check(entries.some(entry => entry.name === '本地化 %u'), 'native files and locale selection');
    check(!entries.some(entry => entry.id === 'hidden.desktop'), 'user override masks system entry');
    check(entries.some(entry => entry.id === 'Utilities-tool.desktop'), 'recursive desktop-file IDs');
    check(entries.find(entry => entry.id === 'bus.desktop').unavailable, 'D-Bus-only entry is explicitly unavailable');
    check(launcher.launch('echo.desktop') > 0, 'desktop Exec launches a direct argument vector');
    let rejected = false;
    try { desktop.spawnApplication(['/nonexistent/polly-app'], '', 'missing.desktop'); } catch { rejected = true; }
    check(rejected, 'exec failure is synchronous');
    rejected = false;
    try { desktop.spawnApplication([work + '/broken-program'], '', 'broken.desktop'); } catch { rejected = true; }
    check(rejected, 'helper reports kernel exec failure instead of success');
    rejected = false;
    try { desktop.spawnApplication([helper, 'bad\0value'], '', 'bad.desktop'); } catch { rejected = true; }
    check(rejected, 'native launch rejects NUL arguments');
    desktop.spawnApplication([helper, result, '--exit23'], work, 'exit.desktop');
    setTimeout(() => { if (!exited || !echoed) { console.error('FAIL: application exit was not reported'); window.quit(); } }, 5000);
  } catch (error) { console.error('FAIL: ' + error); window.quit(); }
}
