import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
register('../../../tests/root-loader.mjs', import.meta.url);
const { BUILTIN_THEME_CATALOG } = await import('./desktop/shell/themes.mjs');
const { parseAppearance, parseAbout, SETTINGS_APP_ID } = await import('./desktop/client/settings-contract.mjs');
const { createSettingsController } = await import('./desktop/apps/settings/logic/controller.mjs');
const { createSettingsService } = await import('./desktop/shell/settings-service.mjs');
const { settingsView } = await import('./desktop/shell/views.mjs');
const appearance = () => ({ version: 1, revision: 1, catalogRevision: 1, themeId: 'xp',
  catalog: BUILTIN_THEME_CATALOG, themeFilesEnabled: true, themeFilesAvailable: true, status: '', error: '' });
const about = () => ({ version: 1, services: { inputMethod: 'disabled', audio: 'ready', message: '', error: '' },
  outputs: 2, themeId: 'xp', applicationId: 'org.pollyui.shell',
  profiles: { display: 'Confirmed layout saved', audio: 'Saved audio profile', workspace: 'Saved workspace profile' } });
const tick = () => new Promise(resolve => setTimeout(resolve, 20));
test('shared appearance view uses the explicit remote catalog rather than a Shell module-global list', () => {
  const theme = BUILTIN_THEME_CATALOG.themes[0];
  const tree = settingsView(theme, () => {}, () => {}, () => {}, '', false, null, null, null, null,
    null, null, true, '', [{ id: 'remote-choice', name: 'Remote catalog choice' }]);
  const nodes = node => [node, ...(node.children || []).flatMap(nodes)];
  const ids = nodes(tree).map(node => node.props.id).filter(id => id?.startsWith('shell-theme-'));
  assert.deepEqual(ids, ['shell-theme-remote-choice']);
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
  const bridge = createSettingsService({ service: { poll: () => queue.shift() || null, close() {} }, client,
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
    for (const member of ['Open', 'SelectTheme', 'ReloadThemes', 'RestoreThemes', 'OpenManagedPage'])
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
    delayed = ':owned';
    const stale = request('ReloadThemes');
    await tick(); bridge.exited({ pid: 42 }); delayed = null;
    assert.match((await stale).name, /AccessDenied/);
    assert.equal(effects.some(([kind]) => kind === 'reload'), false);
    assert.deepEqual(reports, []);
  } finally { bridge.close(); }
});
