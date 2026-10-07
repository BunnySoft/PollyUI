import { render } from './js/reconciler.mjs';
import { subscribeDesktopTheme } from './desktop/client/theme.mjs';
import { createTargetController } from './desktop/installer/target-controller.mjs';
import { targetView } from './desktop/installer/target-view.mjs';

/** Ordinary application window; no Shell surface or privilege API.
 * A provider must be explicitly injected by a future trusted integration.
 * Theme subscription is opt-in and changes bounded component color cues only.
 */
export function createTargetApp({ host = window, provider = null, optInTheme = false,
  native = typeof desktop === 'undefined' ? null : desktop, synthetic = false,
  reportError = message => console.error('[installer] ' + message), timeoutMs = 10000 } = {}) {
  let surface = null, themeBinding = null, pollyTheme = null, themeError = '', stopped = false;
  function paint() {
    if (!surface || surface.closed || stopped) return;
    render(targetView(controller.getState(), controller, { pollyTheme, themeError, synthetic }), surface.document.body);
  }
  const controller = createTargetController({ provider, timeoutMs, reportError, onChange: paint });
  function stop() {
    if (stopped) return;
    stopped = true;
    const current = surface; surface = null;
    controller.dispose();
    themeBinding?.stop(); themeBinding = null;
    if (current && !current.closed) current.close();
  }
  return {
    controller, stop, getWindow: () => surface,
    start() {
      if (stopped) throw new Error('Closed installer target view cannot restart');
      if (surface && !surface.closed) return this;
      surface = host.create({ title: synthetic ? 'Synthetic installation target review - NO WRITE' :
        'Installation target review - read-only', width: 1040, height: 800 });
      surface.onclose = stop;
      host.close();
      paint();
      if (optInTheme) {
        try {
          themeBinding = subscribeDesktopTheme(snapshot => {
            pollyTheme = snapshot.ready ? snapshot.theme : null; themeError = ''; paint();
          }, { native, onError: error => {
            themeError = String(error); reportError(themeError); paint();
          } });
        } catch (error) {
          themeError = String(error); reportError(themeError); paint();
        }
      }
      if (provider) controller.refresh();
      return this;
    },
  };
}
