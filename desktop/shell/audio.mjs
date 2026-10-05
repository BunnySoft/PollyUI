import { h, render } from './js/reconciler.mjs';
import { themeTextSize } from './desktop/shell/theme-layout.mjs';

export function createAudioSettings({ native, host, theme, report }) {
  let started = false, previous, window = null, state = null, error = '';
  function close() { if (window && !window.closed) window.close(); window = null; }
  function button(id, label, callback, enabled = true) {
    const current = theme();
    return h('view', { id, role: 'button', tabIndex: enabled ? 0 : -1, 'aria-disabled': String(!enabled),
      style: { padding: current.layout.serviceButtonPadding, flexShrink: 0, backgroundColor: current.colors.surface,
        borderWidth: current.layout.borderWidth, borderColor: current.colors.border, borderRadius: current.button.radius,
        color: enabled ? current.colors.text : current.colors.muted, fontSize: current.layout.fontSize },
      onClick: () => { if (enabled) callback(); },
      onKeydown: event => { if (enabled && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); callback(); } },
    }, label);
  }
  function change(node, operation, value) {
    try {
      error = '';
      native[operation](node.id, node.revision, ...(value === undefined ? [] : [value]));
    } catch (failure) { error = String(failure); report('[shell] Audio: ' + error); paint(); }
  }
  function paint() {
    if (!window || window.closed || !state) return;
    const current = theme();
    const label = (text, size = 12) => h('view', { style: { color: current.colors.text,
      fontSize: themeTextSize(current, size), flexShrink: 0 } }, text);
    render(h('view', { id: 'shell-audio-settings', style: { flex: 1, padding: current.layout.contentPadding, gap: current.layout.contentGap,
      overflow: 'scroll', backgroundColor: current.colors.body } },
      h('view', { style: { flexDirection: 'row', gap: 8 } }, label('Audio (PipeWire)', 18),
        button('shell-audio-close', 'Close', close)),
      error || state.error ? h('view', { role: 'alert' }, label(error || state.error)) : null,
      !state.ready ? label(native.audioAvailable ? 'Waiting for the private audio service...' : 'Start the desktop with --audio to enable its own audio service.') : null,
      state.ready && !state.nodes.length ? label('No audio endpoints are available.') : null,
      state.ready && state.nodes.length && state.defaultSink === null ? label('No playback output is available.') : null,
      state.ready && state.nodes.length && state.defaultSource === null ? label('No recording input is available.') : null,
      state.preferredSink && !state.nodes.some(node => node.name === state.preferredSink) ?
        label('Preferred output is unavailable; using an available fallback.') : null,
      state.preferredSource && !state.nodes.some(node => node.name === state.preferredSource) ?
        label('Preferred input is unavailable; using an available fallback.') : null,
      ...state.nodes.map(node => h('view', { style: { padding: 8, gap: 6, flexShrink: 0,
        borderWidth: current.layout.borderWidth, borderColor: current.colors.border } },
        label(node.description, 14),
        label(node.class + ' - ' + node.state),
        label(node.volume === null ? 'Volume control unavailable' : 'Volume: ' + Math.round(node.volume * 100) + '%'),
        h('view', { style: { flexDirection: 'row', gap: 6, flexShrink: 0 } },
          button('shell-audio-lower-' + node.id, node.volume > 1 ? 'Set to 100%' : '-10%',
            () => change(node, 'setAudioVolume', Math.min(1, Math.max(0, node.volume - 0.1))), state.ready && node.volume !== null),
          button('shell-audio-raise-' + node.id, '+10%', () => change(node, 'setAudioVolume', Math.min(1, node.volume + 0.1)), state.ready && node.volume !== null),
          button('shell-audio-mute-' + node.id, node.muted ? 'Unmute' : 'Mute', () => change(node, 'setAudioMute', !node.muted), state.ready && node.muted !== null)),
        node.class === 'Audio/Sink' || node.class.startsWith('Audio/Source') ?
          button('shell-audio-default-' + node.id, state.defaultSink === node.id || state.defaultSource === node.id ? 'Selected default' : 'Use as default',
            () => change(node, 'setDefaultAudio'), state.ready) : null))),
    window.document.body);
  }
  function refresh() {
    try {
      state = native.audioState();
      const rank = node => node.class === 'Audio/Sink' ? 0 : node.class.startsWith('Audio/Source') ? 1 : 2;
      state.nodes.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
      paint();
    }
    catch (failure) { error = String(failure); report('[shell] Audio: ' + error); }
  }
  const onChanged = () => { refresh(); if (typeof previous === 'function') previous(); };
  function start() {
    if (started || !native?.audioAvailable) return;
    try {
      native.startAudio();
      started = true; previous = native.onAudioChanged; native.onAudioChanged = onChanged;
      refresh();
    } catch (failure) { error = String(failure); report('[shell] Cannot start audio policy: ' + error); }
  }
  return {
    start,
    paint,
    show(outputId) {
      if (window && !window.closed) return window;
      const output = host.displays().find(item => item.id === outputId) || host.displays()[0];
      if (!output) throw new Error('No output available for audio settings');
      const layout = theme().layout;
      window = host.create({ title: 'PollyShell.audio.' + output.id, output: output.id, layer: 'overlay',
        keyboard: 'on-demand', width: Math.max(1, Math.min(layout.audioWidth, output.width - layout.overlayInset * 2)),
        height: Math.max(1, Math.min(layout.audioHeight, output.height - layout.overlayVerticalInset * 2)), anchors: ['top', 'right'],
        margins: { top: layout.overlayTopMargin, right: layout.overlayRightMargin }, exclusiveZone: -1 });
      window.document.body.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); close(); }
      });
      start(); refresh(); return window;
    },
    stop() {
      close();
      if (!started) return;
      started = false;
      if (native.onAudioChanged === onChanged) native.onAudioChanged = previous;
      try { native.stopAudio(); } catch (failure) { report('[shell] Cannot stop audio policy: ' + String(failure)); }
    },
  };
}
