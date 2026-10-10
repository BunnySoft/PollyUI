import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

register('../../../tests/menu-host-loader.mjs', import.meta.url);
const { parseTargetEnvelope, bindTarget, reidentifyTarget, selectable, formatBytes } =
  await import('../logic/target-model.mjs');
const { createTargetController } = await import('../logic/target-controller.mjs');
const { makeFixtureEnvelope, createFixtureProvider } = await import('./fixtures.mjs');
const clone = value => JSON.parse(JSON.stringify(value));
const target = envelope => envelope.report.devices.find(entry => entry.entryId === 'entry-2');
const ro = value => { assert.equal(value.readOnly, true); assert.equal(value.writeAuthorized, false); };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function selected(t, provider = createFixtureProvider(), extra = {}) {
  const errors = [], changes = [];
  const controller = createTargetController({ provider, reportError: value => errors.push(value),
    onChange: value => { ro(value); changes.push(value); }, ...extra });
  t.after(() => controller.dispose());
  assert.equal((await controller.refresh()).status, 'ready');
  const state = controller.getState();
  assert.equal(state.selection, null);
  assert.equal(controller.select('entry-2', state.generation).status, 'selected');
  return { controller, errors, changes };
}
function acknowledge(controller) {
  const state = controller.getState();
  assert.equal(controller.acknowledgeScope(state.generation, state.selection).status, 'scope-acknowledged');
}
function confirm(controller) {
  const state = controller.getState();
  return controller.confirm(state.generation, state.selection);
}

test('inventory/source data, ineligible entries and exact clearing bytes are frozen and preserved', () => {
  const input = makeFixtureEnvelope();
  const parsed = parseTargetEnvelope(input);
  ro(parsed); ro(parsed.report);
  assert.equal(parsed.report.devices.length, 6);
  assert.equal(parsed.report.devices.filter(entry => entry.eligible).length, 1);
  assert.equal(parsed.report.devices[0].identity.serial, 'FIXTURE-HOST');
  assert.ok(parsed.report.devices[0].reasons.some(reason => reason.code === 'active-source'));
  assert.ok(parsed.report.devices[4].reasons.some(reason => reason.code === 'protected-model'));
  assert.ok(parsed.report.devices[5].reasons.some(reason => reason.code === 'protected-model'));
  assert.equal(target(parsed).clearingScope.endByteExclusive, 17179869184);
  assert.equal(target(parsed).clearingScope.startByte, 0);
  assert.equal(target(parsed).clearingScope.performed, false);
  assert.equal(target(parsed).partitions[0].startSector512, 2048);
  assert.deepEqual(target(parsed).raw, target(input).raw);
  assert.throws(() => { target(parsed).identity.serial = 'replacement'; }, TypeError);
  target(input).identity.serial = 'replacement';
  assert.equal(target(parsed).identity.serial, 'FIXTURE-USB-001');
  assert.match(formatBytes(null), /Unknown \(not zero\)/);
  assert.match(formatBytes(0), /^0 bytes/);
});

