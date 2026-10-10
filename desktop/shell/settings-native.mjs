import { openDbusClient, openDbusService } from './sysrt/sdk/js/dbus.mjs';
import { settingsEnvironment, settingsLaunchSpec } from './desktop/shared/settings-environment.mjs';
import { SETTINGS_APP_ID, SETTINGS_BUS_NAME, SETTINGS_PATH, SETTINGS_INTERFACE,
  SETTINGS_METHODS } from './desktop/client/settings-contract.mjs';
import { createSettingsService } from './desktop/shell/settings-service.mjs';

export function openShellSettings({ native, launchSpec = null, ...handlers }) {
  const environment = settingsEnvironment(), spec = launchSpec || settingsLaunchSpec();
  const service = openDbusService(environment.address, { name: SETTINGS_BUS_NAME,
    path: SETTINGS_PATH, interface: SETTINGS_INTERFACE, methods: SETTINGS_METHODS });
  let client;
  try {
    client = openDbusClient(environment.address);
    return createSettingsService({ ...handlers, ...environment, service, client,
      spawn: page => native.spawnApplication([...spec.argv, page], spec.cwd, SETTINGS_APP_ID),
      activate() {
        const view = native.windows().find(view => view.appId === SETTINGS_APP_ID && view.title === 'Settings');
        if (view) native.activateWindow(view.id);
      },
    });
  } catch (error) {
    try { service.close(); } finally { client?.close(); }
    throw error;
  }
}
