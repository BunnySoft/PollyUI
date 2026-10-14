import { alloc, platform } from 'sysrt:ffi';
import { decodeUtf8 } from './sysrt/sdk/js/encoding.mjs';
import { fileConstants as C } from './sysrt/bindings/files.mjs';
import { raw, call, usingFD, failure, errors } from './desktop/shared/native-files.mjs';
import { parseProcessStat, parseCpuTicks, parseResidentBytes } from './desktop/apps/processes/logic/model.mjs';

const MAX = 4096, LIMIT = 65536;
const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
function readAt(directory, path) {
  return usingFD(Number(call('open', directory, path, C.readOnly | C.noFollow | C.nonblock | C.closeOnExec, 0)), fd => {
    const buffer = alloc(LIMIT + 1), data = new Uint8Array(LIMIT + 1);
    try {
      let size = 0;
      for (;;) {
        const view = buffer.slice(size, LIMIT + 1 - size);
        let result;
        try { result = raw('read', fd, view, LIMIT + 1 - size); } finally { view.close(); }
        if (result.value < 0 && result.errno === 4) continue;
        if (result.value < 0) throw failure(errors[result.errno] ?? 'ERR_OS_' + result.errno, 'read process data');
        if (!result.value) break;
        size += Number(result.value);
        if (size > LIMIT) throw failure('EFBIG', 'process data');
      }
      data.set(new Uint8Array(buffer.read(size)));
      return decodeUtf8(data.subarray(0, size));
    } finally { buffer.close(); }
  });
}
function processIds(fd) {
  const result = [], buffer = alloc(32768);
  try {
    for (;;) {
      const length = Number(call('entries', fd, buffer, 32768));
      if (!length) return { ids: result, complete: true };
      const data = new Uint8Array(buffer.read(length)), view = new DataView(data.buffer);
      for (let offset = 0; offset < length;) {
        if (length - offset < 20) throw failure('EIO', 'process directory record');
        const size = view.getUint16(offset + 16, littleEndian);
        if (size < 20 || size % 8 || size > length - offset) throw failure('EIO', 'process directory record');
        const field = data.subarray(offset + 19, offset + size), end = field.indexOf(0);
        if (end < 0) throw failure('EIO', 'process directory name');
        const name = decodeUtf8(field.subarray(0, end));
        offset += size;
        if (!/^[1-9][0-9]*$/.test(name)) continue;
        const pid = Number(name);
        if (!Number.isSafeInteger(pid) || pid > 2147483647) throw failure('EOVERFLOW', 'PID');
        if (result.length === MAX) return { ids: result, complete: false };
        result.push(pid);
      }
    }
  } finally { buffer.close(); }
}
export function createProcessProvider() {
  if (platform !== 'linux') throw new Error('Process monitoring currently requires Linux /proc');
  return Object.freeze({
    snapshot() {
      return usingFD(Number(call('open', C.currentDirectory, '/proc',
        C.readOnly | C.directory | C.noFollow | C.closeOnExec, 0)), root => {
        const { ids, complete } = processIds(root), processes = [];
        let skipped = 0;
        for (const pid of ids) {
          try {
            const item = usingFD(Number(call('open', root, String(pid),
              C.readOnly | C.directory | C.noFollow | C.closeOnExec, 0)), directory => {
              const first = parseProcessStat(readAt(directory, 'stat'), pid);
              const memoryBytes = parseResidentBytes(readAt(directory, 'status'));
              const last = parseProcessStat(readAt(directory, 'stat'), pid);
              if (first.start !== last.start) throw failure('ESTALE', 'process identity');
              return { ...last, memoryBytes };
            });
            processes.push(item);
          } catch (error) {
            if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM', 'ESTALE'].includes(error.code)) throw error;
            skipped++;
          }
        }
        return { processes, totalTicks: parseCpuTicks(readAt(root, 'stat')), complete, skipped };
      });
    },
  });
}
