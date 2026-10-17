import { createDesktopShell } from './desktop/tests/configured-shell.mjs';
import { h, render } from './gui/sdk/js/reconciler.mjs';
import { openShellSettings } from './desktop/shell/settings-native.mjs';
import { openDbusClient } from './sysrt/sdk/js/dbus.mjs';
import { settingsEnvironment, settingsLaunchSpec } from './desktop/shared/settings-environment.mjs';
import { getDesktopTheme } from './desktop/shell/themes.mjs';
import { createSettingsClient, waitSettingsReply } from './desktop/client/settings.mjs';
import { runtimeBuild, buildLabel } from './desktop/client/settings-contract.mjs';
import { readPrivateConfigurationFile } from './desktop/shared/configuration-files.mjs';
import { decodeUtf8 } from './sysrt/sdk/js/encoding.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const [mode, executable, script] = application.arguments;
const surfaces = [], exits = new Map(), reports = [];
let shell, serial = 0, survivorPid = 0, queryClient = null;
const independent = {};
async function query(value) {
  return JSON.parse(await waitSettingsReply(queryClient.call({
    destination: 'org.pollyui.Settings.Test', path: '/org/pollyui/SettingsTest',
    interface: 'org.pollyui.SettingsTest1', member: 'Query' }, 's', [JSON.stringify(value)], 's', 5000)));
}
const startedAt = Date.now();
function diagnose(stage) {
  const network = typeof desktop.networkState === 'function' ? desktop.networkState() : null;
  const windows = desktop.windows().filter(item => item.title === 'Settings' ||
    item.appId === 'org.pollyui.settings-survivor').map(item => ({
      id: item.id, settings: item.title === 'Settings', survivor: item.appId === 'org.pollyui.settings-survivor',
      active: item.active, minimized: item.minimized,
    }));
  console.log('SETTINGS_FIXTURE_STATE: ' + JSON.stringify({
    stage, serial, elapsedMs: Date.now() - startedAt, running: shell?.getState().running,
    survivorPid, survivorExited: exits.has(survivorPid), survivorStatus: exits.get(survivorPid),
    settingsHandles: surfaces.filter(item => item.title === 'Settings').map(item => ({
      closed: item.window.closed,
      activeElement: item.window.closed ? '' : item.window.document.activeElement?.id || '',
    })), windows,
    network: network && { ready: network.ready, registered: network.registered,
      revision: network.revision, operation: network.operation, refreshing: network.refreshing,
      prompt: network.authentication?.id, kind: network.authentication?.kind },
    managed: surfaces.filter(item => !item.window.closed && item.title === 'Desktop control panel').map(item => {
      const document = item.window.document, submit = document.getElementById('shell-network-auth-submit');
      return { focus: document.activeElement?.id, submit: submit?.getBoundingClientRect() };
    }),
  }));
}
function check(value, message) {
  if (!value) throw new Error(message);
  console.log('PASS: ' + message);
}
async function until(predicate, message) {
  const deadline = Date.now() + 15000;
  while (!await predicate()) {
    if (Date.now() > deadline) {
      diagnose(message);
      throw new Error('Timed out: ' + message);
    }
    await delay(10);
  }
}
async function painted() {
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}
async function settledRect(read, message) {
  const deadline = Date.now() + 15000;
  let previous = null;
  for (;;) {
    await painted();
    const current = await read();
    if (previous && ['x', 'y', 'width', 'height'].every(key => current[key] === previous[key]))
      return current;
    if (Date.now() > deadline) {
      diagnose(message);
      throw new Error('Timed out: ' + message);
    }
    previous = current;
  }
}
async function signal(title) {
  const marker = window.create({ title, layer: 'overlay', width: 1, height: 1,
    anchors: ['top', 'right'], exclusiveZone: -1 });
  let closed = false;
  marker.onclose = () => { closed = true; };
  await until(() => closed, title);
}
async function click(id, owner = null) {
  await painted();
  const surface = surfaces.findLast(item => !item.window.closed && (!owner || item.window === owner) &&
    item.window.document.getElementById(id));
  if (!surface) {
    if (owner) throw new Error('Missing control in the requested native window: ' + id);
    return appClick(id);
  }
  const node = surface?.window.document.getElementById(id);
  check(node?.offsetWidth > 0, 'Settings native control laid out: ' + id);
  // Frame callbacks can themselves reposition a control; sample after that layout
  // has reached a subsequent frame, without retrying the physical gesture.
  let rect = await settledRect(() => node.getBoundingClientRect(), 'native control geometry: ' + id);
  const bounds = surface.window.document.body.getBoundingClientRect();
  for (let parent = node.parentNode; parent; parent = parent.parentNode) {
    if (parent.style.overflow !== 'scroll') continue;
    const viewport = parent.getBoundingClientRect();
    if (rect.y < viewport.y || rect.y + rect.height > viewport.y + viewport.height) {
      parent.scrollTop = Math.max(0, Number(parent.scrollTop) + rect.y - viewport.y);
      await painted(); rect = node.getBoundingClientRect();
    }
  }
  check(rect.y + rect.height / 2 >= bounds.y && rect.y + rect.height / 2 < bounds.y + bounds.height,
    'Settings native control is inside the viewport: ' + id);
  const verb = surface.layer ? 'fixture-click' : 'fixture-xdg-click';
  await signal(`${verb} ${++serial} ${Math.floor(rect.x + rect.width / 2)} ${Math.floor(rect.y + rect.height / 2)} 0 ${surface.title}`);
}
async function openSettingsFromPanel(panel) {
  await until(() => panel.window.document.getElementById('shell-panel-settings')?.offsetWidth > 0, 'Settings taskbar entry');
  const panelDocument = panel.window.document, gesture = [];
  const record = event => {
    let target = event.target;
    while (target && target.id !== 'shell-panel-settings') target = target.parentNode;
    if (!target) return;
    check(event.target.ownerDocument === panelDocument && event.currentTarget === panelDocument.body,
      'Settings entry receives native ' + event.type + ' in its own panel Document');
    gesture.push(event.type);
  };
  for (const type of ['mousedown', 'mouseup']) panelDocument.body.addEventListener(type, record);
  try {
    await click('shell-panel-settings', panel.window);
    await until(() => gesture.length >= 2, 'native Settings entry gesture delivered');
  } finally {
    for (const type of ['mousedown', 'mouseup']) panelDocument.body.removeEventListener(type, record);
  }
  check(gesture.join(',') === 'mousedown,mouseup', 'one native Settings entry press/release, without a retry');
  await until(() => shell.getSettingsState().connected, 'Shell-owned independent Settings handshake');
  check(shell.getSettingsState().pid > 0, 'native first-click activates the real owned Settings process');
}
async function appClick(id) {
  await until(async () => {
    if ((await query({ op: 'state' })).busy) return false;
    try { return (await query({ op: 'control', id })).enabled; } catch { return false; }
  }, 'independent Settings control ready: ' + id);
  await painted();
  let rect = await query({ op: 'control', id });
  await painted(); rect = await query({ op: 'control', id });
  check(rect.width > 0 && rect.height > 0, 'Independent Settings control laid out: ' + id);
  console.log('SETTINGS_CONTROL: ' + JSON.stringify({ id, ...rect }));
  await signal(`fixture-xdg-click ${++serial} ${Math.floor(rect.x + rect.width / 2)} ${Math.floor(rect.y + rect.height / 2)} 0 Settings`);
}
async function capture(settings, name) {
  await painted();
  if (settings === independent) await query({ op: 'capture', name: 'settings-' + mode + '-' + name + '.png' });
  else settings.capture(application.cacheDir + '/settings-' + mode + '-' + name + '.png');
}
async function network(settings) {
  const state = () => desktop.networkState();
  const idle = () => until(() => state().ready && !state().operation && !state().refreshing, 'private iwd operation');
  await appClick('shell-settings-page-network');
  await until(() => state().ready && state().registered && state().networks.length >= 13 &&
    state().networks[0]?.signal === -45, 'root-owned multi-network synthetic iwd');
  check((await query({ op: 'control', id: 'shell-network-connect-0-12' })).width > 0,
    'Settings mounts the real long iwd network list before delayed credentials');
  check((await query({ op: 'control', id: 'shell-network-settings' })).text.includes('wlan-test'),
    'Settings displays actual iwd adapter data');
  await capture(settings, 'network');
  await appClick('shell-network-scan-0'); await idle();
  await appClick('shell-network-connect-0-0'); await appClick('shell-network-confirm');
  await until(() => state().authentication, 'iwd credentials');
  await appClick('shell-network-auth-cancel'); await idle();
  await appClick('shell-network-connect-0-0'); await appClick('shell-network-confirm');
  await until(() => state().authentication, 'second iwd credentials');
  await appClick('shell-network-password');
  for (const code of [20, 18, 31, 20, 25, 30, 31, 31]) {
    check((await query({ op: 'state' })).activeElement === 'shell-network-password', 'native password owns keyboard focus');
    await signal('fixture-settings-key ' + ++serial + ' ' + code + ' 0');
  }
  check((await query({ op: 'control', id: 'shell-network-password' })).text === '\u2022'.repeat(8),
    'native Settings password is masked');
  const field = await query({ op: 'control', id: 'shell-network-password' });
  check(shell.selectTheme('bigsur'), 'native theme repaint while iwd credentials are entered');
  await until(async () => (await query({ op: 'state' })).appearance.themeId === 'bigsur', 'independent credential retheme');
  const retained = await query({ op: 'control', id: 'shell-network-password' });
  check(retained.nodeIdentity === field.nodeIdentity &&
    (await query({ op: 'state' })).activeElement === 'shell-network-password' && retained.text === '\u2022'.repeat(8),
    'same native iwd prompt keeps its mounted field, secret and focus across retheme');
  check(shell.selectTheme('xp'), 'restore native Settings theme without recreating credentials');
  await appClick('shell-network-auth-submit'); await idle();
  await until(() => state().networks[0].connected && state().networks[0].known, 'synthetic Wi-Fi connected');
  await capture(settings, 'network-connected');
  await appClick('shell-network-disconnect-0'); await idle();
  await appClick('shell-network-forget-0-0'); await appClick('shell-network-confirm'); await idle();
  await until(() => !state().networks[0].known, 'synthetic saved network forgotten');
  await appClick('shell-network-power-0'); await idle();
  await until(() => !state().devices[0].powered, 'synthetic radio off');
  await appClick('shell-network-power-0'); await idle();
  await until(() => state().devices[0].powered, 'synthetic radio on');
  const helper = executable.slice(0, executable.lastIndexOf('/')) + '/polly-iwd-test';
  const quit = desktop.spawnApplication([helper, 'quit'], '', 'settings-iwd-stop');
  await until(() => exits.has(quit) && !state().ready, 'synthetic iwd shutdown');
  check(exits.get(quit) === 0, 'all Settings Wi-Fi operations reached the isolated root-owned fixture');
  await capture(settings, 'network-unavailable');
}
async function audio(settings) {
  const node = name => desktop.audioState().nodes.find(item => item.name === name);
  await click('shell-settings-page-audio');
  await until(() => desktop.audioState().ready && node('Polly-Test-A')?.volume != null, 'private PipeWire endpoints');
  await until(async () => (await query({ op: 'state' })).text.includes('Volume: 100%'),
    'Settings shows native endpoint volume, not a default model');
  await capture(settings, 'audio');
  await click('shell-audio-lower-' + node('Polly-Test-A').id);
  await until(() => Math.abs(node('Polly-Test-A').volume - 0.9) < 0.01 &&
    shell.configuration.snapshot.audio, 'PipeWire volume echoed and saved');
  await click('shell-audio-mute-' + node('Polly-Test-Source').id);
  await until(() => node('Polly-Test-Source').muted &&
    shell.configuration.snapshot.audio.devices.some(item => item.name === 'Polly-Test-Source' && item.muted),
    'PipeWire microphone mute echoed and saved');
  await click('shell-audio-default-' + node('Polly-Test-B').id);
  await until(() => shell.configuration.snapshot.audio.preferredSink === 'Polly-Test-B',
    'PipeWire selected output echoed and saved');
  await capture(settings, 'audio-changed');
  check(desktop.audioState().defaultSink === node('Polly-Test-B').id, 'Settings uses existing native default-device policy');
}
async function snapBindings(beforeReset = null) {
  for (const [action, code, key] of [['tile-left', 35, 'h'], ['tile-right', 36, 'j'], ['restore-floating', 37, 'k']]) {
    await appClick('shell-shortcut-' + action);
    await until(() => surfaces.some(item => !item.window.closed &&
      item.title.startsWith('PollyShell.shortcut-recording.') && item.window.active), action + ' trusted capture');
    await signal('fixture-key 29 1'); await signal('fixture-key ' + code + ' 1');
    await signal('fixture-key ' + code + ' 0'); await signal('fixture-key 29 0');
    await until(() => desktop.shortcuts().some(binding => binding.action === action &&
      binding.key === key && binding.modifiers === 2), action + ' actual native binding');
    check(shell.configuration.snapshot.shortcuts.some(binding => binding.action === action &&
      binding.key === key && binding.modifiers === 2), action + ' saved after acknowledgement');
    const saved = JSON.parse(decodeUtf8(readPrivateConfigurationFile(application.configDir, 'shell-preferences.json')));
    check(saved.version === 4 && saved.shortcuts.some(binding => binding.action === action &&
      binding.key === key && binding.modifiers === 2), action + ' exact binding read back from the published native file');
    await appClick('shell-shortcut-disable-' + action);
    await until(() => desktop.shortcuts().some(binding => binding.action === action &&
      !binding.key && !binding.modifiers), action + ' actually disabled');
  }
  if (beforeReset) await beforeReset();
  await appClick('shell-shortcuts-reset');
  await until(() => ['tile-left', 'tile-right', 'restore-floating'].every(action =>
    desktop.shortcuts().some(binding => binding.action === action && binding.modifiers === 8 &&
      binding.key === ({ 'tile-left': 'Left', 'tile-right': 'Right', 'restore-floating': 'Down' })[action])),
  'all real snap defaults restored');
}
async function migration(output, firstPid, survivor) {
  await appClick('shell-settings-page-displays');
  await until(async () => (await query({ op: 'state' })).pageState.snapshot?.heads?.length === 2,
    'independent Settings reads the real native output snapshot');
  await capture(independent, 'displays');
  const firstHead = desktop.outputConfiguration().heads[0];
  await appClick('shell-output-' + firstHead.id + '-scale-up');
  await appClick('shell-output-apply');
  await until(() => desktop.outputConfiguration().pendingToken > 0 &&
    surfaces.some(item => !item.window.closed && item.title.startsWith('PollyShell.display-confirmation.')),
    'native apply opens only the small trusted Keep/Revert prompt');
  check(shell.configuration.snapshot.display === null, 'provisional display changes are not saved');
  await capture(independent, 'display-pending');
  await click('shell-output-keep');
  await until(() => !desktop.outputConfiguration().pendingToken && shell.configuration.snapshot.display !== null,
    'native Keep acknowledges and saves the exact display profile');
  check(desktop.outputConfiguration().heads.find(head => head.id === firstHead.id).scale === 1.25,
    'actual native scale changed through independent Settings');
  await capture(independent, 'display-kept');
  await audio(independent);
  await appClick('shell-settings-page-keyboard');
  await until(async () => (await query({ op: 'state' })).pageState.snapshot?.bindings?.length === 10,
    'independent Settings reads the real shortcut catalog');
  await capture(independent, 'keyboard');
  await appClick('shell-shortcut-minimize-window');
  await until(() => surfaces.some(item => !item.window.closed &&
    item.title.startsWith('PollyShell.shortcut-recording.') && item.window.active),
    'only the trusted shortcut-recording layer receives capture focus');
  const recording = surfaces.findLast(item => !item.window.closed && item.title.startsWith('PollyShell.shortcut-recording.'));
  check(!recording.window.document.getElementById('shell-shortcuts'), 'trusted recorder has no duplicate full Keyboard page');
  await signal('fixture-key 29 1'); await signal('fixture-key 50 1');
  await signal('fixture-key 50 0'); await signal('fixture-key 29 0');
  await until(() => desktop.shortcuts().some(binding => binding.action === 'minimize-window' &&
    binding.key === 'm' && binding.modifiers === 2), 'real native Ctrl+M is recorded and saved');
  await appClick('shell-shortcuts-reset');
  await until(() => desktop.shortcuts().some(binding => binding.action === 'minimize-window' && binding.key === 'F9'),
    'real shortcut defaults restored');
  await snapBindings();
  await appClick('shell-settings-page-about'); await capture(independent, 'about');
  check(!surfaces.some(item => item.title === 'Desktop control panel'), 'all complete pages remain in the one owned Settings process');
  await signal('fixture-settings-close ' + ++serial);
  await until(() => exits.has(firstPid), 'actual owned Settings close');
  await shell.showSystemSettings(output, 'audio');
  const reopened = shell.getSettingsState().pid;
  check(reopened !== firstPid, 'Settings reopens with a fresh owned PID/generation');
  await until(async () => (await query({ op: 'state' })).text.includes('Volume: 90%'), 'reopened page reads actual retained audio state');
  await capture(independent, 'reopened-audio');
  await signal('fixture-settings-close ' + ++serial);
  await until(() => exits.has(reopened), 'reopened Settings closes normally');
  check(!exits.has(survivor) && shell.getState().running, 'Settings close retains Shell policy and the independent survivor');
  const survivorView = desktop.windows().find(item => item.appId === 'org.pollyui.settings-survivor');
  desktop.closeWindow(survivorView.id); await until(() => exits.has(survivor), 'owned fixture survivor cleanup');
  check(reports.length === 0, 'migration smoke has no unexpected Shell errors');
  console.log('PASS: native Settings migration complete');
  await signal('fixture-success'); queryClient.close(); shell.stop(); window.quit();
}
async function run() {
  if (mode === 'survivor') {
    check(typeof desktop === 'object' && desktop.fileSystem &&
      Object.keys(desktop).length === 1 && Object.keys(desktop)[0] === 'fileSystem',
    'ordinary survivor has only the public file API, not desktop management');
    render(h('view', { style: { padding: 20 } }, 'Independent ordinary application'), document.body);
    setTimeout(() => window.quit(), 290000);
    return;
  }
  desktop.onExit = event => exits.set(event.pid, event.status);
  const environment = settingsEnvironment();
  queryClient = openDbusClient(environment.address);
  shell = createDesktopShell({ report: value => { reports.push(value); console.error(value); },
    settingsFactory: handlers => openShellSettings({ ...handlers, launchSpec: {
      argv: [executable, '--app-id', 'org.pollyui.settings', mode === 'ui-narrow' ?
        'desktop/tests/settings-narrow-probe.mjs' : 'desktop/tests/settings-probe.mjs', '--managed'],
      cwd: environmentPath(),
    } }), host: {
    close: () => window.close(), displays: () => window.displays(),
    create(options) {
      const result = window.create(options);
      surfaces.push({ window: result, title: options.title, layer: options.layer }); return result;
    },
  } }).start();
  const survivor = desktop.spawnApplication([executable, '--app-id', 'org.pollyui.settings-survivor', script, 'survivor'],
    '', 'settings-survivor');
  survivorPid = survivor;
  const output = shell.getState().outputs[0];
  if (mode === 'keyboard') {
    await shell.showSystemSettings(output, 'keyboard');
    await until(() => shell.getSettingsState().connected, 'owned Keyboard Settings handshake');
    await until(async () => (await query({ op: 'state' })).pageState.snapshot?.bindings?.length === 10,
      'independent Keyboard consumes the actual ten-action native catalog');
    const setter = desktop.setShortcuts;
    let commits = 0;
    desktop.setShortcuts = bindings => { commits++; return setter(bindings); };
    try { await snapBindings(async () => {
      const first = shell.getSettingsState().pid;
      const saved = JSON.parse(decodeUtf8(readPrivateConfigurationFile(application.configDir, 'shell-preferences.json')));
      const disabled = bindings => ['tile-left', 'tile-right', 'restore-floating'].every(action =>
        bindings.some(binding => binding.action === action && !binding.key && !binding.modifiers));
      check(disabled(saved.shortcuts), 'all three disabled bindings are present in the committed file');
      await signal('fixture-settings-close ' + ++serial);
      await until(() => exits.has(first) && !shell.getSettingsState().pid, 'first Keyboard process actually exits');
      await shell.showSystemSettings(output, 'keyboard');
      await until(() => shell.getSettingsState().connected && shell.getSettingsState().pid !== first,
        'Keyboard reopens in a fresh owned process');
      await until(async () => {
        const snapshot = (await query({ op: 'state' })).pageState.snapshot;
        return snapshot?.bindings?.length === 10 && disabled(snapshot.bindings);
      }, 'reopened independent Keyboard reads all three persisted disabled bindings');
      check(disabled(shell.configuration.snapshot.shortcuts), 'Settings reopen preserves the committed configuration');
    }); }
    finally { desktop.setShortcuts = setter; }
    check(commits === 7, 'three recordings, three disables and one reset each commit exactly once');
    const finalPid = shell.getSettingsState().pid;
    await signal('fixture-settings-close ' + ++serial);
    await until(() => exits.has(finalPid) && !shell.getSettingsState().pid, 'owned Keyboard Settings closes');
    await until(() => desktop.windows().some(item => item.appId === 'org.pollyui.settings-survivor'),
      'ordinary survivor maps');
    desktop.closeWindow(desktop.windows().find(item => item.appId === 'org.pollyui.settings-survivor').id);
    await until(() => exits.has(survivor), 'ordinary survivor cleanup');
    check(reports.length === 0, 'native Keyboard reports no unexpected errors');
    console.log('PASS: native Settings keyboard complete');
    await signal('fixture-success'); queryClient.close(); shell.stop(); window.quit(); return;
  }
  const panel = shell.getSurfaces().find(surface => surface.kind === 'panel' && surface.output === output);
  await until(() => desktop.windows().some(item => item.appId === 'org.pollyui.settings-survivor'),
    'ordinary survivor maps before the panel gesture');
  await openSettingsFromPanel(panel);
  await until(async () => {
    try { return (await query({ op: 'state' })).appearance !== null; } catch { return false; }
  }, 'independent Settings test probe');
  const settings = independent, firstPid = shell.getSettingsState().pid;
  const initial = await query({ op: 'state' });
  const expectedBuild = runtimeBuild(application), expectedLabel = buildLabel(expectedBuild);
  check(JSON.stringify(initial.appearance.build) === JSON.stringify(expectedBuild) &&
    initial.versionFooter === expectedLabel,
    'independent Settings shows the actual system version and source identity');
  console.log('SETTINGS_SYSTEM_BUILD=' + JSON.stringify(expectedBuild));
  check(firstPid !== environment.pid && initial.pid === firstPid &&
    initial.id === 'org.pollyui.settings' && initial.namespace === initial.id && initial.shellPreference === null &&
    initial.configDir !== application.configDir && initial.dataDir !== application.dataDir,
    'Settings owns a distinct native PID, realm, event loop and storage namespace');
  if (mode === 'migration') { await migration(output, firstPid, survivor); return; }
  const intruder = createSettingsClient(openDbusClient(environment.address));
  for (const [member, argument] of [['SelectTheme', 'bigsur'], ['ReloadThemes'], ['RestoreThemes'],
    ['OpenManagedPage', 'audio'], ['GetAppearance'], ['SelectTheme', JSON.stringify({ pid: firstPid, generation: 1 })]]) {
    let denied = false;
    try { await intruder.call(member, argument); } catch (error) { denied = /AccessDenied/.test(error.dbusName || ''); }
    check(denied, 'Unauthorized peer/fake identity cannot call ' + member);
  }
  intruder.close();
  await signal('fixture-settings-state ' + ++serial + ' 1');
  await capture(settings, 'appearance');
  panel.window.capture(application.cacheDir + '/settings-' + mode + '-taskbar.png');
  const launcher = shell.showApplications(output);
  await painted();
  await capture(launcher, 'launcher');
  launcher.close();
  await click('shell-theme-bigsur');
  await until(async () => {
    const state = await query({ op: 'state' });
    if (state.error) throw new Error(state.error);
    return shell.getState().themeId === 'bigsur';
  }, 'independent theme apply');
  check(shell.configuration.snapshot.theme.id === 'bigsur',
    'native theme choice changes the desktop and persists without closing Settings');
  let theme = getDesktopTheme('bigsur');
  await signal('fixture-settings-decoration ' + theme.window.borderWidth + ' ' + theme.window.titleHeight);
  await capture(settings, 'bigsur');
  await click('shell-theme-xp');
  await until(() => shell.getState().themeId === 'xp', 'independent theme restored');
  theme = getDesktopTheme('xp');
  await signal('fixture-settings-decoration ' + theme.window.borderWidth + ' ' + theme.window.titleHeight);
  await appClick('shell-theme-reload');
  await until(async () => !(await query({ op: 'state' })).busy, 'independent theme reload');
  await appClick('shell-theme-restore');
  await until(() => !shell.getState().themeFilesEnabled, 'independent packaged theme restore');
  const configure = desktop.configureAppearance;
  desktop.configureAppearance = () => { throw new Error('Synthetic appearance prepare failure'); };
  await appClick('shell-theme-bigsur');
  await until(async () => (await query({ op: 'state' })).error.includes('Synthetic appearance prepare failure'),
    'independent failed operation visibly reported');
  check(shell.getState().themeId === 'xp' && shell.configuration.snapshot.theme.id === 'xp',
    'failed independent write leaves the previous actual desktop and saved appearance');
  desktop.configureAppearance = configure;
  reports.length = 0;
  await appClick('shell-theme-modern');
  await until(() => shell.getState().themeId === 'modern', 'modern theme restored before page review');
  theme = getDesktopTheme('modern');
  await signal('fixture-settings-decoration ' + theme.window.borderWidth + ' ' + theme.window.titleHeight);
  for (const page of ['displays', 'network', 'audio', 'keyboard']) {
    await appClick('shell-settings-page-' + page);
    check((await query({ op: 'state' })).versionFooter === expectedLabel,
      'system build identity stays visible on independent ' + page + ' page');
    await capture(settings, 'page-' + page);
    if (page === 'network') {
      if (mode === 'network') await network(settings);
      else {
        await until(async () => (await query({ op: 'state' })).text.includes('org.freedesktop.DBus.Error.FileNotFound'),
          'missing isolated iwd is visible in the independent Settings document');
        check(!desktop.networkState().ready, 'missing isolated iwd never invents readiness');
      }
      await capture(settings, page);
      check(!surfaces.some(item => !item.window.closed && item.title === 'Desktop control panel'),
        'Network controls belong only to independent Settings, not a delegated Shell panel');
      continue;
    }
    const contentId = { displays: 'shell-displays', keyboard: 'shell-shortcuts', audio: 'shell-audio-settings' }[page];
    if (mode === 'audio' && page === 'audio') await audio(settings);
    else if (['displays', 'keyboard'].includes(page))
      await until(async () => (await query({ op: 'control', id: contentId })).width > 0,
        'independent Settings mounts actual ' + page + ' controls');
    await capture(settings, page);
    check(!surfaces.some(item => item.title === 'Desktop control panel'), 'no complete settings page is delegated to Shell');
  }
  await appClick('shell-settings-page-about');
  await until(async () => (await query({ op: 'state' })).about?.outputs === 2, 'actual About service/outputs snapshot');
  const aboutState = await query({ op: 'state' });
  check(aboutState.versionFooter === expectedLabel &&
    JSON.stringify(aboutState.about.build) === JSON.stringify(expectedBuild) &&
    aboutState.text.includes(expectedBuild.revision),
    'About shows the full actual revision while retaining the system version footer');
  await capture(settings, 'about');
  await appClick('settings-about-details'); await capture(settings, 'about-details');
  const starter = desktop.spawnApplication([executable, '--app-id', 'org.pollyui.settings',
    'desktop/apps/settings/main.mjs', 'about'], environmentPath(), 'settings-starter');
  await until(() => exits.has(starter), 'standalone entry presentation acknowledgement');
  check(exits.get(starter) === 0 && shell.getSettingsState().pid === firstPid &&
    (await query({ op: 'state' })).page === 'about', 'direct entry presents the same owned PID without duplicates');
  await appClick('shell-settings-page-appearance');
  await until(async () => (await query({ op: 'state' })).activeElement === 'shell-settings-page-appearance',
    'native appearance navigation focus');
  check((await query({ op: 'state' })).activeElement === 'shell-settings-page-appearance', 'native navigation owns document focus');
  await signal('fixture-settings-key ' + ++serial + ' 15 0');
  await until(async () => (await query({ op: 'state' })).activeElement === 'shell-settings-page-displays',
    'native Tab navigation focus');
  check((await query({ op: 'state' })).activeElement === 'shell-settings-page-displays', 'ordinary native Tab advances navigation');
  await signal('fixture-settings-key ' + ++serial + ' 28 0');
  await until(async () => (await query({ op: 'state' })).page === 'displays', 'native Enter activates Displays');
  check((await query({ op: 'state' })).page === 'displays', 'ordinary native Enter changes the actual Settings page');
  await signal('fixture-settings-key ' + ++serial + ' 15 1');
  await until(async () => (await query({ op: 'state' })).activeElement === 'shell-settings-page-appearance',
    'native Shift+Tab navigation focus');
  check((await query({ op: 'state' })).activeElement === 'shell-settings-page-appearance', 'ordinary native Shift+Tab reverses navigation');
  await signal('fixture-settings-key ' + ++serial + ' 28 0');
  await until(async () => (await query({ op: 'state' })).page === 'appearance', 'native Enter activates Appearance');
  check((await query({ op: 'state' })).page === 'appearance', 'ordinary native Enter activates current page');
  await capture(settings, 'keyboard-activated-appearance');
  await signal('fixture-settings-close ' + ++serial);
  await until(() => exits.has(firstPid), 'WM Settings actual process exit');
  diagnose('WM Settings onclose acknowledged');
  await signal('fixture-settings-state ' + ++serial + ' 0');
  check(shell.getState().running && !exits.has(survivor), 'Settings close keeps Shell and ordinary PID alive');
  const secondPanel = shell.getSurfaces().find(surface => surface.kind === 'panel' && surface.output !== output);
  check(secondPanel, 'another output has its own native Settings entry');
  await openSettingsFromPanel(secondPanel);
  const reopened = independent, reopenedPid = shell.getSettingsState().pid;
  check(reopenedPid !== firstPid, 'closed Settings reopens in a new owned PID/generation');
  await signal('fixture-settings-state ' + ++serial + ' 1');
  if (mode === 'audio') {
    await shell.showManagedSettings(output, 'audio');
    await until(async () => (await query({ op: 'state' })).text.includes('Volume: 90%'),
      'reopened independent Audio page shows the current persisted PipeWire volume');
  }
  await capture(reopened, 'reopened');
  await appClick('shell-settings-page-about');
  await signal('fixture-settings-key ' + ++serial + ' 1 0');
  await until(() => exits.has(reopenedPid), 'ordinary native Escape closes Settings process');
  await signal('fixture-settings-state ' + ++serial + ' 0');
  await shell.showSystemSettings(output);
  const finalPid = shell.getSettingsState().pid;
  await signal('fixture-settings-state ' + ++serial + ' 1');
  await signal('fixture-settings-close ' + ++serial); await until(() => exits.has(finalPid), 'Settings native caption close process exit');
  await signal('fixture-settings-state ' + ++serial + ' 0');
  check(reports.length === 0, 'native Settings has no unexpected Shell errors');
  await shell.showSystemSettings(output);
  const disconnectedPid = shell.getSettingsState().pid;
  await until(async () => (await query({ op: 'state' })).appearance !== null, 'Settings before daemon disconnect');
  const oldTheme = shell.getState().themeId;
  const killBus = desktop.spawnApplication(['/bin/sh', '-c', 'kill -TERM "$POLLY_SETTINGS_TEST_BUS_PID"'],
    environmentPath(), 'settings-test-private-bus-stop');
  await until(() => exits.has(killBus) && shell.getSettingsState().error, 'private daemon disconnect closes admission');
  await delay(2500);
  let staleRejected = false;
  try {
    const stale = createSettingsClient(queryClient);
    await stale.call('SelectTheme', 'bigsur');
  } catch { staleRejected = true; }
  check(staleRejected && shell.getState().themeId === oldTheme && !exits.has(disconnectedPid) &&
    shell.getSettingsState().pid === disconnectedPid && shell.getState().running,
    'daemon disconnect and stale closed calls never replay writes or restart Settings/Shell');
  await signal('fixture-settings-close ' + ++serial);
  await until(() => exits.has(disconnectedPid), 'disconnected Settings closes normally');
  const survivorView = desktop.windows().find(item => item.appId === 'org.pollyui.settings-survivor');
  check(survivorView, 'ordinary application survived both Settings close paths');
  desktop.closeWindow(survivorView.id);
  await until(() => exits.has(survivor), 'fixture-only survivor cleanup');
  check(exits.get(survivor) === 0, 'ordinary fixture exits normally');
  console.log('PASS: native Settings ' + mode + ' complete');
  await signal('fixture-success'); queryClient.close(); shell.stop(); window.quit();
}
function environmentPath() { return settingsLaunchSpec().cwd; }
run().catch(error => {
  console.error('FAIL: ' + String(error) + '\n' + (error.stack || ''));
  queryClient?.close(); shell?.stop(); window.quit();
});
