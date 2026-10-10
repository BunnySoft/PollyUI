import { createDesktopShell } from './desktop/shell/shell.mjs';
import { h, render } from './gui/sdk/js/reconciler.mjs';
import { settingsEnvironment, settingsLaunchSpec } from './desktop/shared/settings-environment.mjs';

const [mode, executable, script] = application.arguments;
const exits = new Map(), reports = [];
let shell = null, sequence = 0;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(value, message) { if (!value) throw new Error(message); console.log('PASS: ' + message); }
async function until(predicate, message) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Installed Settings deadline: ' + message);
    await delay(10);
  }
}
async function signal(title) {
  const marker = window.create({ title, layer: 'overlay', width: 1, height: 1,
    anchors: ['top', 'right'], exclusiveZone: -1 });
  await until(() => marker.closed, title);
}
async function run() {
  if (mode === 'survivor') {
    check(Object.keys(desktop).length === 1 && desktop.fileSystem, 'installed survivor has no Shell management');
    render(h('view', {}, 'Installed independent ordinary application'), document.body);
    return;
  }
  desktop.onExit = event => exits.set(event.pid, event.status);
  shell = createDesktopShell({ report: value => { reports.push(value); console.error(value); } }).start();
  const survivor = desktop.spawnApplication([executable, '--app-id', 'org.pollyui.settings-survivor', script, 'survivor'],
    settingsLaunchSpec().cwd, 'installed-settings-survivor');
  const output = shell.getState().outputs[0], environment = settingsEnvironment();
  const owned = await shell.showSystemSettings(output);
  check(owned > 0 && owned !== environment.pid, 'installed Shell launches production Settings in its own PID');
  await signal('fixture-settings-state ' + ++sequence + ' 1');
  const wrapper = executable.slice(0, executable.lastIndexOf('/')) + '/polly-settings';
  const starter = desktop.spawnApplication([wrapper, 'about'], '/tmp', 'installed-settings-starter');
  await until(() => exits.has(starter), 'relocated starter exits');
  check(exits.get(starter) === 0 && shell.getSettingsState().pid === owned && shell.getSettingsState().page === 'about',
    'installed polly-settings from unrelated cwd presents About in the same production process');
  await signal('fixture-settings-close ' + ++sequence);
  await until(() => exits.has(owned), 'installed Settings WM close');
  await signal('fixture-settings-state ' + ++sequence + ' 0');
  check(shell.getState().running && !exits.has(survivor), 'installed Settings close retains Shell and public application');
  const reopened = desktop.spawnApplication([wrapper, 'appearance'], '/', 'installed-settings-reopen');
  await until(() => exits.has(reopened), 'relocated reopen starter exits');
  const next = shell.getSettingsState().pid;
  check(exits.get(reopened) === 0 && next > 0 && next !== owned &&
    shell.getSettingsState().page === 'appearance', 'installed wrapper reopens a new owned generation without repository cwd');
  await signal('fixture-settings-state ' + ++sequence + ' 1');
  await signal('fixture-settings-close ' + ++sequence);
  await until(() => exits.has(next), 'installed reopened Settings close');
  check(reports.length === 0, 'relocated production Settings has no hidden startup/path errors');
  const view = desktop.windows().find(view => view.appId === 'org.pollyui.settings-survivor');
  desktop.closeWindow(view.id);
  await until(() => exits.has(survivor), 'installed survivor cleanup');
  console.log('PASS: native Settings installed complete');
  await signal('fixture-success'); shell.stop(); window.quit();
}
run().catch(error => {
  console.error('FAIL: ' + String(error) + '\n' + (error.stack || ''));
  shell?.stop(); window.quit();
});
