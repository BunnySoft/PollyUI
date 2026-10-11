import { fileSystem } from './desktop/shared/file-system.mjs';
import { createThemeResources } from './desktop/shared/theme-resources.mjs';
import { createNetworkService, systemBusAddress } from './desktop/services/network.mjs';

globalThis.desktop ??= {};
globalThis.desktop.fileSystem = fileSystem;
if (typeof desktop.windows === 'function') {
  const windows = desktop.windows.bind(desktop);
  Object.assign(desktop, createThemeResources(windows, globalThis.createBitmap));
  createNetworkService(windows, systemBusAddress, desktop);
}
