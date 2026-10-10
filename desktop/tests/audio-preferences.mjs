import { readAudioPreferences, createAudioPersistence } from './desktop/shell/audio-preferences.mjs';
function check(value, message) { if (!value) throw new Error('FAIL: ' + message); console.log('PASS: ' + message); }
function rejects(action, message) { let failed = false; try { action(); } catch { failed = true; } check(failed, message); }
const speaker = { name: 'speaker', class: 'Audio/Sink', volume: 0.4, muted: true };
const microphone = { name: 'microphone', class: 'Audio/Source', volume: 0.6, muted: false };
const profile = { version: 1, preferredSink: 'speaker', preferredSource: 'microphone', devices: [speaker, microphone] };
check(readAudioPreferences(JSON.stringify(profile)).devices[1].muted === false, 'microphone unmute is a deliberate persisted setting');
for (const patch of [{ version: 2 }, { extra: true }, { preferredSink: 'x'.repeat(257) },
  { devices: [{ ...speaker, volume: 1.1 }] }, { devices: [{ ...speaker, muted: 0 }] },
  { devices: [{ ...speaker, class: 'Stream/Output/Audio' }] }, { devices: [speaker, speaker] },
  { devices: [{ ...speaker, name: '\0' }] }]) {
  rejects(() => readAudioPreferences(JSON.stringify({ ...profile, ...patch })), 'invalid preference data is rejected');
}
rejects(() => readAudioPreferences(' '.repeat(65537)), 'audio preference document limit is enforced');
let time = 0, saved = JSON.stringify(profile), failWrite = false, writes = 0;
const errors = [], requests = [];
const configuration = {
  get snapshot() { return { audio: saved === null ? null : readAudioPreferences(saved) }; },
  update({ audio }) { if (failWrite) throw new Error('disk full'); writes++; saved = audio === null ? null : JSON.stringify(audio); },
};
let state = { ready: true, generation: 1, error: '', preferredSink: '', preferredSource: '', nodes: [
  { ...speaker, id: 10, instance: '31', revision: 1, volume: 1, muted: false },
  { ...microphone, id: 11, instance: '32', revision: 2, volume: 1, muted: true },
] };
const native = Object.fromEntries(['setAudioVolume', 'setAudioMute', 'setDefaultAudio'].map(operation =>
  [operation, (...args) => requests.push({ operation, args })]));
const create = () => createAudioPersistence({ native, configuration, failure: error => errors.push(String(error)), now: () => time });
let persistence = create();
persistence.start(); persistence.refresh(state);
check(requests.length === 6 && writes === 0, 'startup restores volume, mute and selected devices without persisting transient defaults');
check(requests.some(request => request.operation === 'setAudioMute' && request.args[0] === 11 && request.args[2] === false),
  'saved microphone unmute is restored explicitly');
persistence.refresh(state);
check(requests.length === 6, 'unacknowledged restores are not replayed on each snapshot');
state = { ...state, preferredSink: 'speaker', preferredSource: 'microphone', nodes: [
  { ...state.nodes[0], ...speaker, revision: 3 }, { ...state.nodes[1], ...microphone, revision: 4 },
] };
persistence.refresh(state);
check(!persistence.busy && writes === 0, 'daemon state acknowledges restoration without rewriting storage');
persistence.change(state.nodes[0], 'setAudioVolume', 0.7);
persistence.refresh(state);
check(writes === 0, 'sending a volume request is not treated as confirmation');
state.nodes[0] = { ...state.nodes[0], revision: 5, volume: 0.7 };
persistence.refresh(state);
check(JSON.parse(saved).devices[0].volume === 0.7 && writes === 1, 'actual echoed volume commits preferences');
failWrite = true;
persistence.change(state.nodes[1], 'setAudioMute', true);
state.nodes[1] = { ...state.nodes[1], revision: 6, muted: true };
persistence.refresh(state);
check(errors.at(-1).includes('disk full') && JSON.parse(saved).devices[1].muted === false,
  'write error preserves last durable microphone setting and is reported');
failWrite = false; persistence.refresh(state);
check(JSON.parse(saved).devices[1].muted && !persistence.busy, 'pending durable write is retried explicitly');
const recorded = saved;
persistence.change(state.nodes[0], 'setAudioVolume', 0.2);
time = 6000; persistence.refresh(state);
const afterTimeout = requests.length;
check(saved === recorded && errors.at(-1).includes('not acknowledged'), 'control timeout reports failure and does not persist a guess');
persistence.refresh(state);
check(requests.length === afterTimeout, 'timed-out controls are not blindly retried');
state.nodes = [];
persistence.refresh(state);
check(saved === recorded && persistence.status.includes('unavailable'), 'missing device uses fallback without overwriting saved selection');
state = { ...state, generation: 2, preferredSink: '', preferredSource: '', nodes: [
  { ...speaker, id: 71, instance: '92', revision: 10, volume: 1, muted: false },
] };
persistence.refresh(state);
check(requests.slice(afterTimeout).every(request => request.args[0] === 71), 'reconnect resolves current IDs instead of replaying stored IDs');
state.nodes.push({ ...state.nodes[0], id: 72, instance: '93' });
persistence.refresh(state);
rejects(() => persistence.change(state.nodes[0], 'setAudioVolume', 0.3), 'ambiguous endpoint names cannot be persisted');
check(errors.some(error => error.includes('Ambiguous')), 'ambiguous restoration is reported');
saved = '{broken'; persistence = create(); persistence.start(); persistence.refresh(state);
rejects(() => persistence.change(state.nodes[0], 'setAudioMute', true), 'corrupt saved settings require explicit recovery');
check(saved === '{broken', 'corrupt file is not overwritten automatically');
persistence.forget();
check(saved === null, 'forget removes only saved preferences');
