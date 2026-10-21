import { createDesktopShell } from './desktop/tests/configured-shell.mjs';
import { createSettingsFixtureClient } from './desktop/tests/settings-probe.mjs';

const [mode, executable, script] = application.arguments;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let shell;
function check(value, message) {
  if (!value) throw new Error(message);
  console.log('PASS: ' + message);
}
async function until(predicate, message) {
  const deadline = Date.now() + 15000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('Cube deadline: ' + message);
    await delay(10);
  }
}
if (mode === 'app') {
  check(Object.keys(desktop).length === 1 && desktop.fileSystem, 'cube source has no management authority');
  const source = window.create({ title: 'Cube.Source.' + executable, width: 320, height: 240 });
  source.document.body.style.backgroundColor = ['#ff0000', '#00ff00', '#0000ff', '#ffff00'][Number(executable)];
  source.onclose = () => { window.quit(); };
  window.close();
} else {
  run().catch(error => {
    console.error('FAIL: ' + error + '\n' + error.stack);
    shell?.stop(); window.quit();
  });
}
async function run() {
  const reports = [];
  async function signal(title) {
    const marker = window.create({ title, layer: 'overlay', width: 1, height: 1,
      anchors: ['top', 'right'], exclusiveZone: -1 });
    await until(() => marker.closed, title);
  }
  async function key(code, down) { await signal('fixture-key ' + code + ' ' + (down ? 1 : 0)); }
  async function tap(code) { await key(code, true); await key(code, false); }
  const settings = createSettingsFixtureClient(signal);
  shell = createDesktopShell({ settingsFactory: settings.factory,
    report: message => { reports.push(message); console.error('CUBE_REPORT: ' + message); } }).start();
  const workspaces = desktop.workspaces().slice().sort((a, b) => a.order - b.order);
  const current = () => desktop.workspaces().find(item => item.active).id;
  const cube = () => desktop.workspaceCubeState();
  const source = index => desktop.windows().find(item => item.title === 'Cube.Source.' + index);
  check(cube().available && workspaces.length === 4, 'paired GLES and four existing workspaces are available');
  if (mode === 'initial') {
    await shell.showSystemSettings(shell.getState().outputs[0]);
    await settings.click('settings-cube-on');
    await until(() => cube().enabled, 'actual Settings enables workspace cube');
    await settings.click('settings-cube-still');
    await until(() => cube().motion === false, 'actual Settings selects still cube poses');
    await settings.click('settings-cube-animate');
    await until(() => cube().motion, 'actual Settings selects bounded rotation');
    await settings.close();
  } else {
    check(shell.configuration.snapshot.theme.workspaceCube.enabled && !cube().motion,
      'cube enabled/still preference survives a new Shell PID');
  }
  for (let index = 0; index < 4; index++) {
    desktop.spawnApplication([executable, '--app-id', 'org.pollyui.cube-' + index,
      script, 'app', String(index)], '', 'cube-' + index);
    await until(() => !!source(index) && source(index).active, 'real source ' + index + ' mapped');
    desktop.fullscreenWindow(source(index).id);
    await until(() => source(index).fullscreen, 'real source fullscreen');
    desktop.moveWindowToWorkspace(source(index).id, workspaces[index].id);
    await until(() => source(index).workspaceId === workspaces[index].id, 'source moved without workspace activation');
  }
  desktop.activateWindow(source(0).id);
  await until(() => source(0).active && current() === workspaces[0].id, 'original workspace and focus established');
  const original = source(0).id;
  async function begin() {
    await key(29, true); await key(125, true); await tap(106);
    await until(() => cube().active && cube().selected === 1, 'native cube selects second workspace');
    await delay(240);
    await signal('fixture-cube-ready 00ff00');
  }
  async function release() { await key(125, false); await key(29, false); }
  await begin();
  check(current() === workspaces[0].id && desktop.windows().find(item => item.active)?.id === original,
    'cube browsing samples hidden workspace without activating it or changing focus');
  if (mode === 'initial') {
    await signal('fixture-cube-transition');
    await until(() => cube().selected === 2, 'native transition advances to third face');
    await tap(105);
    await until(() => cube().selected === 1, 'reverse transition returns to second face');
    await delay(240);
  }
  await signal('fixture-cube-idle');
  await tap(1); await release();
  await until(() => !cube().active, 'Escape retires cube recipients');
  check(current() === workspaces[0].id && source(0).active, 'Escape preserves original workspace and focus');
  await begin(); await release();
  await until(() => !cube().active && current() === workspaces[1].id && source(1).active,
    'modifier release commits selected workspace and actual focus');
  desktop.activateWindow(source(0).id);
  await until(() => current() === workspaces[0].id, 'return to first workspace for pointer selection');
  await begin();
  await signal('fixture-cube-pointer'); await release();
  await until(() => !cube().active && current() === workspaces[1].id && source(1).active,
    'native depth-consistent pointer selection commits the visible workspace');
  await key(29, true); await key(125, true); await tap(106);
  await until(() => cube().active && cube().selected === 2, 'forward browse reaches third workspace');
  await delay(240); await signal('fixture-cube-ready 0000ff');
  await tap(106);
  await until(() => cube().selected === 3, 'forward browse reaches fourth workspace');
  await delay(240); await signal('fixture-cube-ready ffff00');
  await tap(106);
  await until(() => cube().selected === 0, 'cube wraps across the shared fourth/first edge');
  await delay(240); await signal('fixture-cube-ready ff0000');
  await tap(105);
  await until(() => cube().selected === 3, 'reverse browse wraps to fourth workspace');
  await tap(1); await release();
  check(current() === workspaces[1].id, 'multi-step cancellation keeps original second workspace');
  desktop.activateWindow(source(0).id);
  await until(() => current() === workspaces[0].id, 'first workspace restored');
  await begin();
  await signal('fixture-desktop-lock-long');
  await until(() => !cube().active, 'real session lock releases hidden-workspace samples');
  await release();
  await signal('fixture-desktop-unlocked');
  check(current() === workspaces[0].id, 'lock cancellation never commits the pending workspace');
  if (mode === 'initial') {
    await begin();
    await signal('fixture-cube-remove-output');
    await until(() => !cube().active && shell.getState().outputs.length === 1,
      'output removal cancels selection and releases all cube recipients');
    await release();
    check(current() === workspaces[0].id, 'output removal does not activate the pending workspace');
  }
  check(shell.setWorkspaceCube({ enabled: true, motion: false }), 'still cube policy saved for restart');
  for (const item of desktop.windows().filter(item => item.appId.startsWith('org.pollyui.cube-')))
    desktop.closeWindow(item.id);
  await until(() => !desktop.windows().some(item => item.appId.startsWith('org.pollyui.cube-')), 'cube source clients retire');
  await until(() => !shell.getState().materialError &&
    shell.getSurfaces().filter(surface => surface.kind === 'panel').every(surface => surface.backdropActive),
  'regional taskbar material is actually re-registered after fullscreen sources and output retirement');
  check(reports.every(message => message.startsWith('[shell] Application exited: cube-') ||
    message === '[shell] Shell taskbar backdrop retired; solid material required'),
    'cube lifecycle has no unexpected diagnostics');
  console.log('PASS: native workspace cube ' + mode + ' complete');
  await signal('fixture-success'); shell.stop(); window.quit();
}