test('strict readonly schemas, numeric shape, source/kernel basis and bounded data reject visibly', async t => {
  const changes = {
    'envelope schema': value => { value.schemaVersion = 2; },
    'inventory schema': value => { value.report.schemaVersion = '1'; },
    'envelope authorization': value => { value.writeAuthorized = true; },
    'inventory authorization': value => { value.report.writeAuthorized = true; },
    'readonly flag': value => { value.report.readOnly = 'true'; },
    'unexpected field': value => { value.command = '/usr/bin/helper'; },
    'missing generation': value => { delete value.generation; },
    'duplicate entry IDs': value => { value.report.devices[0].entryId = 'entry-2'; },
    'string capacity': value => { target(value).capacityBytes = '17179869184'; },
    'rounded capacity': value => { target(value).capacityBytes = Number.MAX_SAFE_INTEGER + 1; },
    'float capacity': value => { target(value).capacityBytes = 16.5; },
    'scope performed': value => { target(value).clearingScope.performed = true; },
    'scope start': value => { target(value).clearingScope.startByte = 512; },
    'scope geometry': value => { target(value).clearingScope.endByteExclusive += 512; },
    'scope partitions': value => { target(value).clearingScope.partitions = []; },
    'missing identity': value => { target(value).identity.serial = null; target(value).identity.wwn = null; },
    'placeholder identity': value => { target(value).identity.serial = 'unknown'; target(value).identity.wwn = null; },
    'placeholder serial with WWN': value => { target(value).identity.serial = 'unknown'; },
    'unnormalized WWN': value => { target(value).identity.wwn = '0x1234567890abcdef'; },
    'duplicate serial': value => { value.report.devices[4].identity.serial = 'fixture-usb-001'; },
    'duplicate WWN': value => { value.report.devices[4].identity.wwn = target(value).identity.wwn; },
    'qualified with reason': value => { target(value).reasons.push({ code: 'mounted', message: 'Mounted' }); },
    'global error': value => { value.report.errors.push({ code: 'incomplete-context', message: 'Unknown root' }); },
    'missing raw': value => { delete target(value).raw; },
    'source field': value => { delete value.source.memoryLogicalBytes; },
    'source unknown cannot claim exact': value => { value.source.kind = 'unknown'; },
    'source basis empty': value => { value.source.kernelBasis = []; },
    'source basis unrelated': value => { value.source.kernelBasis = ['8:16']; },
    'source basis missing': value => { value.source.kernelBasis = ['9:99']; },
    'source nullable ID': value => { value.source.kernelBasis.push(null); },
    'source conflicting reason': value => { value.source.reasons = [{ code: 'unresolved', message: 'Unknown source' }]; },
    'kernel ID nullable': value => { target(value).observation.kernel.partitions.push(null); },
    'bounded entries': value => { value.report.devices = Array.from({ length: 257 }, () => target(value)); },
    'bounded text': value => { value.source.description = 'x'.repeat(4097); },
    'bounded bytes': value => { target(value).raw.evidence = 'x'.repeat(2 * 1024 * 1024); },
    'JSON function': value => { target(value).raw.callback = () => {}; },
    'nonplain object': value => { target(value).raw.other = new Date(); },
    'nonfinite number': value => { target(value).raw.other = Infinity; },
    'JSON getter': value => { Object.defineProperty(target(value).raw, 'other', { enumerable: true, get() { throw new Error('must not run'); } }); },
    'JSON depth': value => { let item = target(value).raw; for (let i = 0; i < 25; i++) item = item.nested = {}; },
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, () => {
    const input = makeFixtureEnvelope(); change(input);
    assert.throws(() => parseTargetEnvelope(input), /Invalid read-only target report/);
  });
});

test('unknown and duplicate ineligible entries remain displayable; no safe defaults', () => {
  const input = makeFixtureEnvelope();
  const unknown = input.report.devices[4];
  unknown.eligible = false;
  unknown.model = null; unknown.capacityBytes = null; unknown.removable = null;
  unknown.identity = { serial: null, wwn: null, model: null, capacityBytes: null, logicalSectorBytes: null };
  unknown.observation = { path: null, majorMinor: null, kname: null, kernel: null,
    parents: [], descendants: [], transport: null };
  unknown.clearingScope.endByteExclusive = null;
  unknown.reasons = [{ code: 'invalid-field', message: 'Unknown fields', detail: { missing: ['size', 'serial'] } }];
  const parsed = parseTargetEnvelope(input);
  assert.equal(parsed.report.devices.length, 6);
  assert.equal(parsed.report.devices[4].capacityBytes, null);
  assert.deepEqual(parsed.report.devices[4].reasons, unknown.reasons);
  const duplicate = makeFixtureEnvelope();
  target(duplicate).eligible = false;
  target(duplicate).reasons = [{ code: 'duplicate-stable-id', message: 'Duplicate' }];
  duplicate.report.devices[4].identity.serial = target(duplicate).identity.serial;
  duplicate.report.devices[4].reasons.push({ code: 'duplicate-stable-id', message: 'Duplicate' });
  assert.equal(parseTargetEnvelope(duplicate).report.devices.length, 6);
});

