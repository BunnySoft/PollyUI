import { createDesktopShell } from './desktop/tests/configured-shell.mjs';
import { createApplicationLauncher } from './desktop/shell/applications.mjs';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let shell;
const created = [], exits = new Map();
async function until(predicate, name) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out: ' + name);
    await delay(10);
  }
}
async function marker(title) {
  const surface = window.create({title,layer:'overlay',width:1,height:1,anchors:['top','right'],exclusiveZone:-1});
  await until(() => surface.closed, title);
}
async function run() {
  desktop.onExit = event => exits.set(event.id, event.status);
  shell = createDesktopShell({host: {close: () => window.close(),displays: () => window.displays(),
    create(options) { const surface = window.create(options); created.push({title:options.title,window:surface}); return surface; }}}).start();
  const id = 'bundle:org.example.shelltest';
  const entry = createApplicationLauncher(desktop).refresh().find(entry => entry.id === id);
  if (!entry || entry.name !== 'Bundle launch fixture' || entry.unavailable) throw new Error('Managed catalog entry missing');
  const menu = shell.showApplications(shell.getState().outputs[0]);
  const surface = created.find(item => item.window === menu);
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const button = menu.document.getElementById('shell-app-' + id);
  if (!button) throw new Error('Managed application is not visible in Apps');
  const rect = button.getBoundingClientRect();
  await marker(`fixture-click 1 ${Math.floor(rect.x+rect.width/2)} ${Math.floor(rect.y+rect.height/2)} 0 ${surface.title}`);
  await until(() => desktop.windows().some(app => app.title === 'Managed bundle public window'), 'public application window');
  await until(() => exits.has(id), 'managed application exit');
  if (exits.get(id) !== 0) throw new Error('Managed application exited unsuccessfully');
  const terminal = 'bundle:org.example.foot';
  createApplicationLauncher(desktop).launch(terminal);
  await until(() => desktop.windows().some(app => app.appId === 'org.example.foot'), 'managed third-party Wayland terminal');
  await until(() => exits.has(terminal), 'third-party terminal exit');
  if (exits.get(terminal) !== 0) throw new Error('Third-party managed application exited unsuccessfully');
  console.log('PASS: managed bundle launches through the native Shell catalog');
  await marker('fixture-success');
  shell.stop(); window.quit();
}
run().catch(error => { console.error('FAIL: ' + String(error)); shell?.stop(); window.quit(); });
