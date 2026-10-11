import { openDbusClient } from './sysrt/sdk/js/dbus.mjs';
import { createSettingsClient } from './desktop/client/settings.mjs';
import { parseAbout, parseAppearance, runtimeBuild } from './desktop/client/settings-contract.mjs';
import { settingsEnvironment } from './desktop/shared/settings-environment.mjs';

const expected = application.arguments[0];
if (!/^[0-9a-f]{40}$/.test(expected)) throw new Error('Expected explicit frozen runtime revision');
const client = createSettingsClient(openDbusClient(settingsEnvironment().address));
try {
  const about = parseAbout(await client.call('GetAbout'));
  const appearance = parseAppearance(await client.call('GetAppearance'));
  const ownBuild = runtimeBuild();
  for (const build of [about.build, appearance.build, ownBuild]) {
    if (build.version !== '0.1.0-alpha.7' || build.revision !== expected || build.sourceDirty !== false)
      throw new Error('Actual running Settings/Shell snapshot differs from frozen Alpha.7: ' + JSON.stringify(build));
  }
  console.log('POLLY_VM_SETTINGS_BUILD=' + JSON.stringify({
    about: about.build, appearance: appearance.build, probe: ownBuild, themeId: appearance.themeId,
  }));
} finally {
  client.close();
  window.quit();
}
