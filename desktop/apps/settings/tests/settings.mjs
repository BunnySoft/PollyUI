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
const { applicationHost, deliver } = await import('./desktop/tests/application-host.mjs');
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
  const bridge = createSettingsService({ service: { poll: () => queue.shift() || null, close() {} }, client, network,
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
      'NetworkAction', 'RefreshNetwork', 'ReplyNetworkAuthentication', 'CancelNetworkConnection', 'DetachNetwork'])
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