test('explicit selection is never automatic and requires scope acknowledgement', async t => {
  const { controller } = await selected(t);
  assert.equal((await confirm(controller)).status, 'blocked');
  assert.equal(controller.getState().scopeAcknowledged, false);
  acknowledge(controller);
  const state = controller.getState();
  assert.equal(controller.acknowledgeScope(state.generation, state.selection, false).status, 'scope-unchecked');
  assert.equal((await confirm(controller)).status, 'blocked');
  acknowledge(controller);
  const output = await confirm(controller); ro(output); ro(output.confirmation); ro(output.confirmation.target);
  assert.equal(output.status, 'confirmed-read-only');
  assert.equal(output.confirmation.kind, 'ui-only-scope-confirmation');
  assert.equal(output.confirmation.reidentifiedReportGeneration, 'synthetic-acquisition-2');
  assert.equal(output.confirmation.acknowledgedReportGeneration, 'synthetic-acquisition-1');
  assert.equal(output.confirmation.generation, controller.getState().generation);
  assert.equal(output.confirmation.target.generation, controller.getState().generation);
  assert.ok(!Object.hasOwn(output.confirmation, 'token'));
  assert.ok(!Object.hasOwn(output.confirmation.target, 'fingerprint'));
  const current = controller.getState();
  const onward = await controller.hypotheticalOnward(current.generation, current.confirmation);
  ro(onward); ro(onward.binding);
  assert.equal(onward.status, 'blocked-no-writer');
  assert.equal(onward.binding.reportGeneration, 'synthetic-acquisition-3');
  assert.equal(controller.getState().confirmation, null);
  assert.equal(controller.getState().phase, 'blocked');
});

test('readonly binding accepts serial-only or WWN-only real synthetic identities, not paths/models/RM', () => {
  for (const key of ['serial', 'wwn']) {
    const input = makeFixtureEnvelope(); target(input).identity[key] = null;
    const parsed = parseTargetEnvelope(input), binding = bindTarget(parsed, 'entry-2', 1);
    ro(binding); assert.ok(binding.identity.serial || binding.identity.wwn);
    assert.equal(binding.observation.path, '/dev/sdb');
  }
});

test('ineligible selection is an explicit rejection with no consent or writer', async t => {
  const { controller } = await selected(t);
  const result = controller.select('entry-0', controller.getState().generation);
  assert.equal(result.status, 'rejected'); ro(result);
  assert.equal(controller.getState().selection, null);
  assert.equal(controller.getState().phase, 'invalidated');
  assert.ok(controller.getState().reasons.length);
});

test('unknown storage source disables selection without hiding inventory/reasons', async t => {
  const input = makeFixtureEnvelope();
  input.source = { ...input.source, kind: 'unknown', exactSourceMapping: false,
    kernelBasis: [], downloadedBytes: null, memoryLogicalBytes: null,
    reasons: [{ code: 'source-unresolved', message: 'Loop/overlay ancestry is unknown' }] };
  const controller = createTargetController({ provider: { readReport: async () => input }, reportError: assert.fail });
  t.after(() => controller.dispose());
  assert.equal((await controller.refresh()).status, 'ready');
  assert.equal(selectable(controller.getState().envelope, target(input)), false);
  assert.equal(controller.select('entry-2', controller.getState().generation).status, 'rejected');
  assert.equal(controller.getState().envelope.source.reasons[0].code, 'source-unresolved');
  assert.equal(controller.getState().confirmation, null);
});

