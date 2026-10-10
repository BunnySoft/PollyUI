import { createDesktopShell } from './desktop/tests/configured-shell.mjs';
import { h, render } from './gui/sdk/js/reconciler.mjs';
import { openShellSettings } from './desktop/shell/settings-native.mjs';
import { openDbusClient } from './sysrt/sdk/js/dbus.mjs';
import { settingsEnvironment, settingsLaunchSpec } from './desktop/shared/settings-environment.mjs';
import { getDesktopTheme } from './desktop/shell/themes.mjs';
import { createSettingsClient, waitSettingsReply } from './desktop/client/settings.mjs';

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
async function signal(title) {
  const marker = window.create({ title, layer: 'overlay', width: 1, height: 1,
    anchors: ['top', 'right'], exclusiveZone: -1 });
  let closed = false;
  marker.onclose = () => { closed = true; };
  await until(() => closed, title);
}
async function click(id) {
  await painted();
  const surface = surfaces.findLast(item => !item.window.closed && item.window.document.getElementById(id));
  if (!surface) return appClick(id);
  const node = surface?.window.document.getElementById(id);
  check(node?.offsetWidth > 0, 'Settings native control laid out: ' + id);
  let rect = node.getBoundingClientRect();
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
async function appClick(id) {
  await until(async () => !(await query({ op: 'state' })).busy, 'independent Settings idle');
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
  await click('shell-settings-page-network');
  await until(() => state().ready && state().registered && state().networks.length >= 13 &&
    state().networks[0]?.signal === -45, 'root-owned multi-network synthetic iwd');
  check(settings.document.getElementById('shell-network-connect-0-12'),
    'Settings mounts the real long iwd network list before delayed credentials');
  check(settings.document.getElementById('shell-network-settings').textContent.includes('wlan-test'),
    'Settings displays actual iwd adapter data');
  await capture(settings, 'network');
  await click('shell-network-scan-0'); await idle();
  await click('shell-network-connect-0-0'); await click('shell-network-confirm');
  await until(() => state().authentication, 'iwd credentials');
  await click('shell-network-auth-cancel'); await idle();
  await click('shell-network-connect-0-0'); await click('shell-network-confirm');
  await until(() => state().authentication, 'second iwd credentials');
  await click('shell-network-password');
  for (const code of [20, 18, 31, 20, 25, 30, 31, 31]) {
    check(settings.document.activeElement?.id === 'shell-network-password', 'native password owns keyboard focus');
    await signal('fixture-settings-managed-key ' + ++serial + ' ' + code + ' 0');
  }
  check(settings.document.getElementById('shell-network-password').textContent === '\u2022'.repeat(8),
    'native Settings password is masked');
  const field = settings.document.getElementById('shell-network-password');
  check(shell.selectTheme('bigsur'), 'native theme repaint while iwd credentials are entered');
  await painted();
  check(settings.document.getElementById('shell-network-password') === field &&
    settings.document.activeElement === field && field.textContent === '\u2022'.repeat(8),
    'same native iwd prompt keeps its mounted field, secret and focus across retheme');
  check(shell.selectTheme('xp'), 'restore native Settings theme without recreating credentials');
  await click('shell-network-auth-submit'); await idle();
  await until(() => state().networks[0].connected && state().networks[0].known, 'synthetic Wi-Fi connected');
  await capture(settings, 'network-connected');
  await click('shell-network-disconnect-0'); await idle();
  await click('shell-network-forget-0-0'); await click('shell-network-confirm'); await idle();
  await until(() => !state().networks[0].known, 'synthetic saved network forgotten');
  await click('shell-network-power-0'); await idle();
  await until(() => !state().devices[0].powered, 'synthetic radio off');
  await click('shell-network-power-0'); await idle();
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
  check(settings.document.getElementById('shell-audio-settings').textContent.includes('Volume: 100%'),
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
      argv: [executable, '--app-id', 'org.pollyui.settings', 'desktop/tests/settings-probe.mjs', '--managed'],
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
  const panel = shell.getSurfaces().find(surface => surface.kind === 'panel' && surface.output === output);
  await until(() => panel.window.document.getElementById('shell-panel-settings')?.offsetWidth > 0, 'Settings taskbar entry');
  await click('shell-panel-settings');
  await until(() => shell.getSettingsState().connected, 'Shell-owned independent Settings handshake');
  await until(async () => {
    try { return (await query({ op: 'state' })).appearance !== null; } catch { return false; }
  }, 'independent Settings test probe');
  const settings = independent, firstPid = shell.getSettingsState().pid;
  const initial = await query({ op: 'state' });
  check(firstPid !== environment.pid && initial.pid === firstPid &&
    initial.id === 'org.pollyui.settings' && initial.namespace === initial.id && initial.shellPreference === null &&
    initial.configDir !== application.configDir && initial.dataDir !== application.dataDir,
    'Settings owns a distinct native PID, realm, event loop and storage namespace');
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
  for (const page of ['displays', 'network', 'audio', 'keyboard']) {
    await appClick('shell-settings-page-' + page);
    await appClick('settings-open-managed-' + page);
    await until(() => surfaces.some(item => !item.window.closed && item.title === 'Desktop control panel'),
      'delegated desktop control panel');
    const managed = surfaces.findLast(item => !item.window.closed && item.title === 'Desktop control panel').window;
    const contentId = { displays: 'shell-displays', keyboard: 'shell-shortcuts',
      network: 'shell-network-settings', audio: 'shell-audio-settings' }[page];
    if (mode === 'network' && page === 'network') await network(managed);
    else if (mode === 'audio' && page === 'audio') await audio(managed);
    else if (['displays', 'keyboard'].includes(page)) check(managed.document.getElementById(contentId),
      'independent Settings delegates actual ' + page + ' controls');
    if (page === 'network' && mode !== 'network') {
      check(reports.length === 1 && reports[0].includes('no-system-bus'),
        'missing isolated iwd is explicitly reported without inventing readiness');
      reports.length = 0;
    }
    await capture(managed, page); managed.close();
    check(!exits.has(firstPid), 'Closing managed ' + page + ' panel retains independent Settings');
  }
  await appClick('shell-settings-page-about'); await capture(settings, 'about');
  await until(async () => (await query({ op: 'state' })).about?.outputs === 2, 'actual About service/outputs snapshot');
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
  await shell.showSystemSettings(output, 'appearance');
  const reopened = independent, reopenedPid = shell.getSettingsState().pid;
  check(reopenedPid !== firstPid, 'closed Settings reopens in a new owned PID/generation');
  await signal('fixture-settings-state ' + ++serial + ' 1');
  if (mode === 'audio') {
    const managed = shell.showManagedSettings(output, 'audio');
    check(managed.document.getElementById('shell-audio-settings').textContent.includes('Volume: 90%'),
      'reopened delegated panel shows the current persisted PipeWire volume');
    managed.close();
  }
  await capture(reopened, 'reopened');
  await appClick('shell-settings-page-about');
  await signal('fixture-settings-key ' + ++serial + ' 1 0');
  await until(() => exits.has(reopenedPid), 'ordinary native Escape closes Settings process');
  await signal('fixture-settings-state ' + ++serial + ' 0');
  await shell.showSystemSettings(output);
  const finalPid = shell.getSettingsState().pid;
  await signal('fixture-settings-state ' + ++serial + ' 1');
  await appClick('shell-system-settings-close'); await until(() => exits.has(finalPid), 'Settings Close button process exit');
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
