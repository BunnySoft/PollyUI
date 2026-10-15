import { parseThemeFile } from './desktop/shared/ui/theme-schema.mjs';
import { paintCaptionFrame } from './desktop/shared/ui/caption-paint.mjs';

export function createDecorationRenderer({ native, document, failure }) {
  let running = false, draining = false;
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
          native.failDecorationFrame(request.meta, String(error));
        }
      }
    } finally { draining = false; }
  };
  return {
    start() {
      if (running) throw new Error('Decoration renderer is already running');
      if (typeof native?.startDecorationRenderer !== 'function')
        throw new Error('Independent decoration renderer v4 is unavailable');
      running = true;
      native.onDecorationRequestsChanged = drain;
      native.startDecorationRenderer();
    },
    stop() {
      running = false;
      native.onDecorationRequestsChanged = null;
      native.stopDecorationRenderer();
    },
  };
}
