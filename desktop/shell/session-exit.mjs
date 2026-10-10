import { h, render } from './gui/sdk/js/reconciler.mjs';

function inventory(value) {
  if (!value || value.version !== 1 || !['idle', 'waiting', 'ready', 'committed'].includes(value.phase) ||
      !['live', 'installed', 'development'].includes(value.profile) ||
      !['pendingWindows', 'pendingApplications', 'pendingActivations'].every(name =>
        Number.isSafeInteger(value[name]) && value[name] >= 0) ||
      typeof value.error !== 'string' || !Array.isArray(value.windows) || value.windows.length > 256 ||
      value.windows.some(item => !item || typeof item.title !== 'string' || typeof item.appId !== 'string') ||
      !Array.isArray(value.applications) || value.applications.some(item => typeof item !== 'string'))
    throw new Error('The native session-exit inventory is unavailable or invalid.');
  return { ...value, windows: value.windows.map(item => ({ ...item })), applications: [...value.applications] };
}

export function createSessionExitController({ native, changed = () => {}, report = console.error }) {
  let state = { action: null, phase: 'idle', windows: [], applications: [], pendingWindows: 0,
    pendingApplications: 0, pendingActivations: 0, profile: 'development', error: '', canCancel: false };
  let generation = 0, commit = null, active = true;
  const subscribers = new Set();
  const snapshot = () => ({ ...state, windows: state.windows.map(item => ({ ...item })), applications: [...state.applications] });
  function publish(update) {
    state = { ...state, ...update };
    changed(snapshot());
    for (const listener of subscribers) listener(snapshot());
  }
  function blocked(error, uncertain = false) {
    const message = String(error?.message || error);
    report('[shell] Session exit: ' + message);
    publish({ phase: uncertain ? 'uncertain' : 'blocked', error: message, canCancel: !uncertain });
  }
  function update(value) {
    const current = inventory(value);
    const ready = current.phase === 'ready' && !current.pendingWindows && !current.pendingApplications &&
      !current.pendingActivations && !current.error;
    publish({ ...current, phase: current.error ? 'blocked' : ready ? 'ready' : 'waiting', canCancel: true });
    return ready;
  }
  function refresh() {
    if (!active || !['waiting', 'ready'].includes(state.phase)) return;
    try { update(native.sessionExitState()); } catch (error) { blocked(error); }
  }
  function request({ action, commit: callback }) {
    if (!active || state.phase !== 'idle') return false;
    if (!['logout', 'poweroff', 'reboot'].includes(action) || typeof callback !== 'function')
      throw new TypeError('Session exit requires a supported action and a fixed commit callback.');
    for (const name of ['sessionExitState', 'beginSessionExit', 'cancelSessionExit', 'sealSessionExit'])
      if (typeof native?.[name] !== 'function') throw new Error('This engine does not support save-before-session-exit.');
    const current = inventory(native.sessionExitState());
    if (current.phase !== 'idle') throw new Error('Another session-exit request is already pending.');
    ++generation; commit = callback;
    publish({ ...current, action, phase: 'confirm', error: '', canCancel: true });
    return true;
  }
  function confirm() {
    if (!active || state.phase !== 'confirm') return;
    const token = generation;
    publish({ phase: 'waiting', error: '', canCancel: true });
    if (!active || generation !== token) return;
    try { update(native.beginSessionExit()); } catch (error) { blocked(error); }
  }
  function retry() {
    if (!active || state.phase !== 'waiting') return;
    try { update(native.beginSessionExit()); } catch (error) { blocked(error); }
  }
  function cancel() {
    if (!active || !state.canCancel) return false;
    try {
      if (state.phase !== 'confirm') {
        const result = inventory(native.cancelSessionExit());
        if (result.phase !== 'idle') throw new Error('Native session-exit cancellation was not acknowledged.');
      }
      ++generation; commit = null;
      publish({ action: null, phase: 'idle', error: '', canCancel: false,
        windows: [], applications: [], pendingWindows: 0, pendingApplications: 0, pendingActivations: 0 });
      return true;
    } catch (error) { blocked(error); return false; }
  }
  async function confirmCommit() {
    if (!active || state.phase !== 'ready') return;
    const token = generation, callback = commit;
    try {
      if (!update(native.sessionExitState()) || !active || generation !== token || state.phase !== 'ready') return;
      const sealed = inventory(native.sealSessionExit());
      if (sealed.phase !== 'committed' || sealed.pendingWindows || sealed.pendingApplications ||
          sealed.pendingActivations || sealed.error)
        throw new Error('The session still has pending applications; it has not been ended.');
      publish({ phase: 'committing', error: '', canCancel: false });
      await callback();
      if (active && generation === token)
        publish({ phase: 'complete', error: '', canCancel: false });
    } catch (error) {
      if (active && generation === token) blocked(error, error?.sent === true);
    }
  }
  return {
    request, confirm, confirmCommit, refresh, retry, cancel, snapshot,
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('Session-exit subscriber must be a function.');
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    start() { active = true; },
    stop() {
      if (state.canCancel) cancel();
      active = false; ++generation; commit = null;
    },
  };
}

