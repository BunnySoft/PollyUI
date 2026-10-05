import { h, render } from './js/reconciler.mjs';
import { createTextInput } from './js/textinput.mjs';

export function createNetworkSettings({ native, host, theme, report }) {
  let surface = null, state = null, previous, started = false, error = '', confirmation = null;
  let prompt = 0, password = null, username = null;
  function failure(value) { error = String(value); report('[shell] Network: ' + error); paint(); }
  function clearCredentials() {
    if (password) password.value = '';
    if (username) username.value = '';
    prompt = 0; password = username = null;
  }
  function close() {
    if (state?.authentication) {
      try { native.replyNetworkAuthentication(state.authentication.id, null, null); }
      catch (value) { report('[shell] Cannot cancel network authentication: ' + String(value)); }
      state.authentication = null;
    }
    clearCredentials(); confirmation = null;
    if (surface && !surface.window.closed) surface.window.close();
    surface = null;
  }
  function button(id, label, callback, enabled = true) {
    const current = theme();
    return h('view', { id, role: 'button', tabIndex: enabled ? 0 : -1, 'aria-disabled': String(!enabled),
      style: { padding: 8, borderWidth: 1, borderColor: current.colors.border,
        borderRadius: current.button.radius, backgroundColor: current.colors.surface,
        color: enabled ? current.colors.text : current.colors.muted, fontSize: 12, flexShrink: 0 },
      onClick: () => { if (enabled) callback(); },
      onKeydown: event => {
        if (enabled && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); callback(); }
      },
    }, label);
  }
  const label = (value, size = 12) => h('view', { style: { fontSize: size, color: theme().colors.text, flexShrink: 0 } }, value);
  function perform(action, target, revision = state.revision) {
    try {
      error = ''; confirmation = null;
      native.networkAction(revision, target, action);
      refresh();
    } catch (value) { failure(value); }
  }
  function confirm(action, item, revision) { confirmation = { action, id: item.id, name: item.name, revision }; paint(); }
  function submitAuthentication(cancel, token) {
    try {
      const auth = state.authentication;
      if (!auth || auth.id !== token) throw new Error('Authentication prompt changed; review the current network request');
      native.replyNetworkAuthentication(token, cancel ? null : username?.value ?? '', cancel ? null : password.value);
      clearCredentials(); refresh();
    } catch (value) { failure(value); }
  }
  function paint() {
    if (!surface || surface.window.closed || !state) return;
    const current = theme(), owner = surface.window.document, auth = state.authentication;
    const revision = state.revision;
    let focusCredentials = false;
    if (!auth || auth.id !== prompt) {
      clearCredentials();
      if (auth) {
        focusCredentials = true;
        prompt = auth.id;
        password = createTextInput({ document: owner, password: true, width: 420, fontSize: 14 });
        password.root.id = 'shell-network-password';
        if (auth.kind === 'username-password') {
          username = createTextInput({ document: owner, value: auth.username, width: 420, fontSize: 14 });
          username.root.id = 'shell-network-username';
        }
      }
    }
    const content = [];
    if (auth) {
      const name = state.networks.find(item => item.id === auth.network)?.name || 'Wi-Fi network';
      content.push(label('Authenticate: ' + name, 16));
      content.push(label('iwd may save these credentials in its system network profile.'));
      if (username) content.push(label('Username'), h('view', { key: 'username-' + auth.id, style: { height: 32 }, onMount: node => node.appendChild(username.root) }));
      else if (auth.username) content.push(label('User: ' + auth.username));
      content.push(label(auth.kind === 'private-key' ? 'Private key passphrase' : 'Password'),
        h('view', { key: 'password-' + auth.id, style: { height: 32 }, onMount: node => node.appendChild(password.root) }));
      content.push(button('shell-network-auth-submit', 'Send credentials to iwd', () => submitAuthentication(false, auth.id)),
        button('shell-network-auth-cancel', 'Cancel', () => submitAuthentication(true, auth.id)));
    } else if (confirmation) {
      content.push(label(confirmation.name, 16));
      content.push(label(confirmation.action === 'forget' ?
        'Forget this saved network and its credentials? iwd will also disconnect it if connected.' :
        'Connect using iwd? Successful authentication can save credentials and enable automatic reconnection.'));
      content.push(button('shell-network-confirm', confirmation.action === 'forget' ? 'Forget network' : 'Connect',
        () => perform(confirmation.action, confirmation.id, confirmation.revision), state.ready && !state.operation),
        button('shell-network-confirm-cancel', 'Cancel', () => { confirmation = null; paint(); }));
    } else {
      if (!state.ready) content.push(label(state.error || error || 'Waiting for iwd...'));
      else if (!state.devices.length) content.push(label('No Wi-Fi adapters are available.'));
      if (state.networkConfiguration !== true) content.push(label(state.networkConfiguration === false ?
        'iwd IP configuration is disabled. Configure DHCP/address management before expecting network access.' :
        'iwd IP configuration status is not available.'));
      for (const [index, device] of state.devices.entries()) {
        content.push(label(device.name + ' - ' + (device.powered ? device.state || device.mode : 'powered off'), 14));
        content.push(h('view', { style: { flexDirection: 'row', gap: 6, flexShrink: 0 } },
          button('shell-network-power-' + index, device.powered ? 'Turn Wi-Fi off' : 'Turn Wi-Fi on',
            () => perform(device.powered ? 'power-off' : 'power-on', device.id, revision), !state.operation),
          button('shell-network-scan-' + index, device.scanning ? 'Scanning...' : 'Scan',
            () => perform('scan', device.id, revision), device.powered && device.station && !device.scanning && !state.operation),
          button('shell-network-disconnect-' + index, 'Disconnect', () => perform('disconnect', device.id, revision),
            device.powered && device.station && device.state !== 'disconnected' && !state.operation)));
        const entries = state.networks.filter(item => item.device === device.id).sort((a, b) => a.order - b.order);
        for (const [at, entry] of entries.entries()) {
          const supported = entry.type === 'open' || entry.type === 'psk' || (entry.type === '8021x' && entry.known);
          content.push(h('view', { style: { gap: 4, padding: 8, borderWidth: 1, borderColor: current.colors.border, flexShrink: 0 } },
            label(entry.name + ' [' + entry.type + '] ' + (entry.signal === null ? '' : entry.signal + ' dBm') +
              (entry.connected ? ' (selected)' : '')),
            entry.type === '8021x' && !entry.known ? label('Provision an EAP profile and certificate policy in iwd first.') : null,
            button('shell-network-connect-' + index + '-' + at, entry.known ? 'Connect saved network' : 'Connect...',
              () => confirm('connect', entry, revision), supported && device.powered && device.station &&
                state.registered && !state.operation && !entry.connected),
            entry.known ? button('shell-network-forget-' + index + '-' + at, 'Forget...', () => confirm('forget', entry, revision), !state.operation) : null));
        }
      }
    }
    render(h('view', { id: 'shell-network-settings', style: { flex: 1, padding: 12, gap: 8,
      overflow: 'scroll', backgroundColor: current.colors.body } },
      h('view', { style: { flexDirection: 'row', gap: 8, flexShrink: 0 } }, label('Wi-Fi (iwd)', 18),
        button('shell-network-retry', 'Refresh / retry', retry, !state.operation),
        button('shell-network-close', 'Close', close)),
      state.operation ? label('Operation: ' + state.operation) : null,
      state.operation === 'connect' ? button('shell-network-connect-cancel', 'Cancel connection', () => {
        try { native.cancelNetworkConnection(); clearCredentials(); refresh(); }
        catch (value) { failure(value); }
      }) : null,
      error || state.error ? h('view', { role: 'alert' }, label(error || state.error)) : null,
      ...content), owner.body);
    if (focusCredentials) (username || password).root.focus();
  }
  function refresh() {
    try { state = native.networkState(); paint(); }
    catch (value) { failure(value); }
  }
  function retry() {
    try {
      error = '';
      native.startNetwork();
      if (native.networkState().ready) native.refreshNetworks();
      refresh();
    } catch (value) { failure(value); }
  }
  const onChanged = () => { refresh(); if (typeof previous === 'function') previous(); };
  return {
    show(outputId) {
      if (surface && !surface.window.closed) { paint(); return surface.window; }
      const output = host.displays().find(item => item.id === outputId) || host.displays()[0];
      if (!output) throw new Error('No output available for network settings');
      const window = host.create({ title: 'PollyShell.network.' + output.id, output: output.id,
        layer: 'overlay', keyboard: 'exclusive', width: Math.max(1, Math.min(500, output.width - 24)),
        height: Math.max(1, Math.min(580, output.height - 48)), anchors: ['top', 'right'],
        margins: { top: 32, right: 12 }, exclusiveZone: -1 });
      surface = { window, output: output.id };
      window.document.body.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); close(); }
      });
      window.onclose = () => { if (surface?.window === window) close(); };
      if (!started) {
        previous = native.onNetworkChanged; native.onNetworkChanged = onChanged; started = true;
      }
      state = native.networkState();
      try { native.startNetwork(); } catch (value) { failure(value); }
      refresh(); return window;
    },
    stop() {
      close();
      if (!started) return;
      started = false;
      if (native.onNetworkChanged === onChanged) native.onNetworkChanged = previous;
      try { native.stopNetwork(); } catch (value) { report('[shell] Cannot stop network client: ' + String(value)); }
    },
    refresh() {
      if (surface && !host.displays().some(item => item.id === surface.output)) close();
      else if (surface) paint();
    },
  };
}
