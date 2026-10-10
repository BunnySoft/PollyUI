import { createDesktopShell } from './desktop/shell/shell.mjs';
import { h, render } from './gui/sdk/js/reconciler.mjs';
import { AUDIO_PREFERENCES_KEY } from './desktop/shell/audio-preferences.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const [mode, executable, script] = application.arguments;
const surfaces = [], exits = new Map(), reports = [];
let shell, serial = 0, survivorPid = 0;
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
  while (!predicate()) {
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
async function capture(settings, name) {
  await painted();
  settings.capture(application.cacheDir + '/settings-' + mode + '-' + name + '.png');
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
    await signal('fixture-settings-key ' + ++serial + ' ' + code + ' 0');
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
    localStorage.getItem(AUDIO_PREFERENCES_KEY), 'PipeWire volume echoed and saved');
  await click('shell-audio-mute-' + node('Polly-Test-Source').id);
  await until(() => node('Polly-Test-Source').muted &&
    JSON.parse(localStorage.getItem(AUDIO_PREFERENCES_KEY)).devices.some(item => item.name === 'Polly-Test-Source' && item.muted),
    'PipeWire microphone mute echoed and saved');
  await click('shell-audio-default-' + node('Polly-Test-B').id);
  await until(() => JSON.parse(localStorage.getItem(AUDIO_PREFERENCES_KEY)).preferredSink === 'Polly-Test-B',
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
    setTimeout(() => window.quit(), 65000);
    return;
  }
  desktop.onExit = event => exits.set(event.pid, event.status);
  shell = createDesktopShell({ report: value => { reports.push(value); console.error(value); }, host: {
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
  const settings = surfaces.findLast(item => item.title === 'Settings').window;
  await signal('fixture-settings-state ' + ++serial + ' 1');
  await capture(settings, 'appearance');
  await click('shell-theme-bigsur');
  check(shell.getState().themeId === 'bigsur' && localStorage.getItem('desktop.theme') === 'bigsur' && !settings.closed,
    'native theme choice changes the desktop and persists without closing Settings');
  await capture(settings, 'bigsur');
  await click('shell-theme-xp');
  for (const page of ['displays', 'keyboard', 'about', 'appearance']) {
    await click('shell-settings-page-' + page); await capture(settings, page);
  }
  if (mode === 'network') await network(settings);
  else if (mode === 'audio') await audio(settings);
  else check(mode === 'ui', 'known native Settings fixture mode');
  await click('shell-settings-page-appearance');
  check(settings.document.activeElement?.id === 'shell-settings-page-appearance', 'native navigation owns document focus');
  await signal('fixture-settings-key ' + ++serial + ' 15 0');
  check(settings.document.activeElement?.id === 'shell-settings-page-displays', 'ordinary native Tab advances navigation');
  await signal('fixture-settings-key ' + ++serial + ' 15 1');
  check(settings.document.activeElement?.id === 'shell-settings-page-appearance', 'ordinary native Shift+Tab reverses navigation');
  await signal('fixture-settings-key ' + ++serial + ' 28 0');
  check(settings.document.getElementById('shell-theme-xp') && !settings.closed, 'ordinary native Enter activates current page');
  await capture(settings, 'keyboard-activated-appearance');
  let wmClosed = false;
  const previousClose = settings.onclose;
  settings.onclose = () => { wmClosed = true; previousClose?.(); };
  await signal('fixture-settings-close ' + ++serial);
  await until(() => wmClosed, 'WM Settings actual onclose');
  diagnose('WM Settings onclose acknowledged');
  await signal('fixture-settings-state ' + ++serial + ' 0');
  check(shell.getState().running && !exits.has(survivor), 'Settings close keeps Shell and ordinary PID alive');
  const reopened = shell.showSystemSettings(output, mode === 'audio' ? 'audio' : 'appearance');
  await signal('fixture-settings-state ' + ++serial + ' 1');
  if (mode === 'audio') check(reopened.document.getElementById('shell-audio-settings').textContent.includes('Volume: 90%'),
    'reopened Settings shows the current persisted PipeWire volume');
  await capture(reopened, 'reopened');
  let escapeClosed = false;
  const beforeEscape = reopened.onclose;
  reopened.onclose = () => { escapeClosed = true; beforeEscape?.(); };
  await click('shell-settings-page-about');
  await signal('fixture-settings-key ' + ++serial + ' 1 0');
  await until(() => escapeClosed, 'ordinary native Escape closes Settings');
  await signal('fixture-settings-state ' + ++serial + ' 0');
  const final = shell.showSystemSettings(output);
  await signal('fixture-settings-state ' + ++serial + ' 1');
  let buttonClosed = false;
  const beforeButton = final.onclose;
  final.onclose = () => { buttonClosed = true; beforeButton?.(); };
  await click('shell-system-settings-close'); await until(() => buttonClosed, 'Settings Close button actual onclose');
  await signal('fixture-settings-state ' + ++serial + ' 0');
  check(reports.length === 0, 'native Settings has no unexpected Shell errors');
  const survivorView = desktop.windows().find(item => item.appId === 'org.pollyui.settings-survivor');
  check(survivorView, 'ordinary application survived both Settings close paths');
  desktop.closeWindow(survivorView.id);
  await until(() => exits.has(survivor), 'fixture-only survivor cleanup');
  check(exits.get(survivor) === 0, 'ordinary fixture exits normally');
  console.log('PASS: native Settings ' + mode + ' complete');
  await signal('fixture-success'); shell.stop(); window.quit();
}
run().catch(error => {
  console.error('FAIL: ' + String(error) + '\n' + (error.stack || ''));
  shell?.stop(); window.quit();
});
