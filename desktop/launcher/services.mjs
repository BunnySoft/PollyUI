import { fileSystem } from './desktop/shared/file-system.mjs';
import { createThemeResources } from './desktop/shared/theme-resources.mjs';

globalThis.desktop ??= {};
globalThis.desktop.fileSystem = fileSystem;
if (typeof desktop.windows === 'function') {
  const windows = desktop.windows.bind(desktop);
  Object.assign(desktop, createThemeResources(windows, globalThis.createBitmap));
}
