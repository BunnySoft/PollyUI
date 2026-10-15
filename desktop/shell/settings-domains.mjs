import { displayIdentity, validateDisplayDraft, parseDisplays, parseKeyboard, parseKeyboardAction, payload, token, fields } from './desktop/client/settings-domains-contract.mjs';
import { saveShortcuts } from './desktop/shell/shortcuts.mjs';

export function createSettingsDomains({ native, configuration, displayPersistence, updateOutputs,
  displayError, audio, recorder, report = console.error }) {
  let keyboardRevision = 1, signature = '', keyboardError = '';
  function keyboardSnapshot(owner) {
    const available = typeof native?.shortcuts === 'function';
    const bindings = available ? native.shortcuts() : [];
    const next = JSON.stringify(bindings);
    if (next !== signature) { signature = next; keyboardRevision = (keyboardRevision + 1) >>> 0 || 1; }
    return parseKeyboard(JSON.stringify({ version: 1, available, revision: keyboardRevision,
      error: keyboardError, bindings, recording: recorder.snapshot(owner) }));
  }
  function save(bindings) {
    try { saveShortcuts(native, configuration, bindings); keyboardError = ''; }
    catch (error) { keyboardError = String(error); report('[shell] Shortcut settings: ' + keyboardError); throw error; }
  }
  return Object.freeze({
    displays() {
      const available = typeof native?.outputConfiguration === 'function';
      const snapshot = available ? native.outputConfiguration() :
        { serial: 0, pendingToken: 0, remainingMs: 0, outcome: 0, message: '', heads: [] };
      return parseDisplays(JSON.stringify({ version: 1, available, error: displayError(),
        status: available ? displayPersistence.status : 'Trusted output management is unavailable.', ...snapshot }));
    },
    applyDisplays(source) {
      const draft = validateDisplayDraft(payload(source)), actual = native.outputConfiguration();
      if (actual.pendingToken || actual.serial !== draft.serial || actual.heads.length !== draft.heads.length ||
          draft.heads.some(head => !actual.heads.some(item => displayIdentity(item) === displayIdentity(head))))
        throw new Error('Display identities or serial changed; review the current configuration');
      native.applyOutputConfiguration(draft);
      updateOutputs();
    },
    forgetDisplays(serial) {
      token(serial, true);
      const actual = native.outputConfiguration();
      if (actual.pendingToken || actual.serial !== serial) throw new Error('Display configuration changed');
      displayPersistence.forget();
    },
    audio: () => audio.snapshot(),
    retryAudio: () => audio.retry(),
    audioAction: source => audio.action(source),
    forgetAudio(source) {
      const value = payload(source); fields(value, ['generation', 'revision']);
      token(value.generation); token(value.revision, true);
      audio.forget(value.generation, value.revision);
    },
    keyboard: keyboardSnapshot,
    keyboardAction(owner, source) {
      const action = parseKeyboardAction(source), actual = keyboardSnapshot(owner);
      if (!actual.available || actual.revision !== action.revision) throw new Error('Shortcut catalog changed; refresh it');
      if (actual.recording) throw new Error('Cancel the current shortcut recording first');
      if (action.operation !== 'reset' && !actual.bindings.some(binding => binding.action === action.action))
        throw new Error('Unknown shortcut action');
      if (action.operation === 'record') {
        const revision = actual.revision;
        recorder.begin(owner, action.action, binding => {
          const current = keyboardSnapshot(owner);
          if (current.revision !== revision) throw new Error('Shortcut catalog changed while recording; no change was saved');
          save(current.bindings.map(item => item.action === action.action ? { ...item, ...binding } : item));
        }, error => { keyboardError = String(error); report('[shell] Shortcut recording: ' + keyboardError); });
      } else if (action.operation === 'disable') {
        save(actual.bindings.map(binding => binding.action === action.action ? { ...binding, key: '', modifiers: 0 } : binding));
      } else {
        save(native.shortcutDefaults());
      }
    },
    cancelRecording(owner, value) {
      token(value);
      if (!recorder.cancel(owner, value)) throw new Error('Shortcut recording token is stale or belongs to another owner');
    },
    detach(owner) { recorder.detach(owner); },
  });
}
