export function createBoundedAnimation({ paint, onError, now = Date.now,
  schedule = setTimeout, cancel = clearTimeout } = {}) {
  if (typeof paint !== 'function' || typeof onError !== 'function' ||
      typeof now !== 'function' || typeof schedule !== 'function' || typeof cancel !== 'function')
    throw new TypeError('Animation requires painting, error reporting and a clock');
  let active = false, reduced = false, disposed = false, failed = false;
  let timer = null, epoch = 0, elapsed = 0, previous = null, frames = 0;
  function clear() {
    epoch++;
    if (timer !== null) cancel(timer);
    timer = null;
    previous = null;
  }
  function draw() {
    if (!active || disposed || failed) return;
    try {
      const time = now();
      if (!Number.isFinite(time)) throw new Error('Animation clock is unavailable');
      if (previous !== null && !reduced) elapsed += Math.min(100, Math.max(0, time - previous));
      previous = time;
      paint(reduced ? 0 : elapsed);
      frames++;
    } catch (error) {
      failed = true;
      clear();
      onError(error);
      return;
    }
    if (!reduced && active && !disposed) {
      const version = epoch;
      timer = schedule(() => {
        if (version !== epoch || disposed) return;
        timer = null;
        draw();
      }, 34);
    }
  }
  return Object.freeze({
    setState(nextActive, reducedMotion = reduced) {
      if (disposed) throw new Error('Animation is disposed');
      if (typeof nextActive !== 'boolean' || typeof reducedMotion !== 'boolean')
        throw new TypeError('Animation activity and reduced motion must be boolean');
      if (nextActive === active && reducedMotion === reduced) return;
      clear();
      active = nextActive; reduced = reducedMotion;
      draw();
    },
    invalidate() {
      if (disposed) throw new Error('Animation is disposed');
      clear();
      draw();
    },
    get stats() { return { active, reducedMotion: reduced, disposed, failed, frames, pending: timer !== null }; },
    dispose() {
      if (disposed) return;
      active = false; disposed = true;
      clear();
    },
  });
}
