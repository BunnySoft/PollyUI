import { h, render } from './js/reconciler.mjs';
import { button as themedButton } from './desktop/shell/views.mjs';

export function createPowerSettings({ native, host, theme, report, sessionExit = null }) {
  let surface = null, previous, started = false, state = null, error = '', revision = 0;
  let unsubscribe = null, completion = null;
  const flow = () => sessionExit?.snapshot() || { phase: 'idle', canCancel: false, profile: 'unknown' };
  const powerFlow = value => value.action === 'poweroff' || value.action === 'reboot';
  const available = action => state?.version === 1 && state.ready && state.active && state[action] === 'yes' &&
    !state.busy && !state.operation && !state.sent;
  function powerError(value, sent) {
    const problem = value instanceof Error ? value : new Error(String(value));
    problem.sent = sent;
    return problem;
  }
  function failure(value) {
    error = String(value);
    report('[shell] Power: ' + error);
    paint();
  }
  function settle() {
    if (!completion || !state) return;
    if (!['accepted', 'failed', 'rejected', 'uncertain', 'cancelled'].includes(state.outcome)) return;
    const pending = completion;
    completion = null;
    if (state.outcome === 'accepted') pending.resolve();
    else {
      const problem = new Error(state.error || (state.outcome === 'cancelled' ?
        'Power action cancelled before sending.' : 'The power action was not accepted.'));
      problem.sent = state.sent === true || state.outcome === 'uncertain';
      pending.reject(problem);
    }
  }
  function commitPower(action) {
    try {
      state = native.powerState();
      if (!available(action)) throw new Error('Power permission or session changed. No power action was sent.');
      if (completion) throw new Error('A power request is already being tracked.');
      return new Promise((resolve, reject) => {
        completion = { resolve, reject };
        try { native.requestPower(state.revision, action); refresh(); }
        catch (value) {
          completion = null;
          reject(powerError(value, false));
        }
      });
    } catch (value) {
      return Promise.reject(powerError(value, false));
    }
  }
  function cancel() {
    try {
      const current = flow();
      if (powerFlow(current) && current.canCancel && current.phase !== 'committing' && !completion) {
        sessionExit.cancel();
        error = '';
        refresh();
        return;
      }
      state = native.powerState();
      if (!powerFlow(current) || (!current.canCancel &&
          !(current.phase === 'committing' && state.cancellable))) return;
      if (state.sent) throw new Error('The final power request was sent; cancellation is no longer available.');
      if (state.cancellable) native.cancelPower();
      settleCancelled();
      if (current.canCancel) sessionExit.cancel();
      else Promise.resolve().then(() => {
        if (powerFlow(flow()) && flow().canCancel) sessionExit.cancel();
      }).catch(failure);
      error = '';
      refresh();
    } catch (value) { failure(value); }
  }
  function settleCancelled() {
    if (!completion) return;
    const pending = completion;
    completion = null;
    const problem = new Error('Power action cancelled before sending.');
    problem.sent = false;
    pending.reject(problem);
  }
  function settleUnknown(value) {
    if (!completion) return;
    const pending = completion;
    completion = null;
    pending.reject(powerError(new Error('Unable to inspect the final power result; the action may already have been sent. ' +
      String(value)), true));
  }
  function close() {
    const current = surface;
    if (powerFlow(flow()) && (flow().canCancel || state?.cancellable)) cancel();
    surface = null;
    revision++;
    if (current) {
      current.document.body.removeEventListener('keydown', keydown);
      current.document.activeElement?.blur();
      if (!current.closed) current.close();
    }
  }
  function button(id, text, action, enabled = true) {
    const owner = surface, generation = revision, current = theme();
    const node = themedButton(id, text, current, () => {
      if (enabled && surface === owner && !owner.closed && revision === generation) action();
    }, false, { height: current.layout.choiceHeight,
      opacity: enabled ? 1 : current.layout.disabledOpacity });
    node.props.tabIndex = enabled ? 0 : -1;
    node.props['aria-disabled'] = String(!enabled);
    return node;
  }
  function request(action) {
    try {
      state = native.powerState();
      if (!available(action)) throw new Error('This action is not currently authorized for your active local session.');
      if (!sessionExit) throw new Error('Safe application-close coordination is unavailable; no power action was sent.');
      error = '';
      sessionExit.request({ action, commit: () => commitPower(action) });
      paint();
    } catch (value) { failure(value); }
  }
  function invoke(action) {
    try {
      const result = action();
      if (result && typeof result.then === 'function') result.catch(failure);
    } catch (value) { failure(value); }
  }
  function paint() {
    if (!surface || surface.closed) return;
    revision++;
    const current = theme(), status = flow();
    const active = powerFlow(status) && status.phase !== 'idle';
    const label = text => h('view', { style: { color: current.colors.text,
      fontSize: current.layout.fontSize, flexShrink: 0 } }, text);
    const title = status.action === 'reboot' ? 'Restart' : 'Shut down';
    let content;
    if (active && status.phase === 'confirm') content = [
      label(title + ' this system?'),
      label('Applications will receive their normal Close request. Save or cancel in each application. Nothing is force-killed.'),
      label(status.profile === 'live' ? 'This Live session loses memory-only files and settings after shutdown.' :
        'Save your work first. Memory-only Live files are not preserved after shutdown.'),
      button('shell-power-confirm', 'Close applications and continue', () => invoke(() => sessionExit.confirm()),
        available(status.action)),
    ];
    else if (active && ['waiting', 'ready'].includes(status.phase)) content = [
      label(status.phase === 'waiting' ? 'Waiting for applications to close' : 'Applications are closed'),
      ...status.windows.map(item => label(item.title || item.appId || 'Application window')),
      ...status.applications.map(id => label('Application still running: ' + id)),
      status.pendingActivations ? label('Waiting for application activation to settle.') : null,
      status.phase === 'waiting' ? label('A Save / Cancel prompt or application may still be open. Cancel here to keep the session; already closed applications stay closed.') :
        label('The final request will recheck your current login session and the daemon permission.'),
      status.phase === 'waiting' ? button('shell-power-retry-applications', 'Ask remaining applications to close',
        () => invoke(() => sessionExit.retry()), typeof sessionExit.retry === 'function') :
        button('shell-power-commit', 'Confirm ' + title.toLowerCase(), () => invoke(() => sessionExit.confirmCommit()),
          available(status.action)),
    ];
    else if (active && status.phase === 'committing') content = [
      label(state?.sent ? 'Final request sent to the login service. It cannot be cancelled here.' :
        'Rechecking the active local session and power permission...'),
    ];
    else if (active && status.phase === 'complete') content = [
      label('The login service accepted the request. Waiting for ' + title.toLowerCase() + '.'),
      label('Do not submit another power request.'),
    ];
    else if (active && status.phase === 'uncertain') content = [
      label('The request may already have reached the login service. Its final result is unknown.'),
      label('Do not repeat the request. This panel cannot undo a shutdown/restart already sent.'),
    ];
    else if (active && status.phase === 'blocked') content = [
      label('The power flow stopped. Review the error and cancel to return to the session.'),
      label('Applications that already closed are not reopened.'),
    ];
    else content = [
      ...[['poweroff', 'Shut down'], ['reboot', 'Restart']].map(([action, text]) =>
        button('shell-power-' + action, text + (state?.[action] === 'challenge' ? ' (authorization required)' : ''),
          () => request(action), !!sessionExit && available(action) && status.phase === 'idle')),
      !sessionExit ? label('Safe application-close coordination is unavailable in this build.') : null,
      status.phase !== 'idle' && !powerFlow(status) ? label('Another session exit is already in progress.') : null,
      state && state.version !== 1 ? label('This native power backend cannot track final request outcomes; actions are disabled.') : null,
      state?.ready && !state.active ? label('Power actions require your own active local seat session.') : null,
      state?.ready && (state.poweroff !== 'yes' || state.reboot !== 'yes') ?
        label('The login service has not authorized every action. No authorization agent or privilege bypass is installed by this panel.') : null,
      label('Suspend and hibernate are not supported in this Alpha flow.'),
    ];
    const cancellable = active && !state?.sent &&
      (status.canCancel || (status.phase === 'committing' && state?.cancellable));
    render(h('view', { id: 'shell-power-settings', style: { flex: 1, padding: current.layout.contentPadding,
      gap: current.layout.contentGap, backgroundColor: current.colors.body, overflow: 'scroll' } },
      label('Power'),
      button('shell-power-close', 'Close', close, !active || cancellable ||
        ['blocked', 'uncertain', 'complete'].includes(status.phase)),
      !state ? label('Power service state is unavailable.') :
        !state.ready ? label('Waiting for a verified local login service...') : null,
      error || state?.error || (active && status.error) ?
        h('view', { role: 'alert' }, label(error || state?.error || status.error)) : null,
      h('view', { role: 'status', 'aria-live': 'polite', style: { gap: current.layout.contentGap } }, content),
      cancellable ? button('shell-power-cancel', 'Cancel and keep session', cancel) : null,
      button('shell-power-retry', 'Refresh service status', () => {
        try { native.stopPower(); native.startPower(); error = ''; refresh(); }
        catch (value) { failure(value); }
      }, !active && !state?.sent && !state?.operation)), surface.document.body);
  }
  function refresh() {
    try { state = native.powerState(); settle(); paint(); }
    catch (value) { state = null; settleUnknown(value); failure(value); }
  }
  function keydown(event) {
    if (!surface || surface.closed || event.defaultPrevented || event.key !== 'Escape') return;
    event.preventDefault();
    const status = flow();
    if (powerFlow(status) && status.phase !== 'idle') {
      if ((status.canCancel || state?.cancellable) && !state?.sent) cancel();
    } else close();
  }
  const onChanged = () => { refresh(); if (typeof previous === 'function') previous(); };
  return {
    show(outputId) {
      if (surface && !surface.closed) { refresh(); return surface; }
      const output = host.displays().find(item => item.id === outputId) || host.displays()[0];
      if (!output) throw new Error('No display is available for power settings');
      const layout = theme().layout;
      const window = host.create({ title: 'PollyShell.power.' + output.id, output: output.id, layer: 'overlay',
        keyboard: 'on-demand', width: Math.max(1, Math.min(layout.audioWidth, output.width - layout.overlayInset * 2)),
        height: Math.max(1, Math.min(layout.menuHeight, output.height - layout.overlayVerticalInset * 2)),
        anchors: ['top', 'right'], margins: { top: layout.overlayTopMargin, right: layout.overlayRightMargin }, exclusiveZone: -1 });
      surface = window;
      window.document.body.addEventListener('keydown', keydown);
      window.onclose = () => { if (surface === window) close(); };
      if (!started) {
        previous = native.onPowerChanged; native.onPowerChanged = onChanged; started = true;
        unsubscribe = sessionExit?.subscribe(paint) || null;
      }
      try { native.startPower(); error = ''; }
      catch (value) { failure(value); }
      refresh();
      return window;
    },
    paint,
    stop() {
      close();
      unsubscribe?.(); unsubscribe = null;
      if (!started) return;
      started = false;
      if (native.onPowerChanged === onChanged) native.onPowerChanged = previous;
      try { native.stopPower(); state = native.powerState(); settle(); }
      catch (value) { settleUnknown(value); report('[shell] Cannot stop power service: ' + String(value)); }
    },
  };
}
