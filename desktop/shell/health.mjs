function decorationStatus(services) {
  if (!['disabled', 'starting', 'ready', 'failed'].includes(services.decorations) ||
      typeof services.decorationMessage !== 'string')
    throw new Error('Invalid decoration service status');
  return services.decorations;
}

export async function waitForSessionReady({ shell, native, requireIme = false, requireAudio = false,
  timeoutMs = 15000, now = Date.now, delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
  report = console.log }) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new RangeError('Invalid session health deadline');
  const deadline = now() + timeoutMs;
  let previous = '';
  while (true) {
    const state = shell.getState();
    if (state.error) throw new Error(state.error);
    if (!state.running) throw new Error('Shell stopped before session readiness');
    const services = native.sessionServices();
    const decorations = decorationStatus(services);
    if (decorations === 'disabled') throw new Error('Independent decoration service is not configured');
    if (decorations === 'failed')
      throw new Error('Independent decoration service failed: ' + services.decorationMessage);
    const ime = services.inputMethod;
    if (!['disabled', 'starting', 'ready', 'failed'].includes(ime))
      throw new Error('Invalid input-method service status');
    if (requireIme && ime === 'disabled') throw new Error('Requested input method is not configured');
    if (ime === 'failed') throw new Error('Requested input method failed or disconnected before session readiness');
    if (requireAudio && !native.audioAvailable) throw new Error('Requested private audio service is not configured');
    const audio = native.audioAvailable ? native.audioState() : null;
    if (audio?.error) throw new Error('Private audio service: ' + audio.error);
    const surfaces = shell.getSurfaces();
    const shellReady = state.outputs.length > 0 && surfaces.length > 0 &&
      surfaces.every(surface => !surface.window.closed);
    const summary = `shell=${shellReady ? 'ready' : 'starting'} decorations=${decorations} ime=${ime} audio=${audio ? audio.ready ? 'ready' : 'starting' : 'disabled'}`;
    if (summary !== previous) { report('[health] ' + summary); previous = summary; }
    if (shellReady && decorations === 'ready' && ime !== 'starting' && (!audio || audio.ready)) return;
    if (now() >= deadline) throw new Error('Session readiness deadline exceeded: ' + summary);
    await delay(50);
  }
}

export function createSessionMonitor({ native, report, now = Date.now }) {
  let starting = null, previous = '', current = {
    inputMethod: 'unavailable', audio: 'unavailable', decorations: 'unavailable', message: '', error: '' };
  return {
    refresh() {
      if (typeof native?.sessionServices !== 'function') return current;
      let message = '';
      try {
        const services = native.sessionServices(), inputMethod = services.inputMethod;
        const decorations = decorationStatus(services);
        if (!['disabled', 'starting', 'ready', 'failed'].includes(inputMethod))
          throw new Error('Invalid input-method service status');
        if (inputMethod === 'starting') {
          if (starting === null) starting = now();
          if (now() - starting >= 15000) message = 'Input method is still initializing. Text conversion is not ready.';
        } else {
          starting = null;
          if (inputMethod === 'failed') message = 'Requested input method failed or disconnected. Direct keyboard input remains available.';
        }
        const audio = native.audioAvailable ? native.audioState() : null;
        if (audio?.error) message += (message ? ' ' : '') + 'Audio service: ' + audio.error;
        if (decorations !== 'ready') message += (message ? ' ' : '') +
          'Window decorations ' + decorations + ': ' + services.decorationMessage;
        current = { inputMethod, decorations,
          audio: audio ? audio.error ? 'failed' : audio.ready ? 'ready' : 'starting' : 'disabled',
          message, error: inputMethod === 'failed' || audio?.error || decorations === 'failed' || decorations === 'disabled' ? message : '' };
      } catch (error) {
        message = 'Cannot inspect session services: ' + String(error);
        current = { inputMethod: 'unavailable', audio: 'unavailable', decorations: 'unavailable', message, error: message };
      }
      if (message && message !== previous) report('[shell] ' + message);
      previous = message;
      return current;
    },
    reset() {
      starting = null; previous = '';
      current = { inputMethod: 'unavailable', audio: 'unavailable', decorations: 'unavailable', message: '', error: '' };
    },
    snapshot() { return { ...current }; },
  };
}
