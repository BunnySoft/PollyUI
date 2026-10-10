import { startSettingsRuntime } from './desktop/apps/settings/runtime.mjs';
import { openDbusService } from './sysrt/sdk/js/dbus.mjs';
import { settingsEnvironment } from './desktop/shared/settings-environment.mjs';

let endpoint = null, timer = null;
const app = await startSettingsRuntime({ onStop() {
  if (timer !== null) clearInterval(timer);
  endpoint?.close();
} });
if (app) {
  if (typeof desktop !== 'object' || Object.keys(desktop).length !== 1 || !desktop.fileSystem)
    throw new Error('Standalone Settings must have only the public file API, not desktop management');
  localStorage.setItem('settings.fixture.namespace', application.id);
  endpoint = openDbusService(settingsEnvironment().address, { name: 'org.pollyui.Settings.Test',
    path: '/org/pollyui/SettingsTest', interface: 'org.pollyui.SettingsTest1',
    methods: { Query: { signature: 's', replySignature: 's' } } });
  timer = setInterval(() => {
    let request;
    try { request = endpoint.poll(); }
    catch {
      clearInterval(timer); timer = null; endpoint.close();
      setTimeout(() => {
        if (!app.controller.getState().error) throw new Error('Settings did not expose private bus loss');
        app.getWindow().capture(application.cacheDir + '/settings-disconnected.png');
        console.log('PASS: independent Settings displays daemon disconnect without reconnect/replay');
      }, 1000);
      return;
    }
    if (!request) return;
    try {
      const query = JSON.parse(request.args[0]), surface = app.getWindow();
      const state = app.controller.getState();
      let result;
      if (query.op === 'state') result = { ...state, pid: settingsEnvironment().pid,
        id: application.id, configDir: application.configDir, dataDir: application.dataDir,
        namespace: localStorage.getItem('settings.fixture.namespace'),
        shellPreference: localStorage.getItem('desktop.theme'),
        activeElement: surface.document.activeElement?.id || '',
        text: surface.document.body.textContent };
      else if (query.op === 'capture') {
        surface.capture(application.cacheDir + '/' + query.name); result = true;
      } else if (query.op === 'control') {
        const node = surface.document.getElementById(query.id);
        if (!node) throw new Error('Missing independent Settings control: ' + query.id);
        let rect = node.getBoundingClientRect();
        for (let parent = node.parentNode; parent; parent = parent.parentNode) {
          if (parent.style.overflow !== 'scroll') continue;
          const viewport = parent.getBoundingClientRect();
          if (rect.y < viewport.y || rect.y + rect.height > viewport.y + viewport.height)
            parent.scrollTop = Math.max(0, Number(parent.scrollTop) + rect.y - viewport.y);
        }
        rect = node.getBoundingClientRect();
        result = { x: rect.x, y: rect.y, width: rect.width, height: rect.height, text: node.textContent };
      } else throw new TypeError('Unknown test probe operation');
      request.reply([JSON.stringify(result)]);
    } catch (error) { request.error('org.pollyui.Settings.TestError', String(error)); }
  }, 10);
}
