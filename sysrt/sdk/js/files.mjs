import { platform, libc } from 'sysrt:ffi';
import { loadBindings } from './sysrt/sdk/js/native.mjs';
import { filesBindings } from './sysrt/bindings/files.mjs';

export { fileSystemConstants as constants } from './sysrt/bindings/files.mjs';

export function createFileSystem() {
  if (platform !== 'linux' || !filesBindings[libc])
    throw new Error('FileSystem native bindings require Linux with glibc or musl');
  const description = filesBindings[libc];
  const functions = Object.fromEntries(Object.values(description.functions).map(binding => [binding.symbol, binding]));
  const bindings = loadBindings({ ...description, functions });
  return Object.freeze({
    ...Object.fromEntries(Object.keys(functions).map(symbol =>
      [symbol, (...args) => bindings.call(symbol, ...args)])),
    createRecord: name => bindings.createRecord(name),
    dispose: () => bindings.close(),
  });
}
