import { open, callback } from 'sysrt:ffi';

function check(value, message) { if (!value) throw new Error(message); }
function refuses(action, code) {
  try { action(); } catch (error) {
    check(error.code === code, 'Expected ' + code + ', received ' + error);
    return;
  }
  throw new Error('Missing shutdown refusal: ' + code);
}
const library = open(fixtureLibrary);
const run = library.bind('sr_callback_i32', { result: 'i32', parameters: ['callback', 'i32', 'i32'] });
const signature = { result: 'i32', parameters: ['i32'] };
let count = 0;
const handle = callback(signature, value => {
  count++;
  shutdownNative();
  refuses(() => callback(signature, value => value), 'ERR_FFI_SHUTDOWN');
  refuses(() => handle.close(), 'ERR_FFI_BUSY');
  collect();
  return value;
});
refuses(() => run(handle, 4, 3), 'ERR_FFI_SHUTDOWN');
check(count === 1, 'Shutdown suppresses later JS entry without destroying in-flight native closures');
handle.close();
refuses(() => run(handle, 4, 1), 'ERR_FFI_SHUTDOWN');
refuses(() => callback(signature, value => value), 'ERR_FFI_SHUTDOWN');
run.close(); library.close();
