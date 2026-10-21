import { startSettingsRuntime } from './desktop/apps/settings/runtime.mjs';
import { openDbusService, openDbusClient } from './sysrt/sdk/js/dbus.mjs';
import { settingsEnvironment, settingsLaunchSpec } from './desktop/shared/settings-environment.mjs';
import { openShellSettings } from './desktop/shell/settings-native.mjs';
import { waitSettingsReply } from './desktop/client/settings.mjs';

// Shared only by existing native fixtures; product Settings never imports this probe.
export function createSettingsFixtureClient(signal) {
  const queryClient = openDbusClient(settingsEnvironment().address);
  let sequence = 0;
  function query(value) {
    return waitSettingsReply(queryClient.call({ destination: 'org.pollyui.Settings.Test',
      path: '/org/pollyui/SettingsTest', interface: 'org.pollyui.SettingsTest1', member: 'Query' },
    's', [JSON.stringify(value)], 's', 5000)).then(JSON.parse);
  }
  return {
    factory(handlers) {
      const spec = settingsLaunchSpec();
      spec.argv[3] = spec.cwd + '/desktop/tests/settings-probe.mjs';
      return openShellSettings({ ...handlers, launchSpec: spec });
    },
    query,
    async click(id) {
      const deadline = Date.now() + 15000;
      let control = null;
      while (!control?.enabled) {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for independent Settings control: ' + id);
        try { control = await query({ op: 'control', id }); }
        catch (error) {
          if (!String(error.message).includes('Missing independent Settings control')) throw error;
        }
        if (!control?.enabled) await new Promise(resolve => setTimeout(resolve, 10));
      }
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      control = await query({ op: 'control', id });
      await signal(`fixture-xdg-click ${++sequence} ${Math.floor(control.x + control.width / 2)} ` +
        `${Math.floor(control.y + control.height / 2)} 0 Settings`);
    },
    async key(code, modifiers = 0) {
      await signal(`fixture-settings-key ${++sequence} ${code} ${modifiers}`);
    },
    async close({ disconnect = true } = {}) {
      const view = desktop.windows().find(item => item.appId === 'org.pollyui.settings' && item.title === 'Settings');
      if (view) {
        desktop.closeWindow(view.id);
        const deadline = Date.now() + 5000;
        while (desktop.windows().some(item => item.id === view.id)) {
          if (Date.now() >= deadline) throw new Error('Owned fixture Settings did not close');
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
      if (disconnect) queryClient.close();
    },
  };
}

if (application.id === 'org.pollyui.settings') {
let endpoint = null, timer = null, nodeSerial = 0;
const nodeIdentities = new WeakMap();
const app = await startSettingsRuntime({ host: globalThis.settingsProbeHost || window, onStop() {
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
      if (query.op === 'state') result = { ...state, pageState: app.pages.getState(), pid: settingsEnvironment().pid,
        id: application.id, configDir: application.configDir, dataDir: application.dataDir,
        namespace: localStorage.getItem('settings.fixture.namespace'),
        shellPreference: localStorage.getItem('desktop.theme'),
        activeElement: surface.document.activeElement?.id || '',
        text: surface.document.body.textContent,
        versionFooter: surface.document.getElementById('settings-system-version')?.textContent || '' };
      else if (query.op === 'capture') {
        surface.capture(application.cacheDir + '/' + query.name); result = true;
      }       else if (query.op === 'dialog') {
        const walk = node => [node, ...Array.from(node.childNodes || []).flatMap(walk)];
        const dialog = walk(surface.document.body).find(node => node.getAttribute?.('role') === 'dialog');
        result = dialog ? { id: dialog.id, entries: walk(dialog).filter(node =>
          node.id?.startsWith(dialog.id + '-entry-')).map(node =>
          ({ id: node.id, caption: node.getAttribute('aria-label') || node.textContent })) } : null;
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
        if (!nodeIdentities.has(node)) nodeIdentities.set(node, ++nodeSerial);
        result = { x: rect.x, y: rect.y, width: rect.width, height: rect.height, text: node.textContent,
          nodeIdentity: nodeIdentities.get(node), enabled: node.getAttribute('aria-disabled') !== 'true' };
      } else throw new TypeError('Unknown test probe operation');
      request.reply([JSON.stringify(result)]);
    } catch (error) { request.error('org.pollyui.Settings.TestError', String(error)); }
  }, 10);
}
}
