import { alloc } from 'sysrt:ffi';
import { fileConstants as C } from './sysrt/bindings/files.mjs';
import { call, usingFD } from './desktop/shared/native-files.mjs';
import { createProcessProvider } from './desktop/apps/processes/logic/native-provider.mjs';
import { processRows } from './desktop/apps/processes/logic/model.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
function descriptors() {
  return usingFD(Number(call('open', C.currentDirectory, '/proc/self/fd',
    C.readOnly | C.directory | C.noFollow | C.closeOnExec, 0)), fd => {
    const buffer = alloc(32768);
    let count = 0;
    try {
      for (;;) {
        const size = Number(call('entries', fd, buffer, 32768));
        if (!size) return count;
        const bytes = new Uint8Array(buffer.read(size)), view = new DataView(bytes.buffer);
        for (let at = 0; at < size;) {
          const length = view.getUint16(at + 16, true);
          check(length >= 20 && length <= size - at, 'Valid descriptor directory record');
          at += length; count++;
        }
      }
    } finally { buffer.close(); }
  });
}
const provider = createProcessProvider(), expectedDescriptors = descriptors();
let heartbeats = 0, previous = Date.now();
const gaps = [];
const heartbeat = setInterval(() => {
  const current = Date.now(); gaps.push(current - previous); previous = current; heartbeats++;
}, 1);
let snapshot;
try {
  snapshot = await provider.snapshotAsync();
  check(snapshot.processes.length > 0 && processRows(snapshot).every(item => item.cpuPercent === null),
    'Cooperative sampling returns actual validated observations');
  if (snapshot.processes.length + snapshot.skipped >= 8)
    check(heartbeats > 0, 'The event loop runs between bounded process batches');
} finally { clearInterval(heartbeat); }
check(descriptors() === expectedDescriptors, 'Completed cooperative sample releases every descriptor');
let cancelled = 0;
if (snapshot.processes.length + snapshot.skipped >= 8) {
  for (let i = 0; i < 16; i++) {
    let checks = 0;
    try { await provider.snapshotAsync(() => ++checks <= 9); }
    catch (error) {
      check(error.code === 'ECANCELED', 'Cancellation is explicit');
      cancelled++;
    }
    check(descriptors() === expectedDescriptors, 'Cancelled batch releases root, PID and file descriptors');
  }
  check(cancelled === 16, 'Every cancelled scope stops before publishing a snapshot');
}
console.log('PROCESS_COOPERATIVE_NATIVE ' + JSON.stringify({
  processes: snapshot.processes.length, heartbeats, cancelled, descriptors: expectedDescriptors,
  maximumHeartbeatGapMs: Math.max(0, ...gaps),
}));
console.log('PASS: actual cooperative /proc sampling, event-loop progress, cancellation and descriptor cleanup');