test('fresh reidentification invalidates every changed identity/scope/observation/source/use case', async t => {
  const changes = {
    removal: value => { value.report.devices = value.report.devices.filter(entry => entry.entryId !== 'entry-2'); },
    serial: value => { target(value).identity.serial = 'FIXTURE-REPLACEMENT'; },
    WWN: value => { target(value).identity.wwn = 'abcdabcdabcdabcd'; },
    model: value => { target(value).identity.model = target(value).model = 'Fixture Replacement Model'; },
    capacity: value => {
      const entry = target(value);
      entry.capacityBytes += 512; entry.identity.capacityBytes += 512;
      entry.clearingScope.endByteExclusive += 512; entry.observation.kernel.sizeSectors512++;
    },
    partitions: value => {
      target(value).partitions[0].uuid = 'replacement-partition';
      target(value).clearingScope.partitions[0].uuid = 'replacement-partition';
    },
    diskseq: value => { target(value).observation.kernel.diskseq++; },
    node: value => { target(value).observation.path = '/dev/sdz'; },
    topology: value => { target(value).observation.descendants.push('8:18'); },
    mounted: value => { target(value).eligible = false; target(value).reasons.push({ code: 'mounted', message: 'Now mounted' }); },
    'active source': value => { target(value).eligible = false; target(value).reasons.push({ code: 'active-source', message: 'Now source' }); },
    'active root': value => { target(value).eligible = false; target(value).reasons.push({ code: 'active-root', message: 'Now root' }); },
    'active boot': value => { target(value).eligible = false; target(value).reasons.push({ code: 'active-boot', message: 'Now boot' }); },
    readonly: value => { target(value).eligible = false; target(value).reasons.push({ code: 'read-only', message: 'Now readonly' }); },
    protected: value => {
      target(value).model = target(value).identity.model = 'Samsung SSD 990 PRO 4TB';
      target(value).eligible = false; target(value).reasons.push({ code: 'protected-model', message: 'Excluded family' });
    },
    'missing IDs': value => {
      target(value).eligible = false; target(value).identity.serial = null; target(value).identity.wwn = null;
      target(value).reasons.push({ code: 'missing-stable-id', message: 'ID absent' });
    },
    'duplicate IDs': value => {
      const duplicate = clone(target(value)); duplicate.entryId = 'entry-duplicate';
      for (const entry of [target(value), duplicate]) {
        entry.eligible = false; entry.reasons.push({ code: 'duplicate-stable-id', message: 'Duplicate serial/WWN' });
      }
      value.report.devices.push(duplicate);
    },
    'source bytes': value => { value.source.memoryLogicalBytes++; },
    'source download bytes': value => { value.source.downloadedBytes++; },
    'source mapping lost': value => { value.source.exactSourceMapping = false; value.source.kernelBasis = []; },
    'layout reserve': value => { value.report.capacity.partitions[1].reserveMiB++; },
    'layout required bytes': value => { value.report.capacity.requiredBytes++; },
    'acquisition reused': value => { value.generation = 'before'; },
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, async inner => {
    const before = makeFixtureEnvelope('before'), after = makeFixtureEnvelope('after'); change(after);
    const reports = [before, after];
    const { controller } = await selected(inner, { readReport: async () => reports.shift() });
    acknowledge(controller);
    const result = await confirm(controller); ro(result);
    assert.equal(result.status, 'invalidated', name);
    assert.equal(controller.getState().confirmation, null);
    assert.equal(controller.getState().scopeAcknowledged, false);
    assert.equal(controller.getState().selection, null);
    assert.equal(controller.getState().envelope.generation, after.generation);
    assert.ok(result.reasons.length);
  });
});

test('key ordering is irrelevant but reused generation cannot establish freshness', () => {
  const before = parseTargetEnvelope(makeFixtureEnvelope('before'));
  const binding = bindTarget(before, 'entry-2', 4);
  const after = makeFixtureEnvelope('after');
  const identity = target(after).identity;
  target(after).identity = Object.fromEntries(Object.entries(identity).reverse());
  assert.equal(reidentifyTarget(binding, parseTargetEnvelope(after)).matches, true);
  after.generation = 'before';
  assert.equal(reidentifyTarget(binding, parseTargetEnvelope(after)).matches, false);
});

test('explicit refresh invalidates even identical confirmation and never reselects', async t => {
  const { controller } = await selected(t); acknowledge(controller);
  assert.equal((await confirm(controller)).status, 'confirmed-read-only');
  assert.equal((await controller.refresh()).status, 'ready');
  assert.equal(controller.getState().selection, null);
  assert.equal(controller.getState().confirmation, null);
  assert.equal(controller.getState().scopeAcknowledged, false);
});

