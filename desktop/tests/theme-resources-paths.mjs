import { alloc } from 'sysrt:ffi';
import { createThemeResources } from './desktop/shared/theme-resources.mjs';
import { call, raw } from './desktop/shared/native-files.mjs';

const pointer = raw('environment', 'POLLY_THEME_CASE').value;
const buffer = alloc(128);
let mode;
try {
  const length = Number(call('stringLength', pointer, 127));
  raw('copy', buffer, pointer, length).value.close();
  mode = buffer.readString(128);
} finally { pointer.close(); buffer.close(); }
const service = createThemeResources(() => {}, () => { throw new Error('Unexpected decoder call'); });
if (mode === 'missing' || mode === 'fallback') {
  const result = service.readThemeFiles();
  if (result.files.length || result.overrides !== null) throw new Error('Missing roots must return an empty catalog');
} else {
  let rejected = false;
  try { service.readThemeFiles(); } catch (error) { rejected = true; }
  if (!rejected) throw new Error('Unsafe root path was accepted: ' + mode);
}
