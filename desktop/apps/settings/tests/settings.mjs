import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
register('../../../tests/root-loader.mjs', import.meta.url);
const { BUILTIN_THEME_CATALOG } = await import('./desktop/shell/themes.mjs');
const { parseAppearance, parseAbout, SETTINGS_APP_ID, runtimeBuild, buildLabel } = await import('./desktop/client/settings-contract.mjs');
const { createSettingsController } = await import('./desktop/apps/settings/logic/controller.mjs');
const { createSettingsService } = await import('./desktop/shell/settings-service.mjs');
const { createSettingsNetworkClient } = await import('./desktop/apps/settings/network-client.mjs');
const { parseSettingsNetwork, parseSettingsNetworkAction, parseSettingsNetworkAuthentication } =
  await import('./desktop/client/settings-network-contract.mjs');
const { settingsView } = await import('./desktop/shell/views.mjs');
const { createSettingsApp } = await import('./desktop/apps/settings/app.mjs');
const { createDisplayPage } = await import('./desktop/apps/settings/ui/display-page.mjs');
const { applicationHost, deliver } = await import('./desktop/tests/application-host.mjs');
const { createSettingsDomains } = await import('./desktop/shell/settings-domains.mjs');
const { createAudioPolicy } = await import('./desktop/shell/audio-policy.mjs');
const { createShortcutRecorder } = await import('./desktop/shell/shortcut-recorder.mjs');
const { createDisplayPersistence } = await import('./desktop/shell/display-profiles.mjs');
const { parseDisplays, parseAudio, parseKeyboard, displayDraft } = await import('./desktop/client/settings-domains-contract.mjs');
const { fixtureShortcuts } = await import('./desktop/tests/configuration-memory.mjs');
const appearance = () => ({ version: 1, revision: 1, catalogRevision: 1, themeId: 'xp',
  catalog: BUILTIN_THEME_CATALOG, themeFilesEnabled: true, themeFilesAvailable: true, status: '', error: '', build: runtimeBuild() });
const about = () => ({ version: 1, services: { inputMethod: 'disabled', audio: 'ready', message: '', error: '' },
  outputs: 2, themeId: 'xp', applicationId: 'org.pollyui.shell', build: runtimeBuild(),
  profiles: { display: 'Confirmed layout saved', audio: 'Saved audio profile', workspace: 'Saved workspace profile' } });
const tick = () => new Promise(resolve => setTimeout(resolve, 20));
const deviceId = '/net/connman/iwd/0/1', networkId = deviceId + '/test_psk';
const networkState = () => ({ version: 1, ready: true, registered: true, refreshing: false, revision: 3,
  operationId: 0, error: '', operation: '', target: '', networkConfiguration: true,
  devices: [{ id: deviceId, name: 'fixture', address: '', state: 'disconnected', mode: 'station',
    powered: true, scanning: false, station: true, connectedNetwork: '' }],
  networks: [{ id: networkId, device: deviceId, name: 'Fixture', type: 'psk', known: false,
    connected: false, signal: -45, order: 0 }], authentication: null });
