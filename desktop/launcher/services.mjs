import { fileSystem } from './desktop/shared/file-system.mjs';

globalThis.desktop ??= {};
globalThis.desktop.fileSystem = fileSystem;
