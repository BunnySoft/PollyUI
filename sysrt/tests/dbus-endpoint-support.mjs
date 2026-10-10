import { alloc, libc } from 'sysrt:ffi';
import { loadBindings } from './sysrt/sdk/js/native.mjs';
import { createNetworkApi } from './sysrt/sdk/js/network.mjs';
import { monotonicNanoseconds, close as closeClock } from './sysrt/sdk/js/clock.mjs';
import { encodeUtf8 } from './sysrt/sdk/js/encoding.mjs';

export { monotonicNanoseconds };
export function check(value, message) { if (!value) throw new Error(message); }
export function refuses(action, code) {
  try { action(); } catch (error) {
    check(code ? error.code === code : error instanceof TypeError || error instanceof RangeError,
      'Unexpected rejection: ' + error);
    return;
  }
  throw new Error('Expected rejection: ' + code);
}
const wait = createNetworkApi();
const system = loadBindings({
  library: libc === 'glibc' ? 'libc.so.6' : 'libc.musl-x86_64.so.1',
  functions: {
    open: { symbol: 'opendir', result: 'pointer', parameters: ['cstring'] },
    next: { symbol: 'readdir', result: 'pointer', parameters: ['pointer'] },
    close: { symbol: 'closedir', result: 'i32', parameters: ['pointer'] },
    write: { symbol: 'write', result: 'ssize', parameters: ['i32', 'pointer', 'size'] },
  },
});
export function descriptorCount() {
  const directory = system.call('open', '/proc/self/fd').value;
  check(directory !== null, 'Open descriptor inventory');
  let count = 0;
  try {
    for (;;) {
      const entry = system.call('next', directory).value;
      if (entry === null) return count;
      entry.close(); count++;
    }
  } finally {
    check(system.call('close', directory).value === 0, 'Close descriptor inventory');
    directory.close();
  }
}
export function print(text) {
  const bytes = encodeUtf8(text + '\n'), buffer = alloc(bytes.length);
  try {
    buffer.write(bytes.buffer);
    check(Number(system.call('write', 1, buffer, bytes.length).value) === bytes.length, 'Fixture progress write');
  } finally { buffer.close(); }
}
export async function pause() {
  check((await wait.async.poll(null, 0, 2)).value === 0, 'Application loop yields between polls');
}
export async function result(ticket) {
  const deadline = monotonicNanoseconds() + 10000000000n;
  for (;;) {
    const outcome = ticket.poll();
    if (outcome.state !== 'pending') return outcome;
    check(monotonicNanoseconds() < deadline, 'Private IPC deadline');
    await pause();
  }
}
export function dispose() { system.close(); wait.dispose(); closeClock(); }
