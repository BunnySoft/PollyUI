import { createShellConfiguration, defaultShellConfiguration } from './desktop/shell/configuration.mjs';
import { encodeUtf8, decodeUtf8 } from './sysrt/sdk/js/encoding.mjs';

export function memoryConfiguration(initial = defaultShellConfiguration(), write = () => {}) {
  let bytes = encodeUtf8(JSON.stringify(initial));
  return createShellConfiguration({
    read: () => bytes,
    write(next) {
      try { write(JSON.parse(decodeUtf8(next))); }
      catch (error) { if (error.committed) bytes = next.slice(); throw error; }
      bytes = next.slice();
    },
    close() {},
  }, () => { throw new Error('Existing configuration must not read legacy storage'); });
}
export const fixtureShortcuts = [
  { action: 'minimize-window', label: 'Minimize', modifiers: 4, key: 'F9' },
  ...['switch-window', 'close-window', 'maximize-window', 'fullscreen-window',
    'previous-workspace', 'next-workspace'].map(action => ({ action, label: action, modifiers: 0, key: '' })),
];
