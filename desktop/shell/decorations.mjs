import { parseThemeFile } from './desktop/shared/ui/theme-schema.mjs';
import { paintCaptionFrame } from './desktop/shared/ui/caption-paint.mjs';

export function createDecorationRenderer({ native, document, failure }) {
  let running = false, draining = false, previous = null;
  const drain = () => {
    if (!running || draining) return;
    draining = true;
    try {
      for (const request of native.decorationRequests()) {
        try {
          const theme = parseThemeFile(request.document);
          const strips = paintCaptionFrame({ document, theme, meta: request.meta, title: request.title });
          native.submitDecorationFrame(request.meta, strips);
        } catch (error) {
          failure(error);
          try { native.failDecorationFrame(request.meta, String(error)); }
          catch (reportError) { failure(reportError); }
        }
      }
    } catch (error) { failure(error); }
    finally { draining = false; }
  };
  return {
    start() {
      if (running || typeof native?.decorationRequests !== 'function') return;
      running = true; previous = native.onDecorationRequestsChanged;
      native.onDecorationRequestsChanged = drain;
    },
    stop() {
      if (running && typeof native?.stopDecorationRenderer === 'function') {
        try { native.stopDecorationRenderer(); }
        catch (error) { failure(error); }
      }
      running = false;
      if (native?.onDecorationRequestsChanged === drain) native.onDecorationRequestsChanged = previous;
    },
  };
}
