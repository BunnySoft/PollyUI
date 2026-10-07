import { waitForSessionReady } from './desktop/shell/health.mjs';

function check(value, message) {
  if (!value) throw new Error('FAIL: ' + message);
  console.log('PASS: ' + message);
}
async function scenario(frames, options = {}) {
  let index = 0, elapsed = 0;
  const messages = [];
  const frame = () => frames[Math.min(index, frames.length - 1)];
  const shell = {
    getState: () => ({ running: true, error: '', outputs: frame().outputs === false ? [] : [1], ...frame().shell }),
    getSurfaces: () => [{ window: { closed: frame().closed === true } }],
  };
  const native = {
    get audioAvailable() { return frame().audio !== undefined; },
    sessionServices() { if (frame().error) throw new Error(frame().error); return { inputMethod: frame().ime }; },
    audioState: () => frame().audio,
  };
  let error = '';
  try {
    await waitForSessionReady({ shell, native, timeoutMs: 150, now: () => elapsed,
      delay: async ms => { elapsed += ms; index++; }, report: text => messages.push(text), ...options });
  } catch (failure) { error = String(failure); }
  return { error, index, messages };
}
let result = await scenario([{ ime: 'disabled' }]);
check(!result.error && result.index === 0, 'disabled optional services do not block readiness');
result = await scenario([{ ime: 'starting', audio: { ready: true } }, { ime: 'starting', audio: { ready: true } },
  { ime: 'ready', audio: { ready: true } }], { requireIme: true, requireAudio: true });
check(!result.error && result.index === 2, 'Shell and audio ready cannot bypass a starting input method');
check(result.messages.length === 2, 'health progress reports transitions rather than polling noise');
result = await scenario([{ ime: 'ready', audio: { ready: false } }, { ime: 'ready', audio: { ready: true } }]);
check(!result.error && result.index === 1, 'audio discovery must finish before success');
result = await scenario([{ ime: 'ready', outputs: false }, { ime: 'ready', closed: true }, { ime: 'ready' }]);
check(!result.error && result.index === 2, 'unavailable outputs and closed surfaces prevent Shell readiness');
result = await scenario([{ ime: 'starting' }]);
check(result.error.includes('deadline exceeded') && result.index === 3, 'starting service has a bounded explicit failure');
result = await scenario([{ ime: 'starting' }, { ime: 'failed' }]);
check(result.error.includes('failed or disconnected'), 'service exit fails promptly instead of waiting for the deadline');
result = await scenario([{ ime: 'disabled' }], { requireIme: true });
check(result.error.includes('not configured'), 'requested IME cannot be treated as optional');
result = await scenario([{ ime: 'ready' }], { requireAudio: true });
check(result.error.includes('not configured'), 'requested audio cannot be treated as optional');
result = await scenario([{ ime: 'ready', audio: { ready: true, error: 'bus lost' } }]);
check(result.error.includes('bus lost'), 'audio error overrides a stale ready flag');
result = await scenario([{ ime: 'ready', shell: { error: 'surface creation failed' } }]);
check(result.error.includes('surface creation failed'), 'Shell failures are preserved');
result = await scenario([{ ime: 'ready', shell: { running: false } }]);
check(result.error.includes('Shell stopped'), 'stopped Shell is never healthy');
result = await scenario([{ ime: 'ready', error: 'status connection lost' }]);
check(result.error.includes('status connection lost'), 'lost compositor status connection fails closed');
result = await scenario([{ ime: 'unexpected' }]);
check(result.error.includes('Invalid input-method'), 'unknown protocol status is not success-shaped');
