import { createTargetApp } from './desktop/installer/target-app.mjs';
import { createNativeTargetProvider } from './desktop/installer/native-provider.mjs';

// Final native lane: private staged source/collector only, never host inventory.
if (typeof desktop === 'undefined' || !desktop.installTargets ||
  !Function.prototype.toString.call(desktop.installTargets.readReport).includes('[native code]'))
  throw new Error('New compiled native readonly adapter is required; old binary/JS stub refused.');
const provider = createNativeTargetProvider(desktop);
const app = createTargetApp({ provider, synthetic: true }).start();
let phase = 0, firstGeneration = null, ticks = 0;
const timer = setInterval(() => {
  try {
    if (++ticks > 1500) throw new Error('Native readonly ordinary-window fixture timed out.');
    const state = app.controller.getState();
    if (['error', 'unavailable', 'invalidated'].includes(state.phase))
      throw new Error(JSON.stringify(state.reasons));
    if (state.envelope && (!state.envelope.source.description.includes('NATIVE-COLLECTOR-FIXTURE') ||
      state.envelope.source.downloadedBytes !== 17))
      throw new Error('Private actual-collector source receipt is required, not mock/host data.');
    if (phase === 0 && state.phase === 'ready') {
      firstGeneration = state.envelope.generation;
      const entry = state.envelope.report.devices.find(item => item.eligible);
      if (!entry || entry.identity.serial !== 'FIXTURE-USB-001')
        throw new Error('Expected unchanged Python model identity.');
      app.controller.select(entry.entryId, state.generation); phase = 1;
    } else if (phase === 1 && state.phase === 'selected') {
      app.controller.acknowledgeScope(state.generation, state.selection); phase = 2;
    } else if (phase === 2 && state.scopeAcknowledged) {
      app.controller.confirm(state.generation, state.selection); phase = 3;
    } else if (phase === 3 && state.phase === 'confirmed') {
      if (state.envelope.generation === firstGeneration || state.confirmation.writeAuthorized)
        throw new Error('Fresh native acquisition and readonly confirmation required.');
      app.controller.cancel(state.generation); phase = 4;
    } else if (phase === 4 && state.phase === 'cancelled') {
      clearInterval(timer);
      app.stop();
      console.log('NATIVE READONLY ORDINARY WINDOW PASS: real collector/provider; no writer');
    }
  } catch (error) {
    clearInterval(timer); app.stop();
    console.error('NATIVE READONLY ORDINARY WINDOW FAIL: ' + error);
  }
}, 20);
