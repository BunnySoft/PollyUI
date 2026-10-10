import { openDbusClient, openDbusService } from './sysrt/sdk/js/dbus.mjs';
import { settingsEnvironment } from './desktop/shared/settings-environment.mjs';
import { createSettingsClient, settingsPeer, waitSettingsReply } from './desktop/client/settings.mjs';
import { SETTINGS_BUS_NAME, SETTINGS_INSTANCE_NAME, SETTINGS_PATH, SETTINGS_INTERFACE, settingsPage,
  daemonTarget } from './desktop/client/settings-contract.mjs';
import { createSettingsApp } from './desktop/apps/settings/app.mjs';

export async function startSettingsRuntime({ args = application.arguments, onStop = () => {} } = {}) {
  const managed = args[0] === '--managed';
  if (args.length > (managed ? 2 : 1)) throw new TypeError('Settings accepts one page, or --managed and one page');
  const page = settingsPage(args[managed ? 1 : 0] || 'appearance');
  let endpoint = null, rawClient = null, client = null, app = null, timer = null, shellPid = 0;
  function cleanup() {
    if (timer !== null) clearInterval(timer);
    timer = null;
    try { endpoint?.close(); } finally { client?.close(); rawClient?.close(); }
  }
  try {
    const environment = settingsEnvironment();
    rawClient = openDbusClient(environment.address); client = createSettingsClient(rawClient);
    if (!managed) {
      await client.call('Open', page);
      cleanup(); onStop(); window.quit();
    } else {
      endpoint = openDbusService(environment.address, { name: SETTINGS_INSTANCE_NAME, path: SETTINGS_PATH,
        interface: SETTINGS_INTERFACE, methods: { Present: { signature: 's', replySignature: '' } } });
      const handshake = await client.call('Connect');
      if (!Array.isArray(handshake) || handshake.length !== 3 || !Number.isInteger(handshake[0]) || handshake[0] <= 0 ||
          !Number.isInteger(handshake[1]) || handshake[1] <= 0) throw new Error('Invalid owned Settings handshake');
      shellPid = handshake[0];
      const shellOwner = await waitSettingsReply(rawClient.call(daemonTarget('GetNameOwner'), 's', [SETTINGS_BUS_NAME], 's', 3000));
      const shellPeer = await settingsPeer(rawClient, shellOwner);
      if (shellPeer.pid !== shellPid || shellPeer.uid !== environment.uid)
        throw new Error('Settings handshake does not match the native Shell service PID');
      app = createSettingsApp({ client, page: settingsPage(handshake[2]),
        onStop: () => { cleanup(); onStop(); window.quit(); } }).start();
      let pending = false;
      timer = setInterval(() => {
        if (pending) return;
        let request;
        try { request = endpoint.poll(); } catch (error) { cleanup(); app.controller.fail(error); return; }
        if (!request) return;
        if (request.noReply) { request.close(); return; }
        pending = true;
        settingsPeer(rawClient, request.sender).then(peer => {
          if (peer.pid !== shellPid || peer.uid !== environment.uid)
            throw new Error('Presentation caller is not the owning Shell PID');
          app.present(settingsPage(request.args[0]));
          request.reply([]);
        }).catch(error => {
          try { request.error('org.pollyui.Settings.Error.AccessDenied', String(error.message)); }
          catch (replyError) { app.controller.fail(replyError); }
        }).finally(() => { pending = false; request.close(); });
      }, 10);
    }
  } catch (error) {
    cleanup();
    const failedClient = { call: () => Promise.reject(error), close() {} };
    app = createSettingsApp({ client: failedClient, page, onStop: () => { onStop(); window.quit(); } }).start();
    app.controller.fail(error);
  }
  return app;
}
