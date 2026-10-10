import { parseTargetEnvelope } from './desktop/apps/installer/logic/target-model.mjs';

/** Only this fixed native endpoint is accepted; no paths, commands or measurements. */
export function createNativeTargetProvider(native) {
  const api = native?.installTargets;
  if (!api || api.protocolVersion !== 1 || api.transport !== 'fixed-unprivileged-v1' ||
    typeof api.readReport !== 'function' || typeof api.cancel !== 'function')
    throw new Error('Fixed native read-only installation-target API is missing or incompatible.');
  let pending = null, stopped = false, epoch = 0;
  const generations = new Set();
  async function cancelRead() {
    epoch++;
    if (!pending) return;
    const current = pending;
    api.cancel();
    // Native cancellation settles only after the isolated child is reaped.
    await current.then(() => {}, () => {});
  }
  return {
    async readReport({ purpose, requestId, previousGeneration }) {
      if (stopped) throw new Error('Read-only provider has stopped.');
      if (!['refresh', 'confirm', 'hypothetical-onward'].includes(purpose) ||
        !Number.isSafeInteger(requestId) || requestId < 1 ||
        !(previousGeneration === null || (typeof previousGeneration === 'string' &&
          previousGeneration.length > 0 && previousGeneration.length <= 4096)))
        throw new TypeError('Invalid bounded read-only acquisition request.');
      const currentEpoch = ++epoch;
      if (pending) {
        const previous = pending;
        api.cancel();
        await previous.then(() => {}, () => {});
      }
      if (stopped || epoch !== currentEpoch) throw new Error('Read-only acquisition was superseded or stopped.');
      const current = Promise.resolve(api.readReport());
      pending = current;
      try {
        const value = parseTargetEnvelope(await current);
        if (stopped || epoch !== currentEpoch || pending !== current)
          throw new Error('Read-only acquisition was superseded or stopped.');
        if (generations.has(value.generation) || value.generation === previousGeneration)
          throw new Error('Fixed helper reused an acquisition generation.');
        if (generations.size >= 1024) throw new Error('Read-only provider session limit reached; reopen the view.');
        generations.add(value.generation);
        return value;
      } finally {
        if (pending === current) pending = null;
      }
    },
    cancelRead,
    stop() {
      if (stopped) return;
      stopped = true; epoch++;
      if (pending) api.cancel();
    },
  };
}
