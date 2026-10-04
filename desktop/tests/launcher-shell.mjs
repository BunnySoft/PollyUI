import { createDesktopShell } from './desktop/shell/shell.mjs';
let finish;
const exited = new Promise(resolve => { finish = resolve; });
desktop.onExit = event => { if (event.id === 'launch-fixture.desktop') finish(event); };
const shell = createDesktopShell().start();
async function run() {
  const menu = shell.showApplications(shell.getState().outputs[0]);
  if (!menu || !menu.document.getElementById('shell-app-launch-fixture.desktop'))
    throw new Error('Application entry missing from the real shell menu');
  const pid = shell.launchApplication('launch-fixture.desktop');
  if (!(pid > 0)) throw new Error('Application did not start');
  const timeout = setTimeout(() => finish({ status: -1 }), 8000);
  const result = await exited;
  clearTimeout(timeout);
  if (result.status !== 0) throw new Error('Launched application did not exit cleanly: ' + result.status);
  shell.stop();
  console.log('PASS: real Shell application launch complete');
}
run().catch(error => {
  console.error('FAIL: ' + String(error) + '\n' + (error.stack || ''));
  shell.stop();
  window.quit();
});