test('older acquisition generation replay is rejected, including a hypothetical onward check', async t => {
  const reports = [makeFixtureEnvelope('first'), makeFixtureEnvelope('second'), makeFixtureEnvelope('first')];
  const { controller } = await selected(t, { readReport: async () => reports.shift() });
  acknowledge(controller); await confirm(controller);
  const state = controller.getState();
  const output = await controller.hypotheticalOnward(state.generation, state.confirmation);
  assert.equal(output.status, 'invalidated');
  assert.equal(output.reasons[0].code, 'stale-report');
  assert.equal(controller.getState().confirmation, null);
});

test('provider cannot spoof the controller interruption/result discriminator', async t => {
  const errors = [];
  const controller = createTargetController({ provider: {
    readReport: async () => ({ interrupted: 'confirmed-read-only', writeAuthorized: false }),
  }, reportError: value => errors.push(value) });
  t.after(() => controller.dispose());
  const output = await controller.refresh(); ro(output);
  assert.equal(output.status, 'error');
  assert.equal(controller.getState().confirmation, null);
  assert.equal(errors.length, 1);
});

test('acquisition-history bound is exact and cannot silently prune replay protection', async t => {
  const errors = [];
  let generation = 0;
  const input = makeFixtureEnvelope();
  input.report.devices = [];
  input.source.exactSourceMapping = false; input.source.kernelBasis = [];
  const controller = createTargetController({ provider: {
    readReport: async () => ({ ...input, generation: 'bounded-' + ++generation }),
  }, reportError: value => errors.push(value) });
  t.after(() => controller.dispose());
  for (let i = 0; i < 1024; i++) assert.equal((await controller.refresh()).status, 'ready');
  assert.equal((await controller.refresh()).status, 'error');
  assert.equal(errors.length, 1);
  assert.match(controller.getState().reasons[0].message, /session limit reached/);
  assert.equal(controller.getState().confirmation, null);
});

test('stale scope/buttons cannot acknowledge or confirm a replacement selection', async t => {
  const { controller } = await selected(t);
  const old = controller.getState();
  acknowledge(controller);
  await controller.refresh();
  controller.select('entry-2', controller.getState().generation);
  const current = controller.getState();
  assert.notEqual(current.selection, old.selection);
  assert.equal(controller.acknowledgeScope(old.generation, old.selection).status, 'stale');
  assert.equal(controller.acknowledgeScope(current.generation, old.selection).status, 'stale');
  assert.equal((await controller.confirm(old.generation, old.selection)).status, 'stale');
  assert.equal(controller.getState(), current);
  assert.equal(controller.getState().scopeAcknowledged, false);
});

test('cancel releases pending confirmation; a late fresh report cannot resurrect consent', async t => {
  const pending = deferred(), requests = [];
  const provider = { readReport(request) { requests.push(request); return requests.length === 1 ?
    Promise.resolve(makeFixtureEnvelope('before')) : pending.promise; } };
  const { controller } = await selected(t, provider); acknowledge(controller);
  const waiting = confirm(controller);
  await Promise.resolve();
  assert.equal(controller.getState().phase, 'reidentifying');
  assert.equal(controller.cancel().status, 'cancelled');
  assert.equal((await waiting).status, 'cancelled');
  pending.resolve(makeFixtureEnvelope('late'));
  await Promise.resolve();
  assert.equal(controller.getState().phase, 'cancelled');
  assert.equal(controller.getState().confirmation, null);
  assert.equal(requests[1].purpose, 'confirm');
  assert.equal(requests[1].previousGeneration, 'before');
  assert.ok(Object.isFrozen(requests[1]));
});

test('out-of-order refresh cannot overwrite the newer report or selection', async t => {
  const old = deferred(), newer = deferred();
  let calls = 0;
  const controller = createTargetController({ provider: { readReport: () => ++calls === 1 ? old.promise : newer.promise },
    reportError: assert.fail });
  t.after(() => controller.dispose());
  const first = controller.refresh(); await Promise.resolve();
  const second = controller.refresh(); await Promise.resolve();
  assert.equal((await first).status, 'superseded');
  newer.resolve(makeFixtureEnvelope('newer'));
  assert.equal((await second).status, 'ready');
  controller.select('entry-2', controller.getState().generation);
  const state = controller.getState();
  old.resolve(makeFixtureEnvelope('old')); await Promise.resolve(); await Promise.resolve();
  assert.equal(controller.getState(), state);
  assert.equal(state.envelope.generation, 'newer');
});

