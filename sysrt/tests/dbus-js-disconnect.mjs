import { openDbusService, openDbusClient, shutdownDbus } from './sysrt/sdk/js/dbus.mjs';
import {
  check, refuses, descriptorCount, print, pause, result, monotonicNanoseconds, dispose,
} from './sysrt/tests/dbus-endpoint-support.mjs';

const { address, role } = JSON.parse(processChild);
const name = 'org.polly.JSDisconnect', path = '/org/polly/JSDisconnect';
const target = member => ({ destination: name, path, interface: name, member });
const baseline = descriptorCount(), retained = [];
let endpoint;
try {
  if (fixtureRun === 0) {
    const deadline = monotonicNanoseconds() + 15000000000n;
    if (role === 'service') {
      endpoint = openDbusService(address, {
        name, path, interface: name,
        methods: { Hold: { signature: 's', replySignature: '' }, Ready: { signature: '', replySignature: 'u' } },
      });
      print('SERVICE_READY ' + expectedProcessId);
      for (;;) {
        check(monotonicNanoseconds() < deadline, 'Service disconnect deadline');
        let request;
        try { request = endpoint.poll(); } catch (error) {
          check(error.code === 'ERR_DBUS_DISCONNECTED', 'Service detects actual bus disconnection: ' + error);
          break;
        }
        if (request?.target.member === 'Hold') retained.push(request);
        else if (request) request.reply([retained.length]);
        await pause();
      }
      check(retained.length === 1, 'Disconnect closes an actually retained native message');
      check(retained[0].args[0] === 'disconnect \u20ac' && retained[0].sender.startsWith(':'),
        'Copied sender/string survive disconnect');
      refuses(() => retained[0].reply(), 'ERR_DBUS_REQUEST_CLOSED');
      refuses(() => retained[0].error('org.polly.Test.Error', 'closed'), 'ERR_DBUS_REQUEST_CLOSED');
      retained[0].close(); retained[0].close();
      refuses(() => endpoint.poll(), 'ERR_DBUS_DISCONNECTED');
    } else {
      check(role === 'client', 'Known private disconnect role');
      endpoint = openDbusClient(address);
      const held = endpoint.call(target('Hold'), 's', ['disconnect \u20ac'], '');
      held.poll();
      for (;;) {
        const ready = await result(endpoint.call(target('Ready'), '', [], 'u'));
        check(ready.state === 'reply', 'Readiness RPC');
        if (ready.value === 1) break;
        check(monotonicNanoseconds() < deadline, 'Client disconnect admission deadline');
        await pause();
      }
      print('CLIENT_READY ' + expectedProcessId);
      const outcome = await result(held);
      check(outcome.state === 'error' &&
        (outcome.error.code === 'ERR_DBUS_DISCONNECTED' ||
         outcome.error.dbusName === 'org.freedesktop.DBus.Error.NoReply'),
        'Pending client observes actual disconnect/native NoReply');
      try { endpoint.call(target('Ready'), '', [], 'u'); throw new Error('Disconnected client admitted a call'); }
      catch (error) { check(['ERR_DBUS_DISCONNECTED', 'ERR_DBUS_CLOSED'].includes(error.code), 'Disconnect rejects admission'); }
      check(held.poll() === outcome && held.cancel() === outcome, 'Disconnect result cannot revive/replay');
    }
  }
} finally {
  endpoint?.close(); endpoint?.close();
  check(descriptorCount() === baseline, 'Disconnect descriptors return to baseline');
  shutdownDbus(); shutdownDbus(); dispose();
}
