import { currentId, close } from './sysrt/sdk/js/process.mjs';

const pid = currentId();
if (!Number.isInteger(pid) || pid <= 0 || currentId() !== pid)
  throw new Error('Process SDK must report the current OS process');
close();
if (currentId() !== pid) throw new Error('Reload changed the current process identity');
close();
console.log('PASS: JS/config process SDK through the registered native FFI module');
