import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

register('./root-loader.mjs', import.meta.url);
const { applicationActivationTarget, parseDesktopEntry, applicationCatalog, createApplicationLauncher } =
  await import('./desktop/shell/applications.mjs');
const file = (id = 'org.pollyui.Activation-fixture.desktop', extra = '') => ({
  id, path: '/synthetic/applications/' + id,
  contents: '[Desktop Entry]\nType=Application\nName=Activation\nDBusActivatable=true\n' + extra,
});
const available = { activationAvailable: true };

test('standard desktop ID maps dots to slashes and dashes to underscores', () => {
  assert.deepEqual(applicationActivationTarget(file().id), {
    busName: 'org.pollyui.Activation-fixture', objectPath: '/org/pollyui/Activation_fixture',
  });
  assert.deepEqual(applicationActivationTarget('_org.-App_9.desktop'), {
    busName: '_org.-App_9', objectPath: '/_org/_App_9',
  });
  const maximum = 'a.' + 'b'.repeat(253);
  assert.equal(applicationActivationTarget(maximum + '.desktop').busName.length, 255);
  assert.equal(applicationActivationTarget(maximum + '.desktop').objectPath.length, 256);
});

test('invalid bus names, paths, suffixes, Unicode, lengths and NUL are rejected', () => {
  for (const id of ['', 'bus.desktop', '.org.App.desktop', 'org..App.desktop', 'org.App..desktop',
    'org.9App.desktop', '9org.App.desktop', ':1.42.desktop', 'org/App.desktop', '../org.App.desktop',
    'org.App.desktop\n', 'org.App\n.desktop', 'org.App\r.desktop', 'org.App', 'org.应用.desktop', 'org.App\0.desktop', 'org.App.desktop\0',
    'org.App;command.desktop', 'org.App\\other.desktop', 'a.' + 'b'.repeat(254) + '.desktop', null, 42]) {
    assert.throws(() => applicationActivationTarget(id), undefined, String(id));
    if (typeof id === 'string') assert.throws(() => parseDesktopEntry(file(id), available), undefined, id);
  }
});

test('D-Bus-only parsing retains localized metadata and does not invent argv', () => {
  const entry = parseDesktopEntry(file(undefined, 'Name[zh_CN]=本地化\nTerminal=true\nPath=/synthetic\n'),
    { ...available, locale: 'zh_CN.UTF-8', canExecute: () => false });
  assert.equal(entry.name, '本地化');
  assert.equal(entry.argv, null);
  assert.equal(entry.unavailable, '');
  assert.deepEqual(entry.activation, applicationActivationTarget(entry.id));
  assert.match(parseDesktopEntry(file()).unavailable, /qualified private session bus/);
});

test('strict booleans, NUL, TryExec and visibility masking remain fail-closed', () => {
  for (const value of ['True', '1', 'yes', '', 'false\0'])
    assert.throws(() => parseDesktopEntry({ ...file(), contents: file().contents.replace('true', value) }, available));
  assert.throws(() => parseDesktopEntry({ ...file(), contents: file().contents.replace('true', 'maybe') + 'Exec=program\n' }, available));
  assert.throws(() => parseDesktopEntry({ ...file(), contents: file().contents.replace('true', 'false') }, available));
  assert.throws(() => parseDesktopEntry(file(undefined, 'Comment=bad\0value\n'), available));
  assert.equal(parseDesktopEntry(file(undefined, 'TryExec=absent\n'), { ...available, canExecute: () => false }), null);
  for (const rule of ['Hidden=true', 'NoDisplay=true', 'OnlyShowIn=GNOME;', 'NotShowIn=Polly;'])
    assert.equal(parseDesktopEntry(file(undefined, rule + '\n'), available), null);
});

function fixture() {
  const state = { files: [file()], qualified: true, calls: [], result: Promise.resolve({ kind: 'dbus', acknowledged: true }) };
  const native = {
    applicationFiles: () => state.files, canExecute: () => true,
    canActivateApplication: () => state.qualified,
    activateApplication: id => { state.calls.push(['activate', id]); return state.result; },
    spawnApplication: (...args) => { state.calls.push(['spawn', ...args]); return 123; },
  };
  return { state, native, launcher: createApplicationLauncher(native, () => {}) };
}

