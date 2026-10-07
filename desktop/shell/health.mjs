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
    const summary = `shell=${shellReady ? 'ready' : 'starting'} ime=${ime} audio=${audio ? audio.ready ? 'ready' : 'starting' : 'disabled'}`;
    if (summary !== previous) { report('[health] ' + summary); previous = summary; }
    if (shellReady && ime !== 'starting' && (!audio || audio.ready)) return;
    if (now() >= deadline) throw new Error('Session readiness deadline exceeded: ' + summary);
    await delay(50);
  }
}