export function createLogoutSurface({ controller, host, theme, commit }) {
  let surface = null;
  const close = () => {
    if (!controller.cancel()) return;
    if (surface && !surface.closed) surface.close();
    surface = null;
  };
  function paint() {
    if (!surface || surface.closed) return;
    const state = controller.snapshot();
    if (state.action !== 'logout') return;
    const current = theme();
    const target = surface;
    const button = (id, label, action) => h('view', { id, role: 'button', tabIndex: 0,
      style: { padding: 10, borderWidth: 1, borderColor: current.colors.border,
        backgroundColor: current.colors.surface, color: current.colors.text, flexShrink: 0 },
      onClick: event => { if (surface === target && !target.closed && event.button === 0) action(); },
      onKeydown: event => {
        if (surface === target && !target.closed && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault(); action();
        }
      } }, label);
    const label = text => h('view', { style: { color: current.colors.text, flexShrink: 0 } }, text);
    render(h('view', { id: 'shell-logout', style: { padding: 16, gap: 10, height: '100%',
      backgroundColor: current.colors.body, overflow: 'scroll' } },
      label('Log out'),
      label(state.profile === 'installed' ? 'End this user session and return to the login screen.' :
        state.profile === 'live' ? 'End this Live desktop and return to your ordinary, temporary console.' :
        'End this development desktop session.'),
      label('Applications receive a normal close request. Save or cancel in each app. No files are reported as saved by the desktop.'),
      state.phase === 'confirm' ? button('shell-logout-confirm', 'Ask applications to close', controller.confirm) : null,
      ['waiting', 'ready', 'blocked'].includes(state.phase) ? [
        label('Remaining windows: ' + state.pendingWindows + '; launched applications: ' + state.pendingApplications),
        ...state.windows.map(item => label(item.title || item.appId || 'Untitled window')),
        ...state.applications.map(item => label('Still running: ' + item)),
        state.pendingActivations ? label('Waiting for application activation to settle.') : null,
      ] : null,
      state.phase === 'waiting' ? [
        label('The session is retained while an app saves, declines closing, or has not exited.'),
        button('shell-logout-retry', 'Request close again', controller.retry),
      ] : null,
      state.phase === 'ready' ? button('shell-logout-commit', 'Log out now', controller.confirmCommit) : null,
      state.phase === 'committing' ? label('Ending this session...') : null,
      state.error ? h('view', { role: 'alert' }, label(state.error)) : null,
      state.canCancel ? button('shell-logout-cancel', 'Keep this session', close) : null), surface.document.body);
  }
  let unsubscribe = controller.subscribe(paint);
  return {
    show(outputId) {
      if (!unsubscribe) unsubscribe = controller.subscribe(paint);
      if (surface && !surface.closed) return surface;
      const output = host.displays().find(item => item.id === outputId) || host.displays()[0];
      if (!output) throw new Error('No display is available for logout confirmation.');
      if (!controller.request({ action: 'logout', commit })) return null;
      try {
        surface = host.create({ title: 'PollyShell.logout.' + output.id, output: output.id,
          layer: 'overlay', keyboard: 'on-demand', width: Math.min(480, output.width),
          height: Math.min(500, output.height), anchors: ['top', 'right'], exclusiveZone: -1 });
      } catch (error) {
        controller.cancel();
        throw error;
      }
      const current = surface;
      surface.oncloserequest = () => {
        if (surface !== current) return true;
        close(); return false;
      };
      surface.onclose = () => {
        if (surface !== current) return;
        if (controller.snapshot().canCancel) controller.cancel();
        surface = null;
      };
      surface.document.body.addEventListener('keydown', event => {
        if (surface === current && event.key === 'Escape' && controller.snapshot().canCancel) {
          event.preventDefault(); close();
        }
      });
      paint();
      return surface;
    },
    paint,
    stop() {
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
      if (surface && !surface.closed) surface.close();
      surface = null;
    },
  };
}
