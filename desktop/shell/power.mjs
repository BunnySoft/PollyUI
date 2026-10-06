import { h, render } from './js/reconciler.mjs';

export function createPowerSettings({ native, host, theme, report }) {
  let surface = null, previous, started = false, state = null, error = '', confirmation = null;
  function close() {
    confirmation = null;
    if (surface && !surface.closed) surface.close();
    surface = null;
  }
  function button(id, label, action, enabled = true) {
    const current = theme();
    return h('view', { id, role: 'button', tabIndex: enabled ? 0 : -1, 'aria-disabled': String(!enabled),
      style: { padding: current.layout.serviceButtonPadding, borderWidth: current.layout.borderWidth,
        borderColor: current.colors.border, borderRadius: current.button.radius,
        backgroundColor: current.colors.surface, color: enabled ? current.colors.text : current.colors.muted,
        fontSize: current.layout.fontSize, flexShrink: 0 },
      onClick: () => { if (enabled) action(); },
      onKeydown: event => {
        if (enabled && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); action(); }
      },
    }, label);
  }
  function paint() {
    if (!surface || surface.closed || !state) return;
    const current = theme();
    const label = text => h('view', { style: { color: current.colors.text,
      fontSize: current.layout.fontSize, flexShrink: 0 } }, text);
    render(h('view', { id: 'shell-power-settings', style: { flex: 1, padding: current.layout.contentPadding,
      gap: current.layout.contentGap, backgroundColor: current.colors.body, overflow: 'scroll' } },
      h('view', { style: { fontSize: current.layout.largeHeadingFontSize, color: current.colors.text } }, 'Power'),
      button('shell-power-close', 'Close', close),
      error || state.error ? h('view', { role: 'alert' }, label(error || state.error)) : null,
      !state.ready ? label('Waiting for an authorized local login session...') : null,
      state.ready && !state.active ? label('Power actions require your active local session.') : null,
      state.operation ? label('Requesting ' + state.operation + '...') : null,
      confirmation ? [
        label(confirmation.action === 'poweroff' ? 'Shut down this system?' : 'Restart this system?'),
        label('Unsaved work will be lost. A Live session loses all memory-only files and settings.'),
        button('shell-power-confirm', confirmation.action === 'poweroff' ? 'Confirm shutdown' : 'Confirm restart', () => {
          try {
            native.requestPower(confirmation.revision, confirmation.action);
            confirmation = null; error = ''; refresh();
          } catch (failure) { error = String(failure); report('[shell] Power: ' + error); confirmation = null; paint(); }
        }, state.ready && state.active && !state.operation),
        button('shell-power-cancel', 'Cancel', () => { confirmation = null; paint(); }),
      ] : [
        ...[['poweroff', 'Shut down'], ['reboot', 'Restart']].map(([action, text]) =>
          button('shell-power-' + action, text + (state[action] === 'challenge' ? ' (authorization required)' : ''),
            () => { confirmation = { action, revision: state.revision }; paint(); },
            state.ready && state.active && state[action] === 'yes' && !state.operation)),
        label('Suspend and hibernate are disabled until authenticated lock-before-suspend is available.'),
      ],
      button('shell-power-retry', 'Refresh / retry', () => {
        try { native.stopPower(); native.startPower(); error = ''; confirmation = null; refresh(); }
        catch (failure) { error = String(failure); report('[shell] Power: ' + error); paint(); }
      }, !state.operation)), surface.document.body);
  }
  function refresh() {
    try { state = native.powerState(); paint(); }
    catch (failure) { error = String(failure); report('[shell] Power: ' + error); paint(); }
  }
  const onChanged = () => { refresh(); if (typeof previous === 'function') previous(); };
  return {
    show(outputId) {
      if (surface && !surface.closed) return surface;
      const output = host.displays().find(item => item.id === outputId) || host.displays()[0];
      if (!output) throw new Error('No display is available for power settings');
      const layout = theme().layout;
      surface = host.create({ title: 'PollyShell.power.' + output.id, output: output.id, layer: 'overlay',
        keyboard: 'exclusive', width: Math.max(1, Math.min(layout.audioWidth, output.width - layout.overlayInset * 2)),
        height: Math.max(1, Math.min(layout.menuHeight, output.height - layout.overlayVerticalInset * 2)),
        anchors: ['top', 'right'], margins: { top: layout.overlayTopMargin, right: layout.overlayRightMargin }, exclusiveZone: -1 });
      surface.document.body.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); close(); } });
      if (!started) {
        previous = native.onPowerChanged; native.onPowerChanged = onChanged; started = true;
      }
      try { native.startPower(); error = ''; }
      catch (failure) { error = String(failure); report('[shell] Power: ' + error); }
      refresh();
      return surface;
    },
    paint,
    stop() {
      close();
      if (!started) return;
      started = false;
      if (native.onPowerChanged === onChanged) native.onPowerChanged = previous;
      try { native.stopPower(); } catch (failure) { report('[shell] Cannot stop power service: ' + String(failure)); }
    },
  };
}
