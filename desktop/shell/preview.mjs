import { createAppearancePreview } from './desktop/shell/appearance.mjs';

// Run from the repository root: pollyui desktop/shell/preview.mjs
// These are simulated desktop surfaces, not a running PollyWM session.
createAppearancePreview().mount(document.body);
