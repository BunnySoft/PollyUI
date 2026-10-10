import { SETTINGS_METHODS, settingsTarget, daemonTarget } from './desktop/client/settings-contract.mjs';

export function waitSettingsReply(ticket) {
  return new Promise((resolve, reject) => {
    function poll() {
      let outcome;
      try { outcome = ticket.poll(); } catch (error) { reject(error); return; }
      if (outcome.state === 'pending') { setTimeout(poll, 10); return; }
      if (outcome.state === 'reply') resolve(outcome.value);
      else reject(outcome.error || new Error('Settings request cancelled; remote effects are not rolled back'));
    }
    poll();
  });
}
export function createSettingsClient(client) {
  let closed = false;
  return Object.freeze({
    call(member, argument) {
      if (closed) return Promise.reject(new Error('Settings client is closed'));
      const method = SETTINGS_METHODS[member];
      if (!method) return Promise.reject(new TypeError('Unknown Settings method'));
      try {
        return waitSettingsReply(client.call(settingsTarget(member), method.signature,
          method.signature ? [argument] : [], method.replySignature, member === 'Open' ? 8000 : 5000));
      } catch (error) { return Promise.reject(error); }
    },
    close() { if (!closed) { closed = true; client.close(); } },
  });
}
export async function settingsPeer(client, sender) {
  if (typeof sender !== 'string' || !sender.startsWith(':'))
    throw new TypeError('Settings peer must be a unique bus name');
  const pid = await waitSettingsReply(client.call(daemonTarget('GetConnectionUnixProcessID'), 's', [sender], 'u', 3000));
  const uid = await waitSettingsReply(client.call(daemonTarget('GetConnectionUnixUser'), 's', [sender], 'u', 3000));
  return { pid, uid };
}
