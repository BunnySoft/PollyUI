import { h, render } from './gui/sdk/js/reconciler.mjs';
import { themeTextSize } from './desktop/shell/theme-layout.mjs';
import { createAudioPersistence } from './desktop/shell/audio-preferences.mjs';
import { button as themedButton } from './desktop/shell/views.mjs';

export function createAudioSettings({ native, host, theme, report, configuration }) {
  let started = false, previous, window = null, state = null, error = '';
  let timer = null;
  let root = null, owned = false, attachment = null;
  const preferences = createAudioPersistence({ native, configuration, failure: failure => {
    error = 'Audio settings: ' + String(failure); report('[shell] ' + error);
  } });
  function close() {
    const current = window, closeWindow = owned;
    if (root) { root.ownerDocument.activeElement?.blur(); render(null, root); }
    window = root = attachment = null; owned = false;
    if (closeWindow && current && !current.closed) current.close();
  }
  function button(id, label, callback, enabled = true) {
    const current = theme(), owner = attachment, snapshot = state;
    const node = themedButton(id, label, current, () => {
      if (enabled && attachment === owner && state === snapshot && window && !window.closed) callback();
    }, false, { height: current.layout.choiceHeight,
      opacity: enabled ? 1 : current.layout.disabledOpacity });
    node.props.tabIndex = enabled ? 0 : -1;
    node.props['aria-disabled'] = String(!enabled);
    return node;
  }
  function change(node, operation, value) {
    try {
      error = '';
      preferences.change(node, operation, value);
      refresh();
    } catch (failure) { error = String(failure); report('[shell] Audio: ' + error); paint(); }
  }
  function paint() {
    if (!window || window.closed) return;
    const current = theme();
    const label = (text, size = 12) => h('view', { style: { color: current.colors.text,
      fontSize: themeTextSize(current, size), flexShrink: 0 } }, text);
    if (!state) {
      render(h('view', { style: { padding: current.layout.contentPadding, gap: current.layout.contentGap } },
        h('view', { role: 'alert' }, label(error || 'Audio state is unavailable.')),
        button('shell-audio-retry', 'Refresh / retry', retry)), root);
      return;
    }
    render(h('view', { id: 'shell-audio-settings', style: { width: '100%', height: '100%', minHeight: 0,
      padding: current.layout.contentPadding, gap: current.layout.contentGap,
      overflow: 'scroll', backgroundColor: current.colors.body } },
      h('view', { style: { flexDirection: 'row', gap: 8 } }, label('Audio (PipeWire)', 18),
        button('shell-audio-retry', 'Refresh / retry', retry, !preferences.busy),
        owned ? button('shell-audio-close', 'Close', close) : null),
      error || state.error ? h('view', { role: 'alert' }, label(error || state.error)) : null,
      label(preferences.status, 10),
      preferences.busy ? h('view', { role: 'status', 'aria-live': 'polite' },
        label('Waiting for the audio service to acknowledge and save changes...')) : null,
      button('shell-audio-forget-settings', 'Forget saved audio settings', () => {
        try { preferences.forget(); error = ''; paint(); }
        catch (failure) { error = String(failure); report('[shell] Audio: ' + error); paint(); }
      }),
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
            () => change(node, 'setAudioVolume', Math.min(1, Math.max(0, node.volume - 0.1))), state.ready && node.volume !== null && !preferences.busy),
          button('shell-audio-raise-' + node.id, '+10%', () => change(node, 'setAudioVolume', Math.min(1, node.volume + 0.1)),
            state.ready && node.volume !== null && node.volume < 1 && !preferences.busy),
          button('shell-audio-mute-' + node.id, node.muted ? 'Unmute' : 'Mute', () => change(node, 'setAudioMute', !node.muted),
            state.ready && node.muted !== null && !preferences.busy)),
        node.class === 'Audio/Sink' || node.class.startsWith('Audio/Source') ?
          button('shell-audio-default-' + node.id, state.defaultSink === node.id || state.defaultSource === node.id ? 'Selected default' : 'Use as default',
            () => change(node, 'setDefaultAudio'), state.ready && !preferences.busy &&
              state.defaultSink !== node.id && state.defaultSource !== node.id) : null))),
    root);
  }
  function refresh() {
    try {
      state = native.audioState();
      preferences.refresh(state);
      const rank = node => node.class === 'Audio/Sink' ? 0 : node.class.startsWith('Audio/Source') ? 1 : 2;
      state.nodes.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
      paint();
    }
    catch (failure) { state = null; error = String(failure); report('[shell] Audio: ' + error); paint(); }
  }
  const onChanged = () => { refresh(); if (typeof previous === 'function') previous(); };
  function start() {
    if (started || !native?.audioAvailable) return;
    try {
      native.startAudio();
      preferences.start();
      started = true; previous = native.onAudioChanged; native.onAudioChanged = onChanged;
      timer = setInterval(() => { if (preferences.busy) refresh(); }, 200);
      refresh();
    } catch (failure) { error = String(failure); report('[shell] Cannot start audio policy: ' + error); paint(); }
  }
  function retry() { error = ''; start(); refresh(); }
  return {
    start,
    paint,
    attach(owner, container) {
      close(); window = owner; root = container; owned = false; attachment = {};
      start(); refresh();
    },
    detach: close,
    show(outputId) {
      if (owned && window && !window.closed) return window;
      close();
      const output = host.displays().find(item => item.id === outputId) || host.displays()[0];
      if (!output) throw new Error('No output available for audio settings');
      const layout = theme().layout;
      window = host.create({ title: 'PollyShell.audio.' + output.id, output: output.id, layer: 'overlay',
        keyboard: 'on-demand', width: Math.max(1, Math.min(layout.audioWidth, output.width - layout.overlayInset * 2)),
        height: Math.max(1, Math.min(layout.audioHeight, output.height - layout.overlayVerticalInset * 2)), anchors: ['top', 'right'],
        margins: { top: layout.overlayTopMargin, right: layout.overlayRightMargin }, exclusiveZone: -1 });
      root = window.document.body; owned = true; attachment = {};
      const current = window;
      window.document.body.addEventListener('keydown', event => {
        if (window === current && event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); close(); }
      });
      window.onclose = () => { if (window === current) close(); };
      start(); refresh(); return window;
    },
    stop() {
      close();
      if (!started) return;
      started = false;
      if (timer !== null) clearInterval(timer);
      timer = null; preferences.stop();
      if (native.onAudioChanged === onChanged) native.onAudioChanged = previous;
      try { native.stopAudio(); } catch (failure) { report('[shell] Cannot stop audio policy: ' + String(failure)); }
    },
  };
}
