import { createProcessProvider } from './desktop/apps/processes/logic/native-provider.mjs';
import { processRows } from './desktop/apps/processes/logic/model.mjs';
import { loadBindings } from './sysrt/sdk/js/native.mjs';
import { libc } from 'sysrt:ffi';

function check(value, message) { if (!value) throw new Error(message); }
const native = loadBindings({ library: libc === 'glibc' ? 'libc.so.6' : 'libc.musl-x86_64.so.1',
  functions: { pause: { symbol: 'usleep', result: 'i32', parameters: ['u32'] } } });
try {
  const provider = createProcessProvider(), first = provider.snapshot();
  const childPid = Number(processChild);
  const child = first.processes.find(item => item.pid === childPid);
  check(child && child.memoryBytes > 0 && child.name.includes('python'), 'Actual owned Python fixture process RSS/name');
  check(first.processes.some(item => item.pid === expectedProcessId), 'Actual QuickJS process is visible');
  check(processRows(first).every(item => item.cpuPercent === null), 'First sample has no invented CPU');
  check(native.call('pause', 120000).value === 0, 'Bounded sample interval');
  const second = provider.snapshot(), rows = processRows(second, first);
  const updated = rows.find(item => item.pid === childPid);
  check(updated && updated.start === child.start && updated.ticks >= child.ticks &&
    updated.cpuPercent !== null && second.totalTicks > first.totalTicks, 'Actual sampled CPU counters and stable PID identity');
  check(provider.terminate === undefined && provider.kill === undefined, 'Monitor-only provider');
} finally { native.close(); }
