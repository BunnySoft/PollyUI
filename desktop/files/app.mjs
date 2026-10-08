import { render } from './js/reconciler.mjs';
import { subscribeDesktopTheme } from './desktop/client/theme.mjs';
import { createApplicationLauncher } from './desktop/shell/applications.mjs';
import { requireFileSystem } from './desktop/files/model.mjs';
import { createFilesController } from './desktop/files/controller.mjs';
import { filesView } from './desktop/files/view.mjs';

export function createFilesApp({ host = window, native = typeof desktop === 'undefined' ? null : desktop,
  initialPath = null, optInTheme = true, reportError = message => console.error('[files] ' + message) } = {}) {
  let surface = null, themeBinding = null, theme = null, themeError = '', stopped = false, api = null, apiError = null;
  try { api = requireFileSystem(native); } catch (error) { apiError = error; reportError(String(error)); }
  const launcher = native && typeof native.applicationFiles === 'function' ? createApplicationLauncher(native, reportError) : null;
  function paint() {
    if (!stopped && surface && !surface.closed)
      render(filesView(controller.getState(), controller, { theme, themeError }), surface.document.body);
  }
  const controller = createFilesController({ api: apiError ? { locations() { throw apiError; } } : api,
    launcher, onChange: paint, reportError });
  function stop() {
    if (stopped) return;
    stopped = true;
    controller.dispose(); themeBinding?.stop(); themeBinding = null;
    const current = surface; surface = null;
    if (current && !current.closed) current.close();
  }
  return {
    controller, stop, getWindow: () => surface,
    start() {
      if (stopped) throw new Error('Closed Files app cannot restart; create a new instance');
      if (surface && !surface.closed) return this;
      surface = host.create({ title: 'Files', width: 1040, height: 760 });
      surface.onclose = stop; host.close(); paint();
      if (optInTheme && typeof native?.startThemeSubscription === 'function') {
        try {
          themeBinding = subscribeDesktopTheme(snapshot => {
            theme = snapshot.ready ? snapshot.theme : null; themeError = ''; paint();
          }, { native, onError: error => { themeError = String(error); reportError(themeError); paint(); } });
        } catch (error) { themeError = String(error); reportError(themeError); paint(); }
      }
      controller.start(initialPath);
      return this;
    },
  };
}
