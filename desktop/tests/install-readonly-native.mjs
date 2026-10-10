import { createNativeTargetProvider } from './desktop/apps/installer/logic/native-provider.mjs';
import { createTargetController } from './desktop/apps/installer/logic/target-controller.mjs';
function check(value, message) { if (!value) throw new Error(message); }
async function run() {
  check(typeof desktop.installTargets.readReport === 'function' &&
    Function.prototype.toString.call(desktop.installTargets.readReport).includes('[native code]'),
  'New native adapter required, not old binary or JS stub');
  const provider = createNativeTargetProvider(desktop);
  let nativeArgumentRefused = false;
  try { desktop.installTargets.readReport({ command: '/bin/true' }); }
  catch (error) { nativeArgumentRefused = String(error).includes('no arguments'); }
  check(nativeArgumentRefused, 'Native endpoint must reject command/path/source arguments');
  if (['success', 'overlay', 'ram-source'].includes(scenario)) {
    const first = await provider.readReport({ purpose: 'refresh', requestId: 1, previousGeneration: null });
    const second = await provider.readReport({ purpose: 'refresh', requestId: 2, previousGeneration: first.generation });
    check(first.generation !== second.generation, 'Distinct actual helper acquisition generations');
    check(first.readOnly && !first.writeAuthorized, 'No authorization');
    check(first.source.downloadedBytes === 17 && first.source.memoryLogicalBytes === null, 'Measured source bytes');
    check(first.source.description.includes('NATIVE-COLLECTOR-FIXTURE'), 'Actual collector fixture provenance');
    const target = first.report.devices.find(item => item.observation.majorMinor === '8:16');
    check(target.identity.serial === 'FIXTURE-USB-001' && target.identity.wwn === '1234567890abcdef',
      'Original model stable identity parity');
    check(target.capacityBytes === 17179869184 && target.observation.kernel.diskseq === 7,
      'Original model capacity/diskseq parity');
    check(first.report.capacity.requiredBytes !== 8589934592, 'Dynamic measured layout, not fixed 8 GiB');
    check(first.source.exactSourceMapping === (scenario === 'success'), 'Failclosed source mapping');
    check(first.source.kind === (scenario === 'success' ? 'downloaded' : 'unknown'),
      'Unknown active/source ancestry is not an invented downloaded/memory proof');
    check(scenario === 'success' ? target.eligible : !target.eligible, 'Eligibility parity');
    check(first.report.devices.some(item => item.reasons.some(reason => reason.code === 'protected-model')),
      'Protected internal model preserved');
    const controller = createTargetController({ provider, reportError: () => {} });
    check((await controller.refresh()).status === 'ready', 'Actual collector to provider to controller');
    if (scenario === 'success') {
      let state = controller.getState();
      controller.select(target.entryId, state.generation);
      state = controller.getState(); controller.acknowledgeScope(state.generation, state.selection);
      state = controller.getState();
      check((await controller.confirm(state.generation, state.selection)).status === 'confirmed-read-only',
        'Independent native reidentification');
      state = controller.getState();
      check((await controller.hypotheticalOnward(state.generation, state.confirmation)).status === 'blocked-no-writer',
        'Never a writer');
    }
    controller.dispose();
  } else if (['deadline-before', 'deadline-overrun', 'deadline-exact', 'deadline-settle-overrun'].includes(scenario)) {
    let value = null, error = null;
    try {
      value = await provider.readReport({ purpose: 'refresh', requestId: 1, previousGeneration: null });
    } catch (caught) { error = caught; }
    if (scenario === 'deadline-before') {
      check(!error && value?.readOnly && !value.writeAuthorized && value.source.exactSourceMapping,
        'Timely final EOF at elapsed7999ms must retain normal success');
    } else {
      check(!value && error && String(error).includes('8 second deadline'),
        scenario + ': expired acquisition must reject, never resolve');
    }
    provider.stop();
  } else if (scenario === 'cancel') {
    const promise = provider.readReport({ purpose: 'refresh', requestId: 1, previousGeneration: null });
    await provider.cancelRead();
    let refused = false;
    try { await promise; } catch (error) { refused = String(error).includes('cancelled'); }
    check(refused, 'Native cancellation rejects after reap');
    provider.stop();
  } else {
    let refused = false;
    try {
      await provider.readReport({ purpose: 'refresh', requestId: 1, previousGeneration: null });
    } catch (error) { refused = true; }
    check(refused, 'Native refusal/malformed/oversize/timeout/disconnect must not become report success');
    provider.stop();
  }
}
run().then(() => { globalThis.nativeFixtureDone = true; },
  error => { globalThis.nativeFixtureError = String(error); });
