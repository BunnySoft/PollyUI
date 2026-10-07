import { createApplicationLauncher, applicationActivationTarget } from './desktop/shell/applications.mjs';

const [mode] = application.arguments;
const id = name => 'org.pollyui.ActivationFixture.' + name + '.desktop';
function check(value, message) {
  if (!value) throw new Error(message);
  console.log('PASS: ' + message);
}
function throws(fn, pattern) {
  let error;
  try { fn(); } catch (failure) { error = failure; }
  check(error && pattern.test(String(error)), 'synchronous rejection: ' + pattern);
}
let spawned = 0;
desktop.spawnApplication = () => { spawned++; throw new Error('Forbidden activation fallback spawn'); };
const launcher = createApplicationLauncher(desktop, message => console.log('CATALOG: ' + message));
async function rejects(promise, code) {
  let error;
  try { await promise; } catch (failure) { error = failure; }
  check(error && code.test(String(error.code)), 'explicit native activation rejection: ' + (error && error.code));
}
async function run() {
  check(typeof desktop.activateApplication === 'function' && typeof desktop.canActivateApplication === 'function',
    'rebuilt native activation API is required (old binaries/stubs are not accepted)');
  if (mode === 'guard') {
    check(!desktop.canActivateApplication(), 'unqualified private bus is rejected');
    const entries = launcher.refresh();
    check(entries.some(entry => entry.id === 'org.pollyui.Activation-fixture.desktop' && entry.activation),
      'a valid synthetic D-Bus-only entry remains discoverable without a qualified bus');
    check(entries.filter(entry => entry.activation).every(entry =>
      entry.unavailable.includes('qualified private session bus')), 'valid bus-only entries are visibly unavailable');
    throws(() => desktop.activateApplication(id('Success')), /qualified private session bus/);
  } else {
    check(desktop.canActivateApplication(), 'qualified private bus allows an attempt, not service readiness');
    if (mode === 'main') {
      throws(() => desktop.activateApplication(id('Success'), 'org.pollyui.ArbitraryInterface'),
        /requires a desktop-file ID/);
      for (const invalid of ['bus.desktop', ':1.4.desktop', 'org..App.desktop', 'org.9App.desktop',
        'org/App.desktop', 'org.应用.desktop', 'org.App\n.desktop', 'org.App\0.desktop', 'org.App.desktop\0',
        'a.' + 'b'.repeat(254) + '.desktop'])
        throws(() => desktop.activateApplication(invalid), /Invalid D-Bus application desktop ID/);
      const entries = launcher.refresh();
      check(!entries.some(entry => entry.id === id('BadBool') || entry.id === id('Nul')),
        'native-discovered malformed boolean/NUL records are rejected');
      let settled = false;
      const waiting = launcher.launch('org.pollyui.Activation-fixture.desktop').then(result => { settled = true; return result; });
      await new Promise(resolve => setTimeout(resolve, 100));
      check(!settled, 'queued request is not reported as acknowledgement while actual service reply is blocked');
      const acknowledged = await waiting;
      const target = applicationActivationTarget('org.pollyui.Activation-fixture.desktop');
      check(acknowledged.kind === 'dbus' && acknowledged.acknowledged === true &&
        acknowledged.id === 'org.pollyui.Activation-fixture.desktop' &&
        acknowledged.busName === target.busName && acknowledged.objectPath === target.objectPath &&
        !('pid' in acknowledged), 'native method-return reports exact mapping and acknowledgement, never PID/readiness');
      await rejects(launcher.launch(id('Missing')), /org.freedesktop.DBus.Error.ServiceUnknown/);
      await rejects(launcher.launch(id('Wrong')), /org.freedesktop.DBus.Error.UnknownMethod/);
      await rejects(launcher.launch(id('StartFailure')), /org.freedesktop.DBus.Error.Spawn.ChildExited/);
      await rejects(launcher.launch(id('Error')), /org.pollyui.ActivationFixture.Failed/);
      await rejects(launcher.launch(id('Malformed')), /POLLY_ACTIVATION_INVALID_REPLY/);
      const start = Date.now();
      await rejects(launcher.launch(id('Timeout')), /POLLY_ACTIVATION_TIMEOUT|org.freedesktop.DBus.Error.NoReply/);
      check(Date.now() - start >= 2500 && Date.now() - start < 6000, 'native no-reply deadline is bounded');
      await rejects(launcher.launch(id('Oversized')),
        /POLLY_ACTIVATION_DISCONNECTED|org.freedesktop.DBus.Error.Disconnected|POLLY_ACTIVATION_TIMEOUT|org.freedesktop.DBus.Error.NoReply|POLLY_ACTIVATION_INVALID_REPLY/);
    } else if (mode === 'bounds') {
      const requests = [];
      for (let i = 0; i < 8; i++) requests.push(desktop.activateApplication(id('Timeout')));
      throws(() => desktop.activateApplication(id('Timeout')), /queue is full/);
      let ticks = 0;
      const timer = setInterval(() => ticks++, 20);
      for (const result of await Promise.allSettled(requests))
        check(result.status === 'rejected' &&
          /POLLY_ACTIVATION_TIMEOUT|org.freedesktop.DBus.Error.NoReply/.test(String(result.reason.code)),
          'bounded pending request ends in an explicit timeout, never success-shaped');
      clearInterval(timer);
      check(ticks >= 10, 'native pending activation does not block the UI timer pump');
    } else if (mode === 'late-reply') {
      let acknowledged = false;
      const pending = desktop.activateApplication(id('LateReply')).then(
        result => { acknowledged = true; return { result }; }, error => ({ error }));
      console.log('WAIT: late reply queued');
      await new Promise((resolve, reject) => {
        const deadline = Date.now() + 5000;
        const timer = setInterval(() => {
          if (desktop.applicationFiles().some(entry => entry.id === id('BlockNow'))) {
            clearInterval(timer); resolve();
          } else if (Date.now() >= deadline) {
            clearInterval(timer); reject(new Error('Missing synthetic blocked-pump rendezvous'));
          }
        }, 10);
      });
      console.log('WAIT: blocking native pump after actual service delivery');
      const until = Date.now() + 4000;
      while (Date.now() < until) {}
      const completed = await pending;
      check(!acknowledged && completed.error && completed.error.code === 'POLLY_ACTIVATION_TIMEOUT' &&
        String(completed.error).includes('indeterminate'),
        'absolute deadline rejects an actual late method-return queued while the native pump was blocked');
    } else if (mode === 'rediscovery') {
      check(launcher.refresh().some(entry => entry.id === id('Deleted')), 'entry exists before rediscovery');
      console.log('WAIT: mutate synthetic entries');
      await new Promise(resolve => setTimeout(resolve, 500));
      throws(() => launcher.launch(id('Deleted')), /no longer available/);
      throws(() => launcher.launch(id('Masked')), /no longer available/);
    } else if (mode === 'disconnect') {
      const pending = desktop.activateApplication(id('Disconnect'));
      console.log('WAIT: disconnect synthetic daemon');
      await rejects(pending, /POLLY_ACTIVATION_DISCONNECTED|org.freedesktop.DBus.Error.Disconnected/);
    } else if (mode === 'shutdown') {
      desktop.activateApplication(id('Timeout')).catch(error => console.log('SHUTDOWN: ' + error.code));
      setTimeout(() => window.close(), 500);
      console.log('PASS: pending request will be cancelled by native shutdown');
      return;
    } else throw new Error('Unknown fixture mode: ' + mode);
  }
  check(spawned === 0, 'no Exec fallback or synthetic PID path was used');
  window.close();
}
run().catch(error => { console.error('FAIL: ' + String(error) + '\n' + (error.stack || '')); window.quit(); });