test('superseding pending confirmation cannot confirm the replacement report', async t => {
  const pending = deferred();
  let calls = 0;
  const { controller } = await selected(t, { readReport: () => {
    calls++;
    return calls === 2 ? pending.promise : Promise.resolve(makeFixtureEnvelope('report-' + calls));
  } });
  acknowledge(controller);
  const oldConfirmation = confirm(controller); await Promise.resolve();
  await controller.refresh();
  assert.equal((await oldConfirmation).status, 'superseded');
  controller.select('entry-2', controller.getState().generation);
  pending.resolve(makeFixtureEnvelope('old-report')); await Promise.resolve();
  assert.equal(controller.getState().scopeAcknowledged, false);
  assert.equal(controller.getState().confirmation, null);
});

test('provider invalidation and disposal discard requests and release listener lifetime', async t => {
  const provider = createFixtureProvider();
  const { controller } = await selected(t, provider); acknowledge(controller);
  await confirm(controller);
  provider.invalidate();
  assert.equal(controller.getState().phase, 'invalidated');
  assert.equal(controller.getState().confirmation, null);
  controller.dispose();
  const state = controller.getState();
  provider.invalidate();
  assert.equal(controller.getState(), state);
  assert.equal((await controller.refresh()).status, 'stale');
});

test('closing during acquisition resolves as disposed and ignores late completion/rejection', async t => {
  const pending = deferred();
  const controller = createTargetController({ provider: { readReport: () => pending.promise }, reportError: assert.fail });
  t.after(() => controller.dispose());
  const waiting = controller.refresh(); await Promise.resolve();
  controller.dispose();
  assert.equal((await waiting).status, 'disposed');
  pending.reject(new Error('Late ignored read failure'));
  await Promise.resolve();
  assert.equal(controller.getState().phase, 'disposed');
  assert.equal(controller.getState().confirmation, null);
});

test('timeout/rejection/malformed fresh reports show errors and cannot become success-shaped', async t => {
  for (const kind of ['timeout', 'rejection', 'malformed', 'authorization']) await t.test(kind, async inner => {
    let calls = 0;
    const { controller, errors } = await selected(inner, { readReport: () => {
      if (++calls === 1) return Promise.resolve(makeFixtureEnvelope('before'));
      if (kind === 'timeout') return new Promise(() => {});
      if (kind === 'rejection') return Promise.reject(new Error('Fixture transport failure'));
      if (kind === 'malformed') return Promise.resolve({});
      const invalid = makeFixtureEnvelope('after'); invalid.report.writeAuthorized = true;
      return Promise.resolve(invalid);
    } }, { timeoutMs: 25 });
    acknowledge(controller);
    const result = await confirm(controller); ro(result);
    assert.equal(result.status, 'error');
    assert.equal(controller.getState().phase, 'error');
    assert.equal(controller.getState().confirmation, null);
    assert.equal(controller.getState().selection, null);
    assert.equal(errors.length, 1);
    assert.ok(controller.getState().reasons.length);
  });
});

test('no provider honestly stays unavailable; no automatic mock/command/empty success fallback', async t => {
  const controller = createTargetController({ reportError: assert.fail });
  t.after(() => controller.dispose());
  assert.equal(controller.getState().phase, 'unavailable');
  assert.equal(controller.getState().envelope, null);
  assert.equal((await controller.refresh()).status, 'unavailable');
  assert.equal(controller.getState().reasons[0].code, 'native-helper-pending');
  assert.throws(() => createTargetController({ provider: { command: '/usr/bin/helper' } }), TypeError);
  assert.throws(() => createTargetController({ timeoutMs: 30001 }), TypeError);
});
