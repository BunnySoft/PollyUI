import { platform } from 'sysrt:ffi';
import { loadBindings } from './sysrt/sdk/js/native.mjs';
import { processBindings } from './sysrt/bindings/process.mjs';

let bindings;

export function currentId() {
  if (!processBindings[platform]) throw new Error('Process SDK is unavailable on ' + platform);
  bindings ??= loadBindings(processBindings[platform]);
  const result = bindings.call('currentId');
  if (!Number.isInteger(result.value) || result.value <= 0)
    throw new Error('The OS returned an invalid current process ID');
  return result.value;
}

export function close() {
  bindings?.close();
  bindings = undefined;
}
