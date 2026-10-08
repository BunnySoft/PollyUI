const messages = {
  loading: 'Checking installed account state...',
  setup: 'Set separate passwords for your polly account and root maintenance. Neither has a default password.',
  login: 'Sign in to PollyDesktop with your polly account password.',
  polly: 'Setting the polly account password...',
  root: 'Setting the root maintenance password...',
  prepared: 'Passwords accepted. Preparing account initialization...',
  committing: 'Saving first-run setup. Please wait...',
  authenticating: 'Verifying your password...',
  handoff: 'Starting your ordinary-user desktop...',
  cancelled: 'Cancelled. First-run setup remains incomplete; passwords already accepted by the system are not rolled back.',
  denied: 'Password was not accepted. Please try again.',
  unavailable: 'The request result could not be confirmed. Check the account service and retry.',
  setupFailed: 'The system could not finish setup. No initialization success was reported. Retry with passwords accepted by the system policy.',
};

function validPassword(value) {
  if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value)) return false;
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code >= 0xd800 && code <= 0xdfff) return false;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes > 1024) return false;
  }
  return true;
}

export function createGreeterController({ backend, changed = () => {}, clear = () => {}, leave = () => {} }) {
  let state = { screen: 'loading', busy: false, cancellable: false, message: messages.loading };
  let generation = 0;
  let closed = false;
  const publish = update => {
    if (closed) return;
    state = { ...state, ...update };
    changed({ ...state });
  };
  const alive = token => !closed && token === generation;
  const failure = (error, setup) => !setup && error?.code === 'denied' ? messages.denied :
    setup && error?.code === 'password-policy' ? messages.setupFailed : messages.unavailable;
  const rejected = (error, setup) => ({
    screen: setup && error?.code === 'password-policy' ? 'setup' :
      !setup && error?.code === 'denied' ? 'login' : 'error',
    busy: false, cancellable: false, message: failure(error, setup),
  });

  async function refresh() {
    if (closed || state.busy) return;
    const token = ++generation;
    clear();
    publish({ screen: 'loading', busy: true, cancellable: false, message: messages.loading });
    try {
      const result = await backend.status();
      if (!alive(token)) return;
      if (result !== 'setup' && result !== 'login') throw new Error('Invalid account state');
      publish({ screen: result, busy: false, message: messages[result] });
    } catch (error) {
      if (alive(token)) publish({ screen: 'error', busy: false, message: failure(error, false) });
    }
  }

  async function submit(values) {
    if (closed || state.busy || !['setup', 'login'].includes(state.screen)) return;
    const setup = state.screen === 'setup';
    const discard = () => {
      clear();
      for (const key of Object.keys(values)) values[key] = '';
    };
    if (setup && [values.polly, values.root].some(value =>
      typeof value === 'string' && /[\x00-\x1f\x7f]/.test(value))) {
      discard();
      publish({ message: 'Setup passwords cannot contain ASCII control characters or Delete.' });
      return;
    }
    if (!validPassword(values.polly) || (setup && !validPassword(values.root))) {
      discard();
      publish({ message: 'Enter nonempty single-line passwords of at most 1024 UTF-8 bytes.' });
      return;
    }
    if (setup && (values.polly !== values.pollyConfirm || values.root !== values.rootConfirm)) {
      discard();
      publish({ message: 'The password confirmations do not match. Enter both passwords again.' });
      return;
    }
    if (setup && values.polly === values.root) {
      discard();
      publish({ message: 'Use different passwords for the polly account and root maintenance.' });
      return;
    }
    const token = ++generation;
    publish({ busy: true, cancellable: true, message: messages[setup ? 'polly' : 'authenticating'] });
    let operation;
    try {
      operation = setup ? backend.setup(values.polly, values.root) : backend.login(values.polly);
    } catch (error) {
      if (alive(token)) publish(rejected(error, setup));
    } finally {
      discard();
    }
    if (!operation) return;
    try {
      const result = await operation;
      if (!alive(token)) return;
      if (setup && result === 'login') {
        publish({ screen: 'login', busy: false, cancellable: false, message: messages.login });
      } else if (!setup && result === 'handoff') {
        publish({ busy: true, cancellable: false, message: messages.handoff });
        leave();
      } else if (result === 'cancelled') {
        publish({ busy: false, cancellable: false, message: setup ? messages.cancelled : messages.login });
      } else {
        throw new Error('Invalid authentication result');
      }
    } catch (error) {
      if (alive(token)) publish(rejected(error, setup));
    }
  }

  function progress(phase) {
    if (closed || !state.busy || !['polly', 'root', 'prepared', 'committing', 'authenticating', 'handoff'].includes(phase)) return;
    publish({ message: messages[phase], cancellable: !['committing', 'handoff'].includes(phase) });
  }

  function cancel() {
    clear();
    if (closed) return;
    if (state.busy) {
      if (!state.cancellable) return;
      try { backend.cancel(); publish({ cancellable: false, message: 'Cancelling. Waiting for the system to stop...' }); }
      catch { publish({ cancellable: false, message: messages.unavailable }); }
      return;
    }
    publish({ message: state.screen === 'setup' ? messages.cancelled : messages.login });
  }

  function close() {
    if (closed) return;
    clear();
    if (state.busy && state.cancellable) {
      try { backend.cancel(); } catch { console.error('Greeter could not cancel the pending account operation during shutdown.'); }
    }
    closed = true;
    generation++;
  }

  return { refresh, submit, cancel, close, progress, state: () => ({ ...state }) };
}
