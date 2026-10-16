import { call } from './desktop/shared/native-files.mjs';
import { fileSystem } from './desktop/shared/file-system.mjs';
import { readUserProfile } from './desktop/shared/user-profile.mjs';

export function readNativeUserProfile() {
  return readUserProfile({ uid: () => call('uid'), euid: () => call('euid'), fileSystem });
}