test('launcher returns actual acknowledgement promise without PID or terminal prefix', async () => {
  const { state, native, launcher } = fixture();
  native.canExecute = () => false;
  state.files = [file(undefined, 'Terminal=true\n')];
  const copy = launcher.refresh()[0];
  copy.activation.busName = 'org.pollyui.Mutated';
  const promise = launcher.launch(file().id);
  assert.equal(promise, state.result);
  assert.deepEqual(await promise, { kind: 'dbus', acknowledged: true });
  assert.deepEqual(state.calls, [['activate', file().id]]);
});

test('timeout, error and disconnect propagate without any spawn or retry', async () => {
  for (const code of ['POLLY_ACTIVATION_TIMEOUT', 'org.pollyui.ActivationFixture.Failed', 'POLLY_ACTIVATION_DISCONNECTED']) {
    const { state, launcher } = fixture();
    const error = Object.assign(new Error(code), { code });
    state.result = Promise.reject(error);
    await assert.rejects(launcher.launch(file().id), failure => failure === error);
    assert.deepEqual(state.calls, [['activate', file().id]]);
  }
});

test('refresh and launch recheck deleted/masked IDs, native capability and bus qualification', () => {
  const { state, native, launcher } = fixture();
  launcher.refresh();
  state.files = [];
  assert.throws(() => launcher.launch(file().id), /no longer available/);
  state.files = [file(undefined, 'Hidden=true\n'), file()];
  assert.throws(() => launcher.launch(file().id), /no longer available/);
  state.files = [{ ...file(), contents: file().contents + 'DBusActivatable=maybe\n' }, file()];
  assert.throws(() => launcher.launch(file().id), /no longer available/);
  state.files = [file()];
  state.qualified = false;
  assert.match(launcher.refresh()[0].unavailable, /qualified private session bus/);
  assert.throws(() => launcher.launch(file().id), /qualified private session bus/);
  state.qualified = true;
  delete native.activateApplication;
  assert.throws(() => launcher.launch(file().id), /qualified private session bus/);
  assert.deepEqual(state.calls, []);
});

test('Exec stays direct even with DBusActivatable, including terminal and executable checks', () => {
  const { state, native, launcher } = fixture();
  state.files = [file('ordinary.desktop', 'Exec=program %f\nTerminal=true\n')];
  native.terminal = '/synthetic/terminal';
  assert.equal(launcher.launch('ordinary.desktop'), 123);
  assert.deepEqual(state.calls, [['spawn', ['/synthetic/terminal', '-e', 'program'], '', 'ordinary.desktop']]);
  native.canExecute = () => false;
  assert.throws(() => launcher.launch('ordinary.desktop'), /unavailable/);
  const reports = [];
  assert.equal(applicationCatalog([file('bad.desktop'), file('bad.desktop', 'Exec=program\n')], available,
    error => reports.push(error)).length, 0);
  assert.equal(reports.length, 1);
});

test('managed bundles still use the existing direct manager argv and selected digest', () => {
  const { state, native, launcher } = fixture();
  const digest = 'a'.repeat(64), id = 'org.pollyui.managed-fixture';
  const manifest = { schemaVersion: 1, id, name: 'Managed fixture', version: '1.0.0',
    target: { os: 'linux', architecture: 'x86_64', libc: 'glibc' },
    launch: { kind: 'pollyui', entry: 'main.mjs', arguments: [] }, data: { layout: 'pollyui', schema: 1 } };
  native.bundleManager = '/synthetic/polly-app';
  native.bundleFiles = () => [{ id, store: '/synthetic/store', contents: JSON.stringify({
    schemaVersion: 1, current: { digest, manifest }, previous: null,
  }) }];
  state.files = [];
  assert.equal(launcher.launch('bundle:' + id), 123);
  assert.deepEqual(state.calls, [['spawn', [native.bundleManager, 'run', id, digest], '', 'bundle:' + id]]);
});
