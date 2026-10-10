import { fileSystem } from './sysrt/sdk/js/files.mjs';

globalThis.desktop ??= {};
globalThis.desktop.fileSystem = fileSystem;
