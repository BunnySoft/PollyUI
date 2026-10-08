import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
register('./root-loader.mjs', import.meta.url);
const { createSessionExitController, createLogoutSurface } = await import('../shell/session-exit.mjs');

function fixture() {
  let current = { version: 1, phase: 'idle', pendingWindows: 1, pendingApplications: 1,
    pendingActivations: 0, windows: [{ title: 'Unsaved note', appId: 'notes' }], applications: ['notes'],
    error: '', profile: 'installed' };
  const calls = [], reports = [];
  const native = {
    sessionExitState() { calls.push('inspect'); return { ...current }; },
    beginSessionExit() { calls.push('close'); current.phase = 'waiting'; return { ...current }; },
    cancelSessionExit() { calls.push('cancel'); current.phase = 'idle'; return { ...current }; },
    sealSessionExit() { calls.push('seal'); current.phase = 'committed'; return { ...current }; },
  };
  const controller = createSessionExitController({ native, report: message => reports.push(message) });
  return { controller, calls, reports, current, ready() {
    Object.assign(current, { phase: 'ready', pendingWindows: 0, pendingApplications: 0,
      pendingActivations: 0, windows: [], applications: [] });
    controller.refresh();
  } };
}

test('confirmation closes nothing; app Save/Cancel and repeated clicks retain the session', async () => {
  const f = fixture();
  let committed = 0;
  assert.equal(f.controller.request({ action: 'logout', commit: () => committed++ }), true);
  assert.deepEqual(f.calls, ['inspect']);
  f.controller.confirm(); f.controller.confirm();
  assert.equal(f.calls.filter(call => call === 'close').length, 1);
  await f.controller.confirmCommit();
  assert.equal(committed, 0); assert.equal(f.controller.snapshot().phase, 'waiting');
  assert.equal(f.controller.request({ action: 'logout', commit: () => committed++ }), false);
  f.controller.retry();
  assert.equal(f.calls.filter(call => call === 'close').length, 2);
  assert.equal(f.controller.cancel(), true);
  assert.equal(f.controller.snapshot().phase, 'idle'); assert.equal(committed, 0);
});

test('actual windows, processes and activation must all settle; a fresh late window prevents commit', async () => {
  const f = fixture(); let committed = 0;
  f.controller.request({ action: 'logout', commit: () => committed++ }); f.controller.confirm();
  f.ready();
  f.current.pendingApplications = 1; f.controller.refresh();
  assert.equal(f.controller.snapshot().phase, 'waiting');
  f.current.pendingApplications = 0; f.current.pendingActivations = 1; f.controller.refresh();
  assert.equal(f.controller.snapshot().phase, 'waiting');
  f.ready(); f.current.pendingWindows = 1;
  await f.controller.confirmCommit();
  assert.equal(committed, 0); assert.equal(f.calls.includes('seal'), false);
});

test('ready closes and seals only once; cancel cannot interrupt a committed operation', async () => {
  const f = fixture(); let complete, committed = 0;
  f.controller.request({ action: 'reboot', commit: () => { committed++; return new Promise(resolve => { complete = resolve; }); } });
  f.controller.confirm(); f.ready();
  const operation = f.controller.confirmCommit();
  assert.equal(f.controller.snapshot().phase, 'committing');
  assert.equal(f.controller.cancel(), false);
  await f.controller.confirmCommit(); assert.equal(committed, 1);
  complete(); await operation;
  assert.equal(f.controller.snapshot().phase, 'complete');
});

test('known not-sent rejection can release the barrier; uncertain delivery is never replayed', async () => {
  for (const sent of [false, true]) {
    const f = fixture(); let committed = 0;
    f.controller.request({ action: 'poweroff', commit: async () => {
      committed++; throw Object.assign(new Error('test failure'), { sent });
    } });
    f.controller.confirm(); f.ready(); await f.controller.confirmCommit();
    assert.equal(f.controller.snapshot().phase, sent ? 'uncertain' : 'blocked');
    assert.equal(f.controller.cancel(), !sent);
    await f.controller.confirmCommit(); assert.equal(committed, 1);
    assert.equal(f.reports.length, 1);
  }
});

test('failed/invalid native snapshots are visible and cannot become empty successful exit', async () => {
  const f = fixture();
  f.controller.request({ action: 'logout', commit: () => assert.fail('must retain session') });
  f.controller.confirm();
  f.current.error = 'Application exit was not confirmed'; f.controller.refresh();
  assert.equal(f.controller.snapshot().phase, 'blocked');
  assert.equal(f.controller.cancel(), true);
  f.current.error = ''; f.current.pendingWindows = -1;
  assert.throws(() => f.controller.request({ action: 'logout', commit() {} }), /invalid/);
  assert.throws(() => createSessionExitController({ native: {} }).request({ action: 'logout', commit() {} }), /does not support/);
});

test('stop/cancel and restart invalidate late callbacks without reviving exited apps', async () => {
  const f = fixture(); let complete;
  f.controller.request({ action: 'poweroff', commit: () => new Promise(resolve => { complete = resolve; }) });
  f.controller.confirm(); f.ready();
  const operation = f.controller.confirmCommit();
  f.controller.stop(); complete(); await operation;
  assert.equal(f.controller.snapshot().phase, 'committing');
  assert.equal(f.controller.request({ action: 'logout', commit() {} }), false);
});

test('cancellation during a changed callback invalidates subsequent close or commit dispatch', async () => {
  const f = fixture(); let committed = 0;
  f.controller.request({ action: 'logout', commit: () => committed++ });
  const cancelClose = f.controller.subscribe(state => {
    if (state.phase === 'waiting') f.controller.cancel();
  });

  f.controller.confirm();
  assert.equal(f.calls.includes('close'), false);
  cancelClose();
  f.controller.request({ action: 'logout', commit: () => committed++ }); f.controller.confirm(); f.ready();
  const cancelCommit = f.controller.subscribe(state => {
    if (state.phase === 'ready') f.controller.cancel();
  });
  await f.controller.confirmCommit();
  cancelCommit();
  assert.equal(f.calls.includes('seal'), false);
  assert.equal(committed, 0);
});

test('a retired logout surface close callback cannot cancel a reopened confirmation', async t => {
  const { fixtureHost } = await import('./file-dialog-fixtures.mjs');
  const { host } = fixtureHost(t);
  host.displays = () => [{ id: 1, width: 800, height: 600 }];
  const f = fixture();
  const surface = createLogoutSurface({ controller: f.controller, host, commit() {},
    theme: () => ({ colors: { text: '#000000', border: '#999999', surface: '#ffffff', body: '#eeeeee' } }) });
  const old = surface.show(1);
  old.close = function () { this.closed = true; };
  f.controller.stop(); surface.stop(); f.controller.start();
  const current = surface.show(1);
  old.onclose();
  assert.equal(f.controller.snapshot().phase, 'confirm');
  assert.equal(current.closed, false);
  f.controller.stop(); surface.stop();
});
