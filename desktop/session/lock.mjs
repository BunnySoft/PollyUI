import { createTextInput } from './js/textinput.mjs';

window.close();
const surfaces = new Map();
let submitting = false;
let localError = '';
function sync() {
  const state = sessionLock.state();
  if (state.unlocked) {
    for (const surface of surfaces.values()) {
      surface.password.root.blur();
      surface.password.value = '';
    }
    window.quit();
    return;
  }
  const displays = window.displays();
  for (const [id, surface] of surfaces) if (!displays.some(display => display.id === id)) {
    surface.password.root.blur();
    surface.password.value = '';
    if (!surface.window.closed) surface.window.close();
    surfaces.delete(id);
  }
  for (const display of displays) if (!surfaces.has(display.id)) {
    const native = window.create({ title: 'Polly session lock', width: display.width, height: display.height,
      sessionLockOutput: display.id });
    const doc = native.document;
    Object.assign(doc.body.style, { backgroundColor: '#101820', justifyContent: 'center', alignItems: 'center', gap: 18 });
    const title = doc.createElement('view');
    title.textContent = 'Session locked';
    Object.assign(title.style, { color: '#ffffff', fontSize: 28 });
    const status = doc.createElement('view');
    Object.assign(status.style, { color: '#d4dce4', fontSize: 15, maxWidth: Math.max(1, display.width - 40) });
    const password = createTextInput({ document: doc, password: true,
      width: Math.max(1, Math.min(360, display.width - 40)), fontSize: 20, padding: 12,
      background: '#ffffff', color: '#101820' });
    const submit = doc.createElement('view');
    submit.tabIndex = 0;
    submit.setAttribute('role', 'button');
    submit.textContent = 'Unlock';
    Object.assign(submit.style, { color: '#ffffff', backgroundColor: '#245dc9', fontSize: 16, padding: 12, borderRadius: 8 });
    const surface = { window: native, password, status, submit };
    const authenticate = () => {
      const current = sessionLock.state();
      if (!current.locked || current.busy || current.retryMs || submitting) return;
      submitting = true;
      try { sessionLock.authenticate(password.value); localError = ''; }
      catch (error) { localError = String(error); status.textContent = localError; }
      finally {
        for (const entry of surfaces.values()) entry.password.value = '';
        submitting = false;
      }
    };
    submit.addEventListener('click', authenticate);
    doc.body.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); authenticate(); }
    });
    for (const node of [title, status, password.root, submit]) doc.body.appendChild(node);
    surfaces.set(display.id, surface);
    password.root.focus();
  }
  for (const surface of surfaces.values()) {
    const enabled = state.locked && !state.busy && !state.retryMs;
    surface.submit.setAttribute('aria-disabled', String(!enabled));
    surface.submit.tabIndex = enabled ? 0 : -1;
    surface.submit.style.opacity = enabled ? 1 : 0.5;
    surface.status.textContent = state.busy ? 'Verifying...' : state.retryMs ?
      'Please wait before trying again.' : localError || state.error || (state.locked ? 'Enter your account password.' : 'Securing displays...');
  }
}
sessionLock.onChanged = sync;
sync();
setInterval(sync, 250);
