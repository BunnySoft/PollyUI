import { createDecorationRenderer } from './desktop/shared/ui/decoration-renderer.mjs';
import { encodeDecorationLayout } from './desktop/shared/ui/caption-layout.mjs';
import { readBootstrapTheme } from './desktop/decorator/bootstrap.mjs';

if (typeof window !== 'undefined' || document.defaultView !== null)
  throw new Error('Decorator must run without a Window owner');
const renderer = createDecorationRenderer({ native: decoration, document,
  failure: error => console.error('[decorator] Frame failed: ' + String(error)) });
let bootstrapping = false;
decoration.onDecorationStatusChanged = () => {
  if (bootstrapping || !decoration.decorationStatus().bootstrap) return;
  bootstrapping = true;
  try {
    const theme = readBootstrapTheme(decoration);
    decoration.bootstrapAppearance(theme, encodeDecorationLayout(theme));
  } finally { bootstrapping = false; }
};
renderer.start();
console.log('[decorator] Independent windowless GUI renderer ready');
