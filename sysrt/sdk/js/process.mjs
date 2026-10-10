import { platform } from 'sysrt:ffi';
import { loadBindings, loadNativeApi } from './sysrt/sdk/js/native.mjs';
import { processBindings, processConstants } from './sysrt/bindings/process.mjs';

let bindings;
export const constants = processConstants[platform];

export function createProcessApi() {
  if (!processBindings[platform]) throw new Error('Process SDK is unavailable on ' + platform);
  return loadNativeApi(processBindings[platform]);
}

export function currentId() {
  if (!processBindings[platform]) throw new Error('Process SDK is unavailable on ' + platform);
  const { library, functions } = processBindings[platform];
  bindings ??= loadBindings({ library, functions: { currentId: functions.currentId } });
  const result = bindings.call('currentId');
  if (!Number.isInteger(result.value) || result.value <= 0)
    throw new Error('The OS returned an invalid current process ID');
  return result.value;
}

export function close() {
  bindings?.close();
  bindings = undefined;
}