test('Settings Wi-Fi boundary strictly validates business state and bounded fixed commands, never executable data', () => {
  assert.equal(parseSettingsNetwork(JSON.stringify(networkState())).networks[0].signal, -45);
  for (const change of [
    value => { value.extra = 'ignored?'; }, value => { value.operation = 'shell-exec'; },
    value => { value.devices[0].powered = 'true'; }, value => { value.networks[0].device = '/foreign'; },
    value => { value.networks[0].signal = 1; }, value => { value.devices.push(value.devices[0]); },
    value => { value.authentication = { id: 1, kind: 'passphrase', network: networkId, username: '', password: 'secret' }; },
  ]) {
    const value = networkState(); change(value);
    assert.throws(() => parseSettingsNetwork(JSON.stringify(value)));
  }
  assert.throws(() => parseSettingsNetworkAction(JSON.stringify({ revision: 1, target: networkId, action: 'exec' })));
  assert.throws(() => parseSettingsNetworkAuthentication(JSON.stringify({ token: 1, user: '', password: 'x'.repeat(1025) })));
});
test('independent Wi-Fi adapter reads actual reopen state and reports a failed request without write replay or retained credentials', async () => {
  const calls = [], reports = [];
  let state = networkState(), fail = false;
  const client = { async call(member, argument) {
    calls.push([member, argument]);
    if (member === 'DetachNetwork') return;
    if (member === 'NetworkAction') {
      if (fail) throw new Error('org.freedesktop.DBus.Error.AccessDenied');
      const action = JSON.parse(argument);
      state = { ...state, revision: state.revision + 1,
        devices: state.devices.map(device => ({ ...device, powered: action.action === 'power-on' })) };
    }
    return JSON.stringify(state);
  } };
  const first = createSettingsNetworkClient(client, value => reports.push(value));
  try {
    first.startNetwork(); await tick();
    first.networkAction(state.revision, deviceId, 'power-off');
    assert.equal(calls.at(-1)[0], 'NetworkAction', 'send is immediate, never queued behind a later detach');
    await tick();
    assert.equal(first.networkState().devices[0].powered, false);
    first.stopNetwork();
    const second = createSettingsNetworkClient(client, value => reports.push(value));
    try {
      second.startNetwork(); await tick();
      assert.equal(second.networkState().devices[0].powered, false);
      fail = true; second.networkAction(state.revision, deviceId, 'power-on'); await tick();
      assert.equal(second.networkState().ready, false);
      assert.equal(second.networkState().authentication, null);
      assert.match(second.networkState().error, /AccessDenied/);
      await second.refresh();
      assert.equal(calls.filter(([member]) => member === 'NetworkAction').length, 2);
      assert.equal(reports.length, 1);
    } finally { second.close(); }
  } finally { first.close(); }
});
test('standalone Settings mounts Network in its own document, preserves masked prompts on retheme and retires them on navigation', async t => {
  const host = applicationHost(t), calls = [], reports = [];
  let wifi = networkState(), appearanceState = appearance();
  const client = { async call(member, argument) {
    calls.push(member);
    if (member === 'GetAppearance') return JSON.stringify(appearanceState);
    if (member === 'GetAbout') return JSON.stringify(about());
    if (member === 'DetachNetwork') { wifi = { ...wifi, authentication: null, operation: '' }; return; }
    if (member === 'NetworkAction') {
      const { action, target } = JSON.parse(argument);
      wifi = { ...wifi, operation: action, target, operationId: 1,
        authentication: { id: 88, kind: 'passphrase', network: target, username: '' } };
    }
    return JSON.stringify(wifi);
  }, close() {} };
  const app = createSettingsApp({ client, host, page: 'network', report: value => reports.push(value) }).start();
  t.after(() => app.stop());
  await tick();
  const document = app.getWindow().document, find = id => document.getElementById(id);
  assert.ok(find('shell-network-settings')); assert.equal(find('settings-open-managed-network'), null);
  assert.equal(host.windows.length, 1); assert.equal(host.windows[0].layer, undefined);
  await deliver(find('shell-network-connect-0-0')); await deliver(find('shell-network-confirm')); await tick();
  const password = find('shell-network-password');
  assert.ok(password); await deliver(password, 'textinput', { data: 'testpass' });
  assert.equal(password.textContent, '\u2022'.repeat(8));
  appearanceState = { ...appearanceState, themeId: 'bigsur' };
  await app.controller.refresh();
  assert.equal(find('shell-network-password'), password);
  assert.equal(document.activeElement, password); assert.equal(password.textContent, '\u2022'.repeat(8));
  await app.present('about'); await tick();
  assert.equal(find('shell-network-password'), null);
  assert.ok(calls.includes('DetachNetwork')); assert.ok(!calls.includes('OpenManagedPage'));
  await app.present('network'); await tick();
  assert.ok(find('shell-network-settings')); assert.equal(find('shell-network-password'), null);
  assert.deepEqual(reports, []);
});
function domainFixture(t) {
  const host = applicationHost(t), errors = [], calls = [], owner = {};
  host.displays = () => [{ id: 1, width: 1280, height: 720 }];
  const clone = value => JSON.parse(JSON.stringify(value));
  let bindings = clone(fixtureShortcuts);
  const output = { serial: 1, pendingToken: 0, remainingMs: 0, outcome: 0, message: '', heads: [
    { id: 1, name: 'DP-1', description: 'Fixture display', make: 'Fixture', model: 'Screen', serialNumber: 'one',
      enabled: true, width: 1280, height: 720, refresh: 60000, x: 0, y: 0, scale: 1, transform: 0, adaptiveSync: false,
      modes: [{ width: 1280, height: 720, refresh: 60000, preferred: true }] },
  ] };
  const sound = { ready: true, revision: 1, generation: 1, error: '', defaultSink: 10, defaultSource: 11,
    preferredSink: '', preferredSource: '', nodes: [
      { id: 10, revision: 1, instance: '100', name: 'speaker', description: 'Private speaker',
        class: 'Audio/Sink', state: 'idle', volume: 1, muted: false },
      { id: 11, revision: 1, instance: '101', name: 'microphone', description: 'Private microphone',
        class: 'Audio/Source', state: 'idle', volume: null, muted: null },
    ] };
  let saved = { audio: null, display: null, shortcuts: null };
  const configuration = { get snapshot() { return saved; }, update(value) {
    calls.push(['save', Object.keys(value)[0]]); saved = { ...saved, ...clone(value) };
  } };
  const native = {
    audioAvailable: true, startAudio() { calls.push(['audio-start']); }, stopAudio() { calls.push(['audio-stop']); },
    audioState: () => clone(sound),
    setAudioVolume: (...args) => calls.push(['volume', ...args]),
    setAudioMute: (...args) => calls.push(['mute', ...args]),
    setDefaultAudio: (...args) => calls.push(['default', ...args]),
    outputConfiguration: () => clone(output),
    applyOutputConfiguration(draft) {
      calls.push(['display-apply', clone(draft)]); output.serial++; output.pendingToken = 7;
      output.remainingMs = 14500; output.heads = output.heads.map(head => ({ ...head, ...draft.heads.find(item => item.id === head.id) }));
    },
    shortcuts: () => clone(bindings), shortcutDefaults: () => clone(fixtureShortcuts),
    setShortcuts(value) {
      if (value.some(binding => binding.key === 'conflict')) throw new Error('Shortcut conflicts with reserved binding');
      calls.push(['shortcuts']); bindings = clone(value).map(binding => ({ ...binding,
        label: fixtureShortcuts.find(item => item.action === binding.action).label }));
    },
    captureShortcuts: enabled => calls.push(['capture', enabled]),
  };
  const report = value => errors.push(String(value));
  const audio = createAudioPolicy({ native, configuration, report });
  audio.start();
  const recorder = createShortcutRecorder({ native, host, report, theme: () => BUILTIN_THEME_CATALOG.themes[0] });
  const persistence = createDisplayPersistence({ native, configuration, failure: report });
  const domains = createSettingsDomains({ native, configuration, displayPersistence: persistence, audio, recorder,
    updateOutputs() {}, displayError: () => '', report });
  const client = { async call(member, argument) {
    calls.push(['rpc', member]);
    if (member === 'GetAppearance') return JSON.stringify(appearance());
    if (member === 'GetAbout') return JSON.stringify(about());
    if (member === 'DetachPage') { if (argument === 'keyboard') domains.detach(owner); return; }
    if (member === 'GetDisplays') return JSON.stringify(domains.displays());
    if (member === 'ApplyDisplays') { domains.applyDisplays(argument); return JSON.stringify(domains.displays()); }
    if (member === 'ForgetDisplayProfile') { domains.forgetDisplays(argument); return JSON.stringify(domains.displays()); }
    if (member === 'GetAudio') return JSON.stringify(domains.audio());
    if (member === 'RefreshAudio') { domains.retryAudio(); return JSON.stringify(domains.audio()); }
    if (member === 'AudioAction') { domains.audioAction(argument); return JSON.stringify(domains.audio()); }
    if (member === 'ForgetAudio') { domains.forgetAudio(argument); return JSON.stringify(domains.audio()); }
    if (member === 'GetKeyboard') return JSON.stringify(domains.keyboard(owner));
    if (member === 'KeyboardAction') { domains.keyboardAction(owner, argument); return JSON.stringify(domains.keyboard(owner)); }
    if (member === 'CancelShortcutRecording') { domains.cancelRecording(owner, argument); return JSON.stringify(domains.keyboard(owner)); }
    throw new Error('Unexpected RPC ' + member);
  }, close() {} };
  const app = createSettingsApp({ client, host, report, page: 'displays' }).start();
  t.after(() => { app.stop(); recorder.stop(); audio.stop(); });
  return { app, host, calls, errors, owner, domains, native, output, sound, audio, recorder, persistence, configuration,
    document: app.getWindow().document, saved: () => saved };
}
test('Displays edits live in the independent Settings document; Apply preserves trusted pending state through detach/reopen', async t => {
  const f = domainFixture(t); await tick();
  const find = id => f.document.getElementById(id);
  assert.ok(find('shell-displays')); assert.equal(find('settings-open-managed-displays'), null);
  const inputTheme = BUILTIN_THEME_CATALOG.themes.find(theme => theme.id === 'xp');
  assert.equal(find('shell-output-1-width').style.borderColor, inputTheme.colors.border);
  assert.equal(Number(find('shell-output-1-width').style.borderRadius), inputTheme.button.radius);
  assert.equal(Number(find('shell-output-1-width').style.paddingLeft), 7);
  await deliver(find('shell-output-1-scale-up'));
  await deliver(find('shell-output-1-rotate'));
  await deliver(find('shell-output-apply')); await tick();
  const request = f.calls.find(item => item[0] === 'display-apply')[1];
  assert.equal(request.heads[0].scale, 1.25); assert.equal(request.heads[0].transform, 1);
  assert.equal(f.saved().display, null); assert.equal(f.output.pendingToken, 7);
  assert.match(f.document.body.textContent, /trusted confirmation.*15 seconds/);
  await f.app.present('about'); await tick();
  assert.equal(f.output.pendingToken, 7, 'navigation cannot Keep/Revert or remove the compositor watchdog');
  f.output.remainingMs = 9000;
  await f.app.present('displays'); await tick();
  assert.match(f.document.body.textContent, /9 seconds/);
  assert.equal(f.host.windows.length, 1);
  assert.ok(!f.host.windows.some(window => window.title === 'Desktop control panel'));
});
test('Displays 100/150/200 percent shortcuts edit only the draft and Apply sends exact output scale factors', async t => {
  for (const [percent, type, key] of [[100, 'click', ''], [150, 'keydown', 'Enter'], [200, 'keydown', ' ']]) {
    await t.test(percent + '%', async t => {
      const f = domainFixture(t); await tick();
      const find = id => f.document.getElementById(id);
      await deliver(find('shell-output-1-scale-' + percent), type, { key });
      assert.equal(find('shell-output-1-scale').textContent, String(percent / 100));
      for (const preset of [100, 150, 200])
        assert.equal(find('shell-output-1-scale-' + preset).getAttribute('aria-pressed'), String(preset === percent));
      assert.equal(f.calls.some(item => item[0] === 'display-apply'), false);
      assert.equal(f.output.heads[0].scale, 1, 'selection does not configure the live output');
      await deliver(find('shell-output-apply')); await tick();
      assert.equal(f.calls.find(item => item[0] === 'display-apply')[1].heads[0].scale, percent / 100);
      assert.equal(f.output.pendingToken, 7); assert.equal(f.saved().display, null);
      assert.equal(find('shell-output-1-scale-' + percent), null);
      assert.match(f.document.body.textContent, /trusted confirmation.*15 seconds/);
      assert.ok(!f.calls.some(item => /Keep|Confirm|Revert/.test(item[1])));
      assert.deepEqual(f.errors, []);
    });
  }
});
test('Displays custom scale, typed edits and increments keep per-head preset truth without replacing inputs or listeners', async t => {
  const f = domainFixture(t); await tick();
  f.output.heads[0].scale = 1.25;
  f.output.heads.push({ ...f.output.heads[0], id: 2, name: 'DP-2', serialNumber: 'two', x: 1280, scale: 2 });
  f.output.serial++; await f.app.pages.refresh();
  const find = id => f.document.getElementById(id), input = find('shell-output-1-scale');
  const selected = (id, percent) => find('shell-output-' + id + '-scale-' + percent).getAttribute('aria-pressed');
  const firstSelection = percent => [100, 150, 200].forEach(preset =>
    assert.equal(selected(1, preset), String(preset === percent)));
  firstSelection(null); assert.equal(selected(2, 200), 'true');
  await deliver(find('shell-output-1-scale-up')); firstSelection(150);
  await deliver(find('shell-output-1-scale-up')); firstSelection(null);
  await deliver(find('shell-output-1-scale-up')); firstSelection(200);
  const type = async value => {
    input.focus(); await deliver(input, 'keydown', { key: 'a', ctrlKey: true });
    await deliver(input, 'textinput', { data: value });
  };
  await type('1.25'); firstSelection(null);
  await type('1.5'); firstSelection(150);
  await deliver(input, 'keydown', { key: 'a', ctrlKey: true });
  const caret = input.childNodes[2].style.left;
  const selection = JSON.stringify(input.firstChild.childNodes.map(node => node.style));
  for (let i = 0; i < 3; i++) await f.app.controller.refresh();
  assert.equal(find('shell-output-1-scale'), input);
  assert.equal(f.document.activeElement, input);
  assert.equal(input.childNodes[2].style.left, caret);
  assert.equal(JSON.stringify(input.firstChild.childNodes.map(node => node.style)), selection);
  assert.equal(input.listeners.get('textinput').length, 2, 'one SDK and one edit notification listener');
  assert.equal(input.listeners.get('keydown').length, 2);
  await deliver(input, 'keydown', { key: 'Backspace' }); firstSelection(null);
  await deliver(find('shell-output-apply')); await tick();
  assert.match(f.document.body.textContent, /Enter a value for scale/);
  assert.equal(f.calls.some(item => item[0] === 'display-apply'), false);
  const previous = globalThis.clipboard;
  globalThis.clipboard = { readText: () => '2', readPrimaryText: () => '1.5', supportsPrimary: true };
  t.after(() => { globalThis.clipboard = previous; });
  await deliver(input, 'keydown', { key: 'v', ctrlKey: true }); firstSelection(200);
  await deliver(input, 'keydown', { key: 'a', ctrlKey: true });
  await deliver(input, 'keydown', { key: 'Delete' }); firstSelection(null);
  await deliver(input, 'auxclick', { button: 1, clientX: 7 }); firstSelection(150);
  assert.equal(selected(2, 200), 'true'); assert.equal(find('shell-output-2-scale').textContent, '2');
  await deliver(find('shell-output-2-scale-100'));
  firstSelection(150); assert.equal(input.textContent, '1.5');
  assert.equal(selected(2, 100), 'true');
  await deliver(find('shell-output-2-scale-200'));
  await deliver(find('shell-output-apply')); await tick();
  assert.deepEqual(f.calls.find(item => item[0] === 'display-apply')[1].heads.map(head => head.scale), [1.5, 2]);
});
test('Displays presets honor busy/disabled state and serial/pending changes retire callbacks and drafts', async t => {
  const f = domainFixture(t); await tick();
  const document = f.host.create({}).document, page = createDisplayPage(), commands = [];
  t.after(() => page.detach());
  let snapshot = f.domains.displays(), busy = true, paints = 0;
  const paint = () => { paints++; page.paint(document.body, BUILTIN_THEME_CATALOG.themes[0],
    snapshot, busy, (...args) => commands.push(args), paint); };
  const find = id => document.getElementById(id);
  paint();
  for (const percent of [100, 150, 200]) {
    const preset = find('shell-output-1-scale-' + percent);
    assert.equal(preset.getAttribute('aria-disabled'), 'true'); assert.equal(preset.tabIndex, -1);
    await deliver(preset); await deliver(preset, 'keydown', { key: 'Enter' }); await deliver(preset, 'keydown', { key: ' ' });
  }
  await deliver(find('shell-output-1-scale-up')); await deliver(find('shell-output-apply'));
  assert.equal(find('shell-output-1-scale').textContent, '1'); assert.deepEqual(commands, []);
  busy = false; paint();
  await deliver(find('shell-output-1-scale-150'));
  const retired = find('shell-output-1-scale');
  snapshot = { ...snapshot, serial: snapshot.serial + 1 }; paint();
  assert.notEqual(find('shell-output-1-scale'), retired);
  assert.equal(find('shell-output-1-scale').textContent, '1');
  assert.match(document.body.textContent, /old draft was discarded/);
  const before = paints;
  await deliver(retired, 'textinput', { data: '2' });
  assert.equal(paints, before, 'retired input cannot repaint a replacement draft');
  assert.equal(find('shell-output-1-enabled').getAttribute('role'), 'checkbox');
  assert.equal(find('shell-output-1-enabled').getAttribute('aria-checked'), 'true');
  await deliver(find('shell-output-1-enabled'), 'keydown', { key: ' ' });
  assert.equal(find('shell-output-1-scale-100'), null, 'disabled heads have no scale actions');
  assert.equal(find('shell-output-1-enabled').getAttribute('aria-checked'), 'false');
  await deliver(find('shell-output-1-enabled'), 'keydown', { key: ' ' });
  await deliver(find('shell-output-1-scale-200'));
  snapshot = { ...snapshot, pendingToken: 9, remainingMs: 15000 }; paint();
  assert.equal(find('shell-output-1-scale-200'), null);
  assert.match(document.body.textContent, /trusted confirmation.*15 seconds/);
  snapshot = { ...snapshot, pendingToken: 0 }; paint();
  assert.equal(find('shell-output-1-scale').textContent, '1', 'pending confirmation discards the editable draft');
  assert.deepEqual(commands, []);
});
test('Displays hotplug discards draft/inputs and exact identity or all-off changes are refused without mutation', async t => {
  const f = domainFixture(t); await tick();
  const old = f.document.getElementById('shell-output-1-width');
  f.output.serial++; f.output.heads[0].serialNumber = 'replacement';
  await f.app.present('displays'); await tick();
  assert.notEqual(f.document.getElementById('shell-output-1-width'), old);
  const stale = displayDraft(f.domains.displays()); stale.heads[0].serialNumber = 'old';
  assert.throws(() => f.domains.applyDisplays(JSON.stringify(stale)), /identities/);
  const off = displayDraft(f.domains.displays()); off.heads[0].enabled = false;
  assert.throws(() => f.domains.applyDisplays(JSON.stringify(off)), /remain enabled/);
  assert.equal(f.calls.some(item => item[0] === 'display-apply'), false);
});
test('Audio page uses one owner policy; actual acknowledgement persists after page close and stale/replaced nodes refuse', async t => {
  const f = domainFixture(t); await f.app.present('audio'); await tick();
  const find = id => f.document.getElementById(id);
  assert.ok(find('shell-audio-settings')); assert.equal(find('settings-open-managed-audio'), null);
  await deliver(find('shell-audio-retry')); await tick();
  assert.equal(f.calls.filter(item => item[0] === 'audio-start').length, 1, 'explicit refresh never creates a second policy owner');
  assert.equal(find('shell-audio-mute-11').getAttribute('aria-disabled'), 'true');
  assert.equal(find('shell-audio-mute-11').getAttribute('role'), 'switch');
  await deliver(find('shell-audio-lower-10')); await tick();
  assert.deepEqual(f.calls.find(item => item[0] === 'volume'), ['volume', 10, 1, 0.9]);
  assert.equal(f.saved().audio, null);
  f.app.stop(); assert.equal(f.calls.some(item => item[0] === 'audio-stop'), false);
  f.sound.nodes[0].volume = 0.9; f.sound.nodes[0].revision++; f.sound.revision++;
  f.audio.snapshot();
  assert.equal(f.saved().audio.devices[0].volume, 0.9);
  const action = JSON.stringify({ generation: f.sound.generation, id: 10, revision: 1, instance: '100', operation: 'mute', value: true });
  assert.throws(() => f.domains.audioAction(action), /device changed/);
  f.sound.generation++;
  assert.throws(() => f.domains.audioAction(action), /device changed/);
  assert.throws(() => f.domains.forgetAudio(JSON.stringify({ generation: f.sound.generation - 1,
    revision: f.sound.revision })), /state changed/);
  assert.equal(f.calls.filter(item => item[0] === 'volume').length, 1);
});
test('themed Audio mute switch preserves identity checks and persists only after the native acknowledgement', async t => {
  const f = domainFixture(t); await f.app.present('audio'); await tick();
  let mute = f.document.getElementById('shell-audio-mute-10');
  assert.equal(mute.getAttribute('role'), 'switch');
  assert.equal(mute.getAttribute('aria-checked'), 'false');
  await deliver(mute, 'keydown', { key: 'Enter' }); await tick();
  assert.equal(f.calls.some(item => item[0] === 'mute'), false, 'switch Enter is not button activation');
  await deliver(mute, 'keydown', { key: ' ' }); await tick();
  assert.deepEqual(f.calls.find(item => item[0] === 'mute'), ['mute', 10, 1, true]);
  assert.equal(f.saved().audio, null);
  mute = f.document.getElementById('shell-audio-mute-10');
  assert.equal(mute.getAttribute('aria-disabled'), 'true');
  await deliver(mute, 'keydown', { key: ' ' }); await deliver(mute); await tick();
  assert.equal(f.calls.filter(item => item[0] === 'mute').length, 1, 'pending acknowledgement blocks duplicate operations');
  f.sound.nodes[0].muted = true; f.sound.nodes[0].revision++; f.sound.revision++;
  f.audio.snapshot(); await f.app.present('audio'); await tick();
  assert.equal(f.saved().audio.devices[0].muted, true);
  assert.equal(f.document.getElementById('shell-audio-mute-10').getAttribute('aria-checked'), 'true');
});
test('Keyboard records only in the small trusted active surface, cancels on focus loss/detach, preserves catalog conflict errors', async t => {
  const f = domainFixture(t); await f.app.present('keyboard'); await tick();
  const action = fixtureShortcuts[0].action;
  await deliver(f.document.getElementById('shell-shortcut-' + action)); await tick();
  const first = f.host.windows.at(-1), firstRecording = f.domains.keyboard(f.owner).recording;
  assert.equal(first.title, 'PollyShell.shortcut-recording.' + firstRecording.token);
  assert.equal(f.calls.some(item => item[0] === 'capture'), false, 'no capture before actual trusted activation');
  first.active = true; first.onactivate();
  assert.deepEqual(f.calls.at(-1), ['capture', true]);
  f.domains.detach({}); assert.ok(f.domains.keyboard(f.owner).recording, 'another owner cannot cancel this token');
  assert.throws(() => f.domains.cancelRecording({}, firstRecording.token), /another owner/);
  first.active = false; first.ondeactivate();
  assert.equal(f.domains.keyboard(f.owner).recording, null);
  assert.deepEqual(f.calls.at(-1), ['capture', false]);
  let state = f.domains.keyboard(f.owner);
  f.domains.keyboardAction(f.owner, JSON.stringify({ revision: state.revision, operation: 'record', action }));
  const second = f.host.windows.at(-1); second.active = true; second.onactivate();
  await deliver(second.document.body, 'keydown', { key: 'm', ctrlKey: true });
  assert.equal(f.native.shortcuts()[0].key, 'm'); assert.equal(f.saved().shortcuts[0].key, 'm');
  state = f.domains.keyboard(f.owner);
  f.domains.keyboardAction(f.owner, JSON.stringify({ revision: state.revision, operation: 'record', action }));
  const third = f.host.windows.at(-1); third.active = true; third.onactivate();
  await deliver(third.document.body, 'keydown', { key: 'conflict', ctrlKey: true });
  assert.match(f.domains.keyboard(f.owner).error, /conflicts/);
  assert.equal(f.native.shortcuts()[0].key, 'm');
  state = f.domains.keyboard(f.owner);
  f.domains.keyboardAction(f.owner, JSON.stringify({ revision: state.revision, operation: 'record', action }));
  await f.app.present('about'); await tick();
  assert.equal(f.domains.keyboard(f.owner).recording, null);
});
test('Domain snapshots reject unknown fields, fabricated readiness and mixed identity payloads', async t => {
  const f = domainFixture(t); await tick();
  for (const [parse, value] of [[parseDisplays, f.domains.displays()], [parseAudio, f.domains.audio()],
    [parseKeyboard, f.domains.keyboard(f.owner)]]) {
    assert.throws(() => parse(JSON.stringify({ ...value, command: 'untrusted' })));
  }
  const audio = f.domains.audio(); audio.nodes[0].instance = 100;
  assert.throws(() => parseAudio(JSON.stringify(audio)));
  const displays = f.domains.displays(); displays.heads[0].adaptiveSync = 'true';
  assert.throws(() => parseDisplays(JSON.stringify(displays)));
});
test('shared appearance view uses the explicit remote catalog rather than a Shell module-global list', () => {
  const theme = BUILTIN_THEME_CATALOG.themes[0];
  const tree = settingsView(theme, () => {}, () => {}, () => {}, '', false, null, null, null, null,
    null, null, true, '', [{ id: 'remote-choice', name: 'Remote catalog choice' }]);
  const nodes = node => [node, ...(node.children || []).flatMap(nodes)];
  const ids = nodes(tree).map(node => node.props.id).filter(id => id?.startsWith('shell-theme-'));
  assert.deepEqual(ids, ['shell-theme-remote-choice']);
});
test('system identity has strict source fields, never invents a release, and displays dirty/unknown explicitly', () => {
  assert.match(buildLabel(runtimeBuild()), /unknown.*source state unknown/);
  const build = runtimeBuild({ runtimeVersion: '0.1.0-alpha.7', runtimeRevision: 'a'.repeat(40), runtimeSourceDirty: true });
  assert.match(buildLabel(build), /alpha.7.*aaaaaaaa.*modified/);
  for (const invalid of [
    { ...build, extra: 'claimed' }, { ...build, revision: 'short' }, { ...build, sourceDirty: 'clean' },
    { ...build, version: '\0release' }, { ...build, version: '' },
  ]) assert.throws(() => parseAppearance(JSON.stringify({ ...appearance(), build: invalid })));
  assert.equal(parseAbout(JSON.stringify({ ...about(), build })).build.revision, 'a'.repeat(40));
});
test('versioned business snapshots reject unknown fields, unsafe data and invented service states', () => {
  assert.equal(parseAppearance(JSON.stringify(appearance())).themeId, 'xp');
  assert.equal(parseAbout(JSON.stringify(about())).services.audio, 'ready');
  for (const change of [
    value => { value.extra = true; }, value => { value.version = 2; },
    value => { value.themeId = 'missing'; }, value => { value.themeFilesEnabled = 1; },
    value => { value.catalog.themes[0].colors.text = 'url(file:///secrets)'; },
  ]) {
    const value = JSON.parse(JSON.stringify(appearance())); change(value);
    assert.throws(() => parseAppearance(JSON.stringify(value)));
  }
  assert.throws(() => parseAbout(JSON.stringify({ ...about(), services: { ...about().services, audio: 'invented' } })));
  assert.throws(() => parseAppearance('x'.repeat(1024 * 1024 + 1)));
});
test('standalone controller acknowledges writes, shows real failures, and never replays uncertain operations', async () => {
  const calls = [], reports = [];
  let current = appearance(), fail = false;
  const client = {
    async call(member, argument) {
      calls.push([member, argument]);
      if (member === 'GetAppearance') return JSON.stringify(current);
      if (member === 'GetAbout') return JSON.stringify(about());
      if (member === 'OpenManagedPage') return undefined;
      if (fail) throw Object.assign(new Error('Commit uncertain; saved appearance retained'), { code: 'ERR_DBUS_TIMEOUT' });
      current = { ...current, themeId: argument || 'xp', revision: current.revision + 1 };
      return JSON.stringify(current);
    },
    close() { calls.push(['close']); },
  };
  const controller = createSettingsController({ client, report: message => reports.push(message) });
  await controller.refresh(); await controller.select('bigsur');
  assert.equal(controller.getState().appearance.themeId, 'bigsur');
  fail = true; await controller.reload();
  assert.equal(controller.getState().appearance.themeId, 'bigsur');
  assert.match(controller.getState().error, /uncertain.*retained/);
  await controller.refresh();
  assert.equal(calls.filter(([member]) => member === 'ReloadThemes').length, 1);
  assert.equal(reports.length, 1);
  await controller.navigate('about'); assert.equal(controller.getState().about.outputs, 2);
  for (const page of ['displays', 'network', 'audio', 'keyboard']) await controller.managed(page);
  assert.equal(calls.filter(([member]) => member === 'OpenManagedPage').length, 4);
  assert.throws(() => controller.managed('appearance'));
  controller.close(); await controller.select('xp');
  assert.equal(calls.at(-1)[0], 'close');
});
test('owned native PID/UID, presentation owner and final generation gate every Shell operation', async () => {
  const queue = [], effects = [], reports = [], credentials = new Map([
    [':owned', { pid: 42, uid: 1000 }], [':presentation', { pid: 42, uid: 1000 }],
    [':intruder', { pid: 88, uid: 1000 }], [':root', { pid: 42, uid: 0 }],
  ]);
  let delayed = null;
  const client = {
    call(target, signature, args) {
      if (target.member === 'GetNameOwner') return { poll: () => ({ state: 'reply', value: ':presentation' }) };
      if (target.member === 'Present') {
        effects.push(['present', target.destination, args[0]]);
        return { poll: () => ({ state: 'reply' }) };
      }
      const peer = credentials.get(args[0]);
      return { poll() {
        if (delayed === args[0]) return { state: 'pending' };
        return { state: 'reply', value: target.member === 'GetConnectionUnixProcessID' ? peer.pid : peer.uid };
      } };
    },
    close() { effects.push(['client-close']); },
  };
  let wifi = networkState(), operationId = 0, canceled = 0;
  const network = {
    startNetwork() {}, networkState: () => ({ ...wifi }),
    networkAction(revision, target, action) {
      assert.equal(revision, wifi.revision);
      effects.push(['network', action, target]);
      wifi = { ...wifi, operation: action, target, operationId: ++operationId };
    },
    cancelNetworkConnection() { canceled++; wifi = { ...wifi, operation: '', target: '', authentication: null }; },
    refreshNetworks() { effects.push(['network-refresh']); },
    replyNetworkAuthentication(token, user, password) { effects.push(['network-auth', token, user === null, password === null]); },
  };
  const domains = {
    displays: () => ({ domain: 'displays' }), audio: () => ({ domain: 'audio' }),
    keyboard: () => ({ domain: 'keyboard' }),
    applyDisplays: value => effects.push(['display-write', value]),
    forgetDisplays: () => effects.push(['display-forget']),
    audioAction: () => effects.push(['audio-write']), retryAudio() {}, forgetAudio: () => effects.push(['audio-forget']),
    keyboardAction: () => effects.push(['keyboard-write']),
    cancelRecording: () => effects.push(['recording-cancel']),
    detach: () => effects.push(['keyboard-detach']),
  };
  const bridge = createSettingsService({ service: { poll: () => queue.shift() || null, close() {} }, client, network, domains,
    pid: 7, uid: 1000, spawn: page => { effects.push(['spawn', page, SETTINGS_APP_ID]); return 42; },
    activate: () => effects.push(['activate']), appearance, about,
    select: id => { effects.push(['select', id]); return id !== 'fail'; },
    reload: () => { effects.push(['reload']); return true; }, restore: () => true,
    managed: page => effects.push(['managed', page]), report: value => reports.push(value) });
  function request(member, args = [], sender = ':owned', noReply = false) {
    return new Promise(resolve => queue.push({ target: { member }, args, sender, noReply,
      reply: value => resolve({ value }), error: (name, message) => resolve({ name, message }),
      close: () => { if (noReply) resolve({ closed: true }); } }));
  }
  try {
    const opening = request('Open', ['appearance'], ':intruder');
    await tick();
    const connected = await request('Connect');
    assert.deepEqual(connected.value, [7, 1, 'appearance']);
    assert.equal((await opening).value[0], 42);
    assert.equal(effects.filter(([kind]) => kind === 'spawn').length, 1);
    await request('Open', ['about'], ':intruder');
    assert.equal(effects.filter(([kind]) => kind === 'spawn').length, 1);
    assert.ok(effects.some(effect => effect.join() === 'present,:presentation,about'));
    for (const sender of [':intruder', ':root'])
      assert.match((await request('SelectTheme', ['bigsur'], sender)).name, /AccessDenied/);
    for (const member of ['Open', 'SelectTheme', 'ReloadThemes', 'RestoreThemes', 'OpenManagedPage',
      'NetworkAction', 'RefreshNetwork', 'ReplyNetworkAuthentication', 'CancelNetworkConnection', 'DetachNetwork',
      'ApplyDisplays', 'ForgetDisplayProfile', 'AudioAction', 'RefreshAudio', 'ForgetAudio', 'KeyboardAction', 'CancelShortcutRecording', 'DetachPage'])
      await request(member, ['xp'], ':owned', true);
    assert.equal(effects.some(([kind]) => kind === 'select'), false);
    assert.equal(effects.filter(([kind]) => kind === 'spawn').length, 1);
    credentials.set(':presentation', { pid: 88, uid: 1000 });
    assert.match((await request('Connect')).name, /AccessDenied/);
    credentials.set(':presentation', { pid: 42, uid: 1000 });
    assert.ok((await request('SelectTheme', ['xp'])).value[0]);
    for (const id of ['invalid theme', 'x'.repeat(65), '{"pid":42,"generation":1}'])
      assert.match((await request('SelectTheme', [id])).name, /Failed/);
    assert.equal(effects.filter(([kind]) => kind === 'select').length, 1);
    assert.match((await request('SelectTheme', ['fail'])).name, /ApplyFailed/);
    assert.match((await request('OpenManagedPage', ['appearance'])).name, /Failed/);
    await request('OpenManagedPage', ['network']);
    assert.ok(effects.some(effect => effect.join() === 'managed,network'));
    for (const member of ['GetNetwork', 'NetworkAction', 'RefreshNetwork', 'ReplyNetworkAuthentication', 'CancelNetworkConnection', 'DetachNetwork'])
      assert.match((await request(member, [], ':intruder')).name, /AccessDenied/);
    for (const member of ['GetDisplays', 'ApplyDisplays', 'ForgetDisplayProfile', 'GetAudio', 'AudioAction', 'RefreshAudio', 'ForgetAudio',
      'GetKeyboard', 'KeyboardAction', 'CancelShortcutRecording', 'DetachPage'])
      assert.match((await request(member, [], ':intruder')).name, /AccessDenied/);
    delayed = ':owned';
    const retiredKeyboard = request('KeyboardAction', ['{}']);
    await tick(); await request('DetachPage', ['keyboard'], ':presentation'); delayed = null;
    assert.match((await retiredKeyboard).name, /AccessDenied/);
    assert.equal(effects.some(([kind]) => kind === 'keyboard-write'), false);
    await request('ApplyDisplays', ['{}']); await request('AudioAction', ['{}']); await request('KeyboardAction', ['{}']);
    assert.equal(effects.filter(([kind]) => /^(display|audio|keyboard)-write$/.test(kind)).length, 3);
    delayed = ':owned';
    const olderDetach = request('DetachPage', ['keyboard']);
    await tick();
    const detachCount = effects.filter(([kind]) => kind === 'keyboard-detach').length;
    await request('KeyboardAction', ['{}'], ':presentation');
    delayed = null; await olderDetach;
    assert.equal(effects.filter(([kind]) => kind === 'keyboard-detach').length, detachCount,
      'an older delayed detach must not cancel a newer accepted recorder operation');
    const action = JSON.stringify({ revision: wifi.revision, target: networkId, action: 'connect' });
    await request('NetworkAction', [action]);
    wifi.authentication = { id: 77, kind: 'passphrase', username: '', network: networkId };
    assert.equal(JSON.parse((await request('GetNetwork')).value[0]).authentication.id, 77);
    await request('ReplyNetworkAuthentication', [JSON.stringify({ token: 77, user: '', password: 'testpass' })]);
    await request('DetachNetwork'); assert.equal(canceled, 1);
    network.networkAction(wifi.revision, networkId, 'connect');
    wifi.authentication = { id: 78, kind: 'passphrase', username: '', network: networkId };
    assert.equal(JSON.parse((await request('GetNetwork')).value[0]).authentication, null);
    assert.match((await request('CancelNetworkConnection')).name, /AccessDenied/);
    await request('DetachNetwork'); assert.equal(canceled, 1, 'detach must not cancel a Shell-panel connection');
    wifi = networkState();
    delayed = ':owned';
    const detachedAction = request('NetworkAction', [action]);
    await tick();
    await request('DetachNetwork', [], ':presentation');
    delayed = null;
    assert.match((await detachedAction).name, /AccessDenied/, 'page detach invalidates an in-flight authorization result');
    await request('NetworkAction', [action]);
    delayed = ':owned';
    const stale = request('ReloadThemes');
    await tick(); bridge.exited({ pid: 42 }); delayed = null;
    assert.match((await stale).name, /AccessDenied/);
    assert.equal(effects.some(([kind]) => kind === 'reload'), false);
    assert.equal(canceled, 2, 'actual owned process exit retires only its pending connect');
    assert.deepEqual(reports, []);
  } finally { bridge.close(); }
});
