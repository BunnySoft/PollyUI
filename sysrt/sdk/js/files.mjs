import { platform, libc } from 'sysrt:ffi';
import { loadNativeApi } from './sysrt/sdk/js/native.mjs';
import { filesBindings } from './sysrt/bindings/files.mjs';

export { fileSystemConstants as constants } from './sysrt/bindings/files.mjs';

export function createFileSystem() {
  if (platform !== 'linux' || !filesBindings[libc])
    throw new Error('FileSystem native bindings require Linux with glibc or musl');
  return loadNativeApi(filesBindings[libc]);
}
