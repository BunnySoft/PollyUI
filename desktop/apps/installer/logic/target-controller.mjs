import { parseTargetEnvelope, bindTarget, reidentifyTarget, freezeData, issue } from './desktop/apps/installer/logic/target-model.mjs';

const RO = { readOnly: true, writeAuthorized: false };
const unavailable = issue('native-helper-pending',
  'Native read-only helper integration is pending. No host devices were enumerated.');

/** Provider: readReport({purpose, requestId, previousGeneration}) -> Promise<envelope>.
 * Each independent acquisition MUST have a new generation. Optional
 * subscribeInvalidation(callback) -> unsubscribe informs removal/hotplug/context
 * changes. These callbacks have no command/path/privilege or writer contract.
 */
export function createTargetController({ provider = null, onChange = () => {},
  reportError = message => console.error('[installer] ' + message), timeoutMs = 10000 } = {}) {
  if (typeof onChange !== 'function' || typeof reportError !== 'function' ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
    throw new TypeError('Expected callbacks and a bounded report timeout');
  if (provider !== null && (typeof provider.readReport !== 'function' ||
    (provider.subscribeInvalidation !== undefined && typeof provider.subscribeInvalidation !== 'function') ||
    (provider.cancelRead !== undefined && typeof provider.cancelRead !== 'function') ||
    (provider.stop !== undefined && typeof provider.stop !== 'function')))
    throw new TypeError('Expected an explicit read-only report provider');
  let state = freezeData({ schemaVersion: 1, ...RO, generation: 0,
    phase: provider ? 'idle' : 'unavailable', envelope: null, selection: null,
    scopeAcknowledged: false, confirmation: null, reasons: provider ? [] : [unavailable] });
  let active = null, stopped = false, unsubscribe = null;
  const acquisitions = new Set();
  const result = (status, extra = {}) => freezeData({ status, ...RO, ...extra });
  function publish(next) {
    state = freezeData({ ...state, ...next, generation: state.generation + 1, ...RO });
    onChange(state);
  }
  function interrupt(status) {
    if (active) {
      const request = active; active = null; request.cancel(status);
      if (provider?.cancelRead) {
        try {
          Promise.resolve(provider.cancelRead()).catch(error =>
            reportError('Read-only transport cancellation failed: ' + String(error)));
        } catch (error) { reportError('Read-only transport cancellation failed: ' + String(error)); }
      }
    }
  }
  function clear(phase, reasons = []) {
    publish({ phase, selection: null, scopeAcknowledged: false, confirmation: null, reasons });
  }
  function valid(generation, selection = state.selection) {
    return !stopped && generation === state.generation && selection === state.selection;
  }
  function stale() {
    return result('stale', { reasons: [issue('stale-action', 'The view or selected scope changed; review the current report.')] });
  }
  function fail(error) {
    const reason = issue('report-error', String(error));
    clear('error', [reason]);
    reportError(reason.message);
    return result('error', { reasons: [reason] });
  }
  async function acquire(purpose, binding = null) {
    interrupt('superseded');
    publish({ phase: purpose === 'refresh' ? 'loading' : 'reidentifying', reasons: [],
      confirmation: null, ...(purpose === 'refresh' ? { selection: null, scopeAcknowledged: false } : {}) });
    const requestId = state.generation;
    let cancel;
    const interruption = new Promise(resolve => { cancel = status => resolve({ interrupted: status }); });
    const request = { requestId, cancel };
    active = request;
    let timer;
    try {
      const deadline = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Read-only report acquisition timed out; retry explicitly.')), timeoutMs);
      });
      const read = Promise.resolve().then(() => {
        if (active !== request || stopped) return null;
        return provider.readReport(freezeData({ purpose, requestId,
          previousGeneration: binding?.reportGeneration ?? state.envelope?.generation ?? null }));
      }).then(envelope => ({ envelope }));
      const value = await Promise.race([read, interruption, deadline]);
      if (value?.interrupted) return result(value.interrupted);
      if (active !== request || state.generation !== requestId || stopped) return stale();
      const fresh = parseTargetEnvelope(value.envelope);
      if (acquisitions.has(fresh.generation)) {
        const reasons = [issue('stale-report', 'An acquisition generation was reused; independently refresh and explicitly reselect.')];
        publish({ envelope: fresh, phase: 'invalidated', selection: null,
          scopeAcknowledged: false, confirmation: null, reasons });
        return result('invalidated', { reasons });
      }
      if (acquisitions.size >= 1024)
        throw new Error('Read-only acquisition session limit reached; close and reopen the review view.');
      acquisitions.add(fresh.generation);
      if (binding) {
        const identified = reidentifyTarget(binding, fresh);
        if (!identified.matches) {
          publish({ envelope: fresh, phase: 'invalidated', selection: null,
            scopeAcknowledged: false, confirmation: null, reasons: identified.reasons });
          return result('invalidated', { reasons: identified.reasons });
        }
        const selected = bindTarget(fresh, identified.device.entryId, requestId + 1);
        if (purpose === 'hypothetical-onward') {
          publish({ envelope: fresh, phase: 'blocked', selection: null, scopeAcknowledged: false,
            confirmation: null, reasons: [issue('no-writer',
              'Hypothetical next step is blocked: no writer, real user/disk authorization or exclusive-access proof exists.')] });
          return result('blocked-no-writer', { binding: selected, reasons: state.reasons });
        }
        const confirmation = freezeData({
          schemaVersion: 1, kind: 'ui-only-scope-confirmation', ...RO,
          generation: requestId + 1, acknowledgedReportGeneration: binding.reportGeneration,
          reidentifiedReportGeneration: fresh.generation, target: selected,
        });
        publish({ envelope: fresh, phase: 'confirmed', selection: selected,
          scopeAcknowledged: true, confirmation, reasons: [] });
        return result('confirmed-read-only', { confirmation });
      }
      publish({ envelope: fresh, phase: 'ready', selection: null,
        scopeAcknowledged: false, confirmation: null, reasons: [] });
      return result('ready');
    } catch (error) {
      if (active !== request || state.generation !== requestId || stopped) return stale();
      interrupt('error');
      return fail(error);
    } finally {
      clearTimeout(timer);
      if (active === request) active = null;
    }
  }
  const controller = {
    getState: () => state,
    refresh(expectedGeneration = state.generation) {
      if (!valid(expectedGeneration)) return Promise.resolve(stale());
      if (!provider) return Promise.resolve(result('unavailable', { reasons: [unavailable] }));
      return acquire('refresh');
    },
    select(entryId, expectedGeneration) {
      if (!valid(expectedGeneration)) return stale();
      if (!['ready', 'selected'].includes(state.phase)) return result('blocked', { reasons: state.reasons });
      try {
        const selection = bindTarget(state.envelope, entryId, state.generation + 1);
        publish({ phase: 'selected', selection, scopeAcknowledged: false, confirmation: null, reasons: [] });
        return result('selected');
      } catch (error) {
        clear('invalidated', [issue('selection-rejected', String(error))]);
        return result('rejected', { reasons: state.reasons });
      }
    },
    acknowledgeScope(expectedGeneration, selection, acknowledged = true) {
      if (!valid(expectedGeneration, selection)) return stale();
      if (state.phase !== 'selected' || !selection || typeof acknowledged !== 'boolean')
        return result('blocked', { reasons: [issue('selection-required', 'Select a qualified target before acknowledging its exact scope.')] });
      publish({ scopeAcknowledged: acknowledged, confirmation: null });
      return result(acknowledged ? 'scope-acknowledged' : 'scope-unchecked');
    },
    confirm(expectedGeneration, selection) {
      if (!valid(expectedGeneration, selection)) return Promise.resolve(stale());
      if (state.phase !== 'selected' || !selection || !state.scopeAcknowledged)
        return Promise.resolve(result('blocked', { reasons: [issue('scope-confirmation-required',
          'Explicitly select a target and acknowledge its displayed whole-disk clearing range first.')] }));
      return acquire('confirm', selection);
    },
    hypotheticalOnward(expectedGeneration, confirmation) {
      if (!valid(expectedGeneration) || confirmation !== state.confirmation) return Promise.resolve(stale());
      if (state.phase !== 'confirmed' || !confirmation)
        return Promise.resolve(result('blocked', { reasons: [issue('confirmation-required', 'No current scope confirmation exists.')] }));
      return acquire('hypothetical-onward', confirmation.target);
    },
    cancel(expectedGeneration = state.generation) {
      if (!valid(expectedGeneration)) return stale();
      interrupt('cancelled'); clear('cancelled', [issue('cancelled', 'Confirmation cancelled. Nothing was written; refresh to retry.')]);
      return result('cancelled');
    },
    invalidate(reason = 'Target/context evidence changed; refresh and explicitly reselect.') {
      if (stopped) return result('disposed');
      interrupt('invalidated');
      clear('invalidated', [issue('provider-invalidated', String(reason).slice(0, 4096))]);
      return result('invalidated');
    },
    dispose() {
      if (stopped) return;
      stopped = true; interrupt('disposed');
      const stop = unsubscribe; unsubscribe = null;
      publish({ phase: 'disposed', selection: null, scopeAcknowledged: false, confirmation: null });
      if (stop) stop();
      if (provider?.stop) {
        try { provider.stop(); }
        catch (error) { reportError('Read-only provider shutdown failed: ' + String(error)); }
      }
    },
  };
  if (provider?.subscribeInvalidation) {
    unsubscribe = provider.subscribeInvalidation(reason => controller.invalidate(reason));
    if (typeof unsubscribe !== 'function') throw new TypeError('Provider invalidation subscription must return an unsubscribe callback');
  }
  return controller;
}
