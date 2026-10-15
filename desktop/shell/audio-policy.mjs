import { createAudioPersistence } from './desktop/shell/audio-preferences.mjs';
import { parseAudio, parseAudioAction } from './desktop/client/settings-domains-contract.mjs';

export function createAudioPolicy({ native, configuration, report = console.error }) {
  let started = false, previous = null, timer = null, error = '';
  const preferences = createAudioPersistence({ native, configuration, failure(failure) {
    error = String(failure); report('[shell] Audio: ' + error);
  } });
  function read() {
    const state = native.audioState();
    preferences.refresh(state);
    return state;
  }
  function refresh() {
    try { read(); } catch (failure) { error = String(failure); report('[shell] Audio: ' + error); }
  }
  const changed = () => { refresh(); if (typeof previous === 'function') previous(); };
  function start() {
    if (started || !native?.audioAvailable) return;
    try {
      native.startAudio(); preferences.start(); started = true;
      previous = native.onAudioChanged; native.onAudioChanged = changed;
      timer = setInterval(() => { if (preferences.busy) refresh(); }, 200);
      refresh();
    } catch (failure) { error = String(failure); report('[shell] Cannot start audio policy: ' + error); }
  }
  return Object.freeze({
    start,
    snapshot() {
      const available = native?.audioAvailable === true && typeof native.audioState === 'function';
      const state = available ? read() : { ready: false, revision: 0, generation: 0, error: '',
        defaultSink: null, defaultSource: null, preferredSink: '', preferredSource: '', nodes: [] };
      return parseAudio(JSON.stringify({ version: 1, available, ready: state.ready,
        revision: state.revision, generation: state.generation, error: error || state.error,
        status: available ? preferences.status : 'The private audio service is unavailable. Start the desktop with --audio.',
        busy: preferences.busy, defaultSink: state.defaultSink, defaultSource: state.defaultSource,
        preferredSink: state.preferredSink, preferredSource: state.preferredSource, nodes: state.nodes }));
    },
    action(source) {
      const action = parseAudioAction(source), state = read();
      if (preferences.busy) throw new Error('Audio settings are awaiting acknowledgement');
      const node = state.nodes.find(node => node.id === action.id && node.revision === action.revision &&
        node.instance === action.instance);
      if (!state.ready || state.generation !== action.generation || !node)
        throw new Error('Audio device changed; refresh before applying');
      const operation = { volume: 'setAudioVolume', mute: 'setAudioMute', default: 'setDefaultAudio' }[action.operation];
      error = '';
      preferences.change(node, operation, action.operation === 'default' ? undefined : action.value);
    },
    retry() {
      error = ''; start(); refresh();
    },
    forget(generation, revision) {
      const state = read();
      if (state.generation !== generation || state.revision !== revision) throw new Error('Audio state changed; review before forgetting');
      error = ''; preferences.forget();
    },
    stop() {
      if (!started) return;
      started = false; clearInterval(timer); timer = null; preferences.stop();
      if (native.onAudioChanged === changed) native.onAudioChanged = previous;
      native.stopAudio();
    },
  });
}
