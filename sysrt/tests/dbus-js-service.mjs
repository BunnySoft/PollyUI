import { openDbusService, shutdownDbus } from './sysrt/sdk/js/dbus.mjs';
import {
  check, refuses, descriptorCount, print, pause, monotonicNanoseconds, dispose,
} from './sysrt/tests/dbus-endpoint-support.mjs';

const name = 'org.polly.JSService', path = '/org/polly/JSService';
const signature = (signature, replySignature) => ({ signature, replySignature });
const options = {
  name, path, interface: name,
  methods: {
    Increment: signature('u', 'u'), Toggle: signature('b', 'b'),
    Echo: signature('s', 's'), EchoPath: signature('o', 'o'),
    Empty: signature('', ''), Tuple: signature('', 'ubso'),
    Headers: signature('', 'usssss'), Count: signature('', 'u'),
    Delay: signature('u', 'u'), Hold: signature('s', ''),
    Fail: signature('', ''), Once: signature('', ''),
    Validate: signature('', 'ubso'), CloseSecondary: signature('', ''),
    HeldCount: signature('', 'u'), CloseRequest: signature('', ''),
    NoReply: signature('', ''), NoReplyError: signature('', ''),
    Finish: signature('', ''),
  },
};
const baseline = descriptorCount(), delayed = [], held = [];
let service, secondary, done = false, effects = 0, admitted = 0;
try {
  for (const invalid of [
    { ...options, name: ':1.42' }, { ...options, name: 'bad' },
    { ...options, path: 'relative' }, { ...options, interface: 'bad' },
    { ...options, methods: { 'bad.member': signature('', '') } },
    { ...options, methods: { Bad: signature('uu', '') } },
    { ...options, methods: { Bad: signature('', 'v') } },
    { ...options, methods: { Bad: signature('', 's'.repeat(256)) } },
    { ...options, ambient: true },
  ]) refuses(() => openDbusService(processChild, invalid));
  let nameReads = 0;
  const snapshot = { ...options, methods: { ...options.methods, Increment: signature('u', 'u') },
    get name() { return ++nameReads === 1 ? name : 'bad'; } };
  service = openDbusService(processChild, snapshot);
  check(nameReads === 1, 'Service validates and claims the same option snapshot');
  snapshot.methods.Increment.signature = 's';
  refuses(() => shutdownDbus(), 'ERR_DBUS_BUSY');
  refuses(() => openDbusService(processChild, options), 'ERR_DBUS_NAME_OWNED');
  secondary = openDbusService(processChild, {
    ...options, name: name + '.Secondary', methods: { Hold: signature('s', 'u') },
  });
  print('READY ' + fixtureRun + ' ' + expectedProcessId);
  const deadline = monotonicNanoseconds() + 80000000000n;
  while (!done) {
    check(monotonicNanoseconds() < deadline, 'JS service deadline');
    const before = monotonicNanoseconds(), request = service.poll();
    check(monotonicNanoseconds() - before < 100000000n, 'Service poll is zero-wait');
    if (secondary) {
      const retained = secondary.poll();
      if (retained) { check(retained.target.member === 'Hold', 'Secondary method'); held.push(retained); }
    }
    if (request) {
      check(Object.isFrozen(request) && Object.isFrozen(request.target) && Object.isFrozen(request.args),
        'Request and copied target/arguments are immutable');
      check(request.target.destination === name && request.target.path === path &&
        request.target.interface === name && request.sender.startsWith(':'),
        'Native method headers are copied safely');
      admitted++;
      switch (request.target.member) {
        case 'Increment':
          effects++; request.reply([(request.args[0] + 1) >>> 0]); break;
        case 'Toggle': request.reply([!request.args[0]]); break;
        case 'Echo': case 'EchoPath': request.reply(request.args); break;
        case 'Empty': request.reply(); break;
        case 'Tuple': request.reply([7, true, 'tuple \u20ac', path]); break;
        case 'Headers':
          request.reply([expectedProcessId, request.sender, request.target.destination,
            request.target.path, request.target.interface, request.target.member]);
          check(request.target.member === 'Headers' && request.sender.startsWith(':'),
            'Copied headers survive response/unref');
          break;
        case 'Count': request.reply([effects]); break;
        case 'HeldCount': request.reply([held.length]); break;
        case 'CloseRequest':
          request.close(); request.close();
          refuses(() => request.reply(), 'ERR_DBUS_REQUEST_CLOSED'); break;
        case 'Delay':
          effects++; delayed.push({ request, due: monotonicNanoseconds() + 250000000n }); break;
        case 'Hold': held.push(request); break;
        case 'Fail':
          check(request.error('org.polly.JSService.Failed', 'Explicit JS failure \u20ac').state === 'accepted',
            'Native error send acceptance');
          refuses(() => request.reply(), 'ERR_DBUS_REQUEST_CLOSED');
          refuses(() => request.error('org.polly.JSService.Failed', ''), 'ERR_DBUS_REQUEST_CLOSED');
          request.close(); request.close(); break;
        case 'Once':
          check(request.reply().state === 'accepted', 'Native return send acceptance');
          refuses(() => request.reply(), 'ERR_DBUS_REQUEST_CLOSED');
          refuses(() => request.error('org.polly.JSService.Failed', ''), 'ERR_DBUS_REQUEST_CLOSED');
          request.close(); request.close(); break;
        case 'Validate':
          for (const args of [
            [], [-1, true, '', path], [0x100000000, true, '', path],
            [7, 1, '', path], [7, true, 'bad\0string', path],
            [7, true, '\ud800', path], [7, true, '', 'relative'],
          ]) refuses(() => request.reply(args));
          refuses(() => request.error('bad', 'message'));
          refuses(() => request.error('org.polly.Test.Error', 'bad\0message'));
          refuses(() => request.error('org.polly.Test.Error', '\ud800'));
          request.reply([7, false, '', path]); break;
        case 'NoReply': case 'NoReplyError': {
          check(request.noReply, 'Native no-reply flag');
          effects++;
          const outcome = request.target.member === 'NoReply' ? request.reply() :
            request.error('org.polly.JSService.Failed', 'Must be suppressed');
          check(outcome.state === 'suppressed', 'No-reply method does not queue a response');
          refuses(() => request.reply(), 'ERR_DBUS_REQUEST_CLOSED');
          break;
        }
        case 'CloseSecondary':
          check(held.length === 1, 'Retained secondary request was admitted before close');
          refuses(() => held[0].reply([true]));
          const args = [];
          Object.defineProperty(args, 0, { get() { secondary.close(); return 7; } });
          refuses(() => held[0].reply(args), 'ERR_DBUS_REQUEST_CLOSED');
          secondary.close(); secondary.close(); secondary = null;
          refuses(() => shutdownDbus(), 'ERR_DBUS_BUSY');
          for (const retained of held) {
            check(retained.args[0] === 'retained \u20ac', 'Copied string survives service close');
            refuses(() => retained.reply(), 'ERR_DBUS_REQUEST_CLOSED');
            refuses(() => retained.error('org.polly.Test.Error', 'closed'), 'ERR_DBUS_REQUEST_CLOSED');
            retained.close(); retained.close();
          }
          held.length = 0; request.reply(); break;
        case 'Finish': request.reply(); done = true; break;
        default: throw new Error('Undeclared method reached the JS handler');
      }
    }
    for (let index = delayed.length - 1; index >= 0; index--) {
      const item = delayed[index];
      if (monotonicNanoseconds() >= item.due) {
        item.request.reply([(item.request.args[0] + 1) >>> 0]);
        refuses(() => item.request.reply(), 'ERR_DBUS_REQUEST_CLOSED');
        check(item.request.args[0] >= 0, 'Copied argument survives late response');
        delayed.splice(index, 1);
      }
    }
    await pause();
  }
  // Acceptance is not a flush: keep driving zero-wait I/O before teardown.
  const drain = monotonicNanoseconds() + 50000000n;
  while (monotonicNanoseconds() < drain) { service.poll(); await pause(); }
  check(admitted > 0, 'Service handled real incoming requests');
} finally {
  secondary?.close(); service?.close();
  for (const { request } of delayed) {
    refuses(() => request.reply(), 'ERR_DBUS_REQUEST_CLOSED'); request.close();
  }
  for (const request of held) {
    refuses(() => request.reply(), 'ERR_DBUS_REQUEST_CLOSED'); request.close();
  }
  if (service) refuses(() => service.poll(), 'ERR_DBUS_CLOSED');
  check(descriptorCount() === baseline, 'JS service native descriptors return to baseline');
  shutdownDbus(); shutdownDbus(); dispose();
}
