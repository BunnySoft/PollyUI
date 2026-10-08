// New-engine DOM/input fixture only: synthetic backend and window lifecycle, not PAM/seat proof.
function check(value, message) { if (!value) throw new Error(message); }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition) {
  for (let i = 0; i < 200; i++) { host.flush(); if (condition()) return; await wait(5); }
  throw new Error('Native DOM greeter fixture timed out');
}
const intervals = [];
globalThis.setInterval = callback => { intervals.push(callback); return intervals.length; };
let left = false;
globalThis.window = {
  close() {},
  quit() { left = true; },
  displays: () => [{ id: 1, width: host.width, height: host.height }],
  create() {
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
    return { document, closed: false, onclose: null,
      close() { this.closed = true; this.onclose?.(); } };
  },
};
const calls = [];
let complete, fail;
const pending = () => new Promise((resolve, reject) => { complete = resolve; fail = reject; });
globalThis.graphicalAuth = {
  status: async () => 'setup',
  setup: () => { calls.push('setup'); return pending(); },
  login: () => { calls.push('login'); return pending(); },
  cancel: () => calls.push('cancel'),
};
await import('./desktop/session/greeter.mjs');
const field = name => document.getElementById('greeter-password-' + name);
const status = () => document.getElementById('greeter-status')?.textContent ?? '';
function input(name, value) {
  const node = field(name);
  host.render();
  host.mouse('mousedown', node.offsetLeft + 12, node.offsetTop + 12);
  host.mouse('mouseup', node.offsetLeft + 12, node.offsetTop + 12);
  host.text(value);
  host.flush();
  check(document.activeElement === node, 'Pointer focuses the actual native DOM password field');
  check(!node.textContent.includes(value), 'Credential text is masked in the actual rendered DOM');
}
function fill(confirm = 'synthetic-polly') {
  input('polly', 'synthetic-polly');
  host.key('Tab');
  check(document.activeElement === field('pollyConfirm'), 'Tab follows polly confirmation');
  input('pollyConfirm', confirm);
  input('root', 'synthetic-root');
  host.key('Tab');
  check(document.activeElement === field('rootConfirm'), 'Tab follows root confirmation');
  input('rootConfirm', 'synthetic-root');
}
await until(() => field('rootConfirm'));
fill('mismatch');
host.key('Enter');
await until(() => status().includes('confirmations'));
check(calls.length === 0, 'Mismatches never reach the backend');
for (const name of ['polly', 'pollyConfirm', 'root', 'rootConfirm'])
  check(field(name).textContent === '', 'All mismatched secrets are cleared');
fill();
host.key('Enter');
await until(() => calls[0] === 'setup');
graphicalAuth.onProgress('root');
check(status().includes('root maintenance'), 'Native DOM displays backend progress');
host.render();
const cancel = document.getElementById('greeter-cancel');
host.click(cancel.offsetLeft + 10, cancel.offsetTop + 10);
check(calls.at(-1) === 'cancel', 'Pointer cancellation reaches backend once');
complete('cancelled');
await until(() => status().includes('remains incomplete'));
check(!left, 'Cancellation does not leave the greeter');
fill();
host.key('Enter');
complete('login');
await until(() => field('polly') && !field('root'));
input('polly', 'synthetic-wrong');
host.key('Enter');
fail({ code: 'denied' });
await until(() => status().includes('not accepted'));
check(!left && field('polly').textContent === '', 'Wrong-password retry clears secrets and retains greeter');
input('polly', 'synthetic-right');
host.key('Enter');
complete('handoff');
await until(() => left);
check(calls.filter(value => value === 'setup').length === 2 &&
  calls.filter(value => value === 'login').length === 2, 'Only confirmed setup and explicit login attempts submit');
console.log('POLLY_GREETER_NATIVE_DOM_PASS pointer=1 tab=1 enter=1 masked=1 mismatch-no-action=1 cancel=1 retry=1 backend=synthetic windows=synthetic logind-tested=0');
