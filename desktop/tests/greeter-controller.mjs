import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGreeterController } from '../session/greeter-controller.mjs';

function fixture(screen = 'setup') {
  const calls = [];
  let settle, fail, clears = 0, leaves = 0;
  const pending = () => new Promise((resolve, reject) => { settle = resolve; fail = reject; });
  const controller = createGreeterController({
    backend: {
      status: async () => screen,
      setup: (...args) => { calls.push(['setup', ...args]); return pending(); },
      login: (...args) => { calls.push(['login', ...args]); return pending(); },
      cancel: () => calls.push(['cancel']),
    },
    clear: () => clears++,
    leave: () => leaves++,
  });
  return { controller, calls, settle: value => settle(value), fail: error => fail(error),
    clears: () => clears, leaves: () => leaves };
}
const values = () => ({ polly: 'synthetic-polly', pollyConfirm: 'synthetic-polly',
  root: 'synthetic-root', rootConfirm: 'synthetic-root' });

test('two confirmations and separate nonempty passwords are required before any backend call', async () => {
  for (const invalid of [
    { pollyConfirm: 'mismatch' }, { rootConfirm: 'mismatch' },
    { root: 'synthetic-polly', rootConfirm: 'synthetic-polly' },
    { polly: '' }, { polly: 'line\nbreak' }, { root: 'nul\0byte' },
  ]) {
    const f = fixture();
    await f.controller.refresh();
    await f.controller.submit({ ...values(), ...invalid });
    assert.equal(f.calls.length, 0);
    assert.equal(f.controller.state().screen, 'setup');
    assert.equal(f.controller.state().busy, false);
    assert.ok(f.clears() >= 2);
  }
});

test('setup clears caller values immediately, displays progress, and proceeds to login only on real completion', async () => {
  const f = fixture();
  await f.controller.refresh();
  const input = values();
  const operation = f.controller.submit(input);
  assert.deepEqual(Object.values(input), ['', '', '', '']);
  assert.equal(f.controller.state().busy, true);
  f.controller.progress('root');
  assert.match(f.controller.state().message, /root maintenance/);
  f.controller.progress('prepared');
  f.controller.progress('committing');
  f.controller.cancel();
  assert.equal(f.calls.filter(call => call[0] === 'cancel').length, 0);
  f.settle('login');
  await operation;
  assert.equal(f.controller.state().screen, 'login');
  assert.equal(f.leaves(), 0);
});

test('cancel waits for backend cancellation, never publishes initialized success, and allows retry', async () => {
  const f = fixture();
  await f.controller.refresh();
  const operation = f.controller.submit(values());
  f.controller.cancel();
  assert.equal(f.controller.state().busy, true);
  assert.equal(f.calls.at(-1)[0], 'cancel');
  f.settle('cancelled');
  await operation;
  assert.equal(f.controller.state().screen, 'setup');
  assert.match(f.controller.state().message, /remains incomplete/);
  const retry = f.controller.submit(values());
  f.fail({ code: 'password-policy' });
  await retry;
  assert.equal(f.controller.state().busy, false);
  assert.equal(f.controller.state().screen, 'setup');
});

test('wrong password is visible and retry only leaves UI after backend schedules handoff', async () => {
  const f = fixture('login');
  await f.controller.refresh();
  const operation = f.controller.submit({ polly: 'synthetic-wrong' });
  f.fail({ code: 'denied' });
  await operation;
  assert.match(f.controller.state().message, /not accepted/);
  assert.equal(f.leaves(), 0);
  const retry = f.controller.submit({ polly: 'synthetic-right' });
  f.settle('handoff');
  await retry;
  assert.equal(f.leaves(), 1);
});

test('close clears inputs, cancels once, and discards a late success callback', async () => {
  const f = fixture('login');
  await f.controller.refresh();
  const operation = f.controller.submit({ polly: 'synthetic' });
  f.controller.close();
  f.controller.close();
  f.settle('handoff');
  await operation;
  assert.equal(f.calls.filter(call => call[0] === 'cancel').length, 1);
  assert.equal(f.leaves(), 0);
});

test('unavailable and malformed backend state remain visibly blocked', async () => {
  const f = fixture('root');
  await f.controller.refresh();
  assert.equal(f.controller.state().screen, 'error');
  assert.match(f.controller.state().message, /unavailable/);
  await f.controller.submit(values());
  assert.equal(f.calls.length, 0);
});

test('UTF-8 password bounds are exact, not UTF-16 character counts', async () => {
  for (const password of ['a'.repeat(1024), '\u00e9'.repeat(512), '\ud83d\ude42'.repeat(256)]) {
    const f = fixture('login');
    await f.controller.refresh();
    const operation = f.controller.submit({ polly: password });
    assert.equal(f.calls.length, 1);
    f.fail({ code: 'denied' });
    await operation;
  }
  for (const password of ['a'.repeat(1025), '\u00e9'.repeat(513), '\ud83d\ude42'.repeat(257), '\ud800']) {
    const f = fixture('login');
    await f.controller.refresh();
    const input = { polly: password };
    await f.controller.submit(input);
    assert.equal(f.calls.length, 0);
    assert.equal(input.polly, '');
    assert.match(f.controller.state().message, /1024 UTF-8 bytes/);
  }
});
