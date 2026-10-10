import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
register('../../../tests/menu-host-loader.mjs', import.meta.url);
const { createNativeTargetProvider } = await import('../logic/native-provider.mjs');
const { createTargetController } = await import('../logic/target-controller.mjs');
const { makeFixtureEnvelope } = await import('./fixtures.mjs');
const request = (requestId = 1, previousGeneration = null) =>
  ({ purpose: 'refresh', requestId, previousGeneration });
const tick = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
function native(readReport, cancel = () => {}) {
  return { installTargets: { protocolVersion: 1, transport: 'fixed-unprivileged-v1', readReport, cancel } };
}

test('explicit fixed API only; no old binary, arbitrary commands or UI source claims', async () => {
  for (const api of [null, {}, { installTargets: {} },
    { installTargets: { protocolVersion: 0, transport: 'fixed-unprivileged-v1' } }])
    assert.throws(() => createNativeTargetProvider(api), /missing or incompatible/);
  let calls = 0;
  const provider = createNativeTargetProvider(native((...args) => {
    assert.deepEqual(args, []); calls++; return makeFixtureEnvelope('fixed-1');
  }));
  for (const bad of [{ ...request(), requestId: Number.MAX_SAFE_INTEGER + 1 },
    { ...request(), purpose: 'exec' }, { ...request(), previousGeneration: {} }])
    await assert.rejects(provider.readReport(bad), /bounded/);
  assert.equal(calls, 0);
  const result = await provider.readReport(request());
  assert.equal(result.writeAuthorized, false); assert.ok(Object.isFrozen(result));
  await assert.rejects(provider.readReport(request(2, result.generation)), /reused/);
});

test('malformed, partial, oversized and unsafe integer envelopes never qualify', async () => {
  const mutations = [
    value => { delete value.report; },
    value => { value.writeAuthorized = true; },
    value => { value.source.description = 'x'.repeat(4097); },
    value => { value.source.downloadedBytes = Number.MAX_SAFE_INTEGER + 1; },
    value => { value.report.devices = Array(257).fill(value.report.devices[0]); },
  ];
  for (const mutate of mutations) {
    const value = makeFixtureEnvelope(); mutate(value);
    const provider = createNativeTargetProvider(native(() => value));
    await assert.rejects(provider.readReport(request()), /Invalid read-only/);
  }
});

test('cancel waits for native reap, superseded calls cannot launch a second child early', async () => {
  let release, calls = 0, cancels = 0;
  const provider = createNativeTargetProvider(native(() => {
    calls++;
    return calls === 1 ? new Promise((resolve, reject) => { release = reject; }) :
      makeFixtureEnvelope('fixed-' + calls);
  }, () => { cancels++; }));
  const first = provider.readReport(request()); first.catch(() => {});
  const second = provider.readReport(request(2));
  const third = provider.readReport(request(3));
  second.catch(() => {});
  assert.equal(calls, 1); assert.equal(cancels, 2);
  release(new Error('Native child cancelled and reaped'));
  await assert.rejects(first, /cancelled/);
  await assert.rejects(second, /superseded/);
  assert.equal((await third).generation, 'fixed-2');
  assert.equal(calls, 2);
});

test('controller timeout/cancel/close terminate the transport and preserve late-result barriers', async () => {
  for (const mode of ['timeout', 'cancel', 'close']) {
    let release, cancels = 0, reads = 0;
    const provider = createNativeTargetProvider(native(() => {
      reads++; return new Promise(resolve => { release = resolve; });
    }, () => { cancels++; }));
    const errors = [];
    const controller = createTargetController({ provider, timeoutMs: 5,
      reportError: error => errors.push(error) });
    const first = controller.refresh(); await tick();
    if (mode === 'cancel') controller.cancel();
    if (mode === 'close') controller.dispose();
    const outcome = await first;
    assert.equal(outcome.status, mode === 'timeout' ? 'error' : mode === 'cancel' ? 'cancelled' : 'disposed');
    assert.ok(cancels >= 1); assert.equal(reads, 1);
    release(makeFixtureEnvelope('late'));
    await tick();
    assert.equal(controller.getState().selection, null);
    assert.notEqual(controller.getState().envelope?.generation, 'late');
    if (mode === 'close') await assert.rejects(provider.readReport(request(2)), /stopped/);
    controller.dispose();
  }
});

test('native disconnect/replay errors are visible and source changes revoke consent', async () => {
  let count = 0;
  const provider = createNativeTargetProvider(native(() => {
    count++;
    if (count === 3) throw new Error('Fixed helper disconnected');
    const value = makeFixtureEnvelope('fixed-' + count);
    if (count === 2) value.source.description += ' replaced source receipt';
    return value;
  }));
  const errors = [];
  const controller = createTargetController({ provider, reportError: value => errors.push(value) });
  await controller.refresh();
  let state = controller.getState();
  controller.select(state.envelope.report.devices.find(item => item.eligible).entryId, state.generation);
  state = controller.getState(); controller.acknowledgeScope(state.generation, state.selection);
  state = controller.getState();
  assert.equal((await controller.confirm(state.generation, state.selection)).status, 'invalidated');
  assert.ok(controller.getState().reasons.some(item => item.code === 'source-changed'));
  assert.equal((await controller.refresh()).status, 'error');
  assert.match(errors[0], /disconnected/);
  controller.dispose();
});
