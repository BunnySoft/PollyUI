import { platform } from 'sysrt:ffi';
import { loadNativeApi } from './sysrt/sdk/js/native.mjs';
import { networkBindings, networkConstants } from './sysrt/bindings/network.mjs';

export const constants = networkConstants[platform];

export function createNetworkApi() {
  if (!networkBindings[platform]) throw new Error('Network SDK is unavailable on ' + platform);
  return loadNativeApi(networkBindings[platform]);
}
