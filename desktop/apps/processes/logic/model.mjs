const unsigned = value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
function number(value, label) {
  if (!unsigned(value) || !Number.isSafeInteger(Number(value))) throw new Error('Invalid /proc ' + label);
  return Number(value);
}
export function parseProcessStat(text, expectedPid) {
  const first = text.indexOf(' ('), last = text.lastIndexOf(') ');
  if (first < 1 || last <= first || number(text.slice(0, first), 'PID') !== expectedPid)
    throw new Error('Invalid /proc process identity');
  const values = text.slice(last + 2).trim().split(/\s+/);
  if (values.length < 22 || !/^[RSDZTtXxKWPI]$/.test(values[0]))
    throw new Error('Invalid /proc process state');
  const name = text.slice(first + 2, last).replace(/[\x00-\x1f\x7f]/g, '?');
  if (!name || name.length > 256) throw new Error('Invalid /proc process name');
  for (const index of [11, 12, 19])
    if (!unsigned(values[index])) throw new Error('Invalid /proc process counters');
  return { pid: expectedPid, name, state: values[0], start: values[19],
    ticks: BigInt(values[11]) + BigInt(values[12]) };
}
export function parseCpuTicks(text) {
  const line = text.split('\n')[0], fields = line.trim().split(/\s+/);
  if (fields[0] !== 'cpu' || fields.length < 9 || fields.slice(1, 9).some(value => !unsigned(value)))
    throw new Error('Invalid /proc aggregate CPU counters');
  // guest/guest_nice are already included in user/nice.
  return fields.slice(1, 9).reduce((sum, value) => sum + BigInt(value), 0n);
}
export function parseResidentBytes(text) {
  const line = text.split('\n').find(line => line.startsWith('VmRSS:'));
  if (line === undefined) return null;
  const match = /^VmRSS:\s+([0-9]+)\s+kB$/.exec(line);
  if (!match) throw new Error('Invalid /proc resident memory');
  const value = number(match[1].replace(/^0+(?=\d)/, ''), 'resident memory') * 1024;
  if (!Number.isSafeInteger(value)) throw new Error('Resident memory exceeds the supported integer range');
  return value;
}
export function processRows(snapshot, previous = null) {
  if (!snapshot || typeof snapshot.totalTicks !== 'bigint' || snapshot.totalTicks < 0n ||
      !Array.isArray(snapshot.processes) || snapshot.processes.length > 4096 ||
      typeof snapshot.complete !== 'boolean' || !Number.isSafeInteger(snapshot.skipped) || snapshot.skipped < 0)
    throw new Error('Invalid process snapshot');
  const delta = previous ? snapshot.totalTicks - previous.totalTicks : 0n;
  const old = new Map(previous?.processes.map(item => [item.pid + ':' + item.start, item]) || []), seen = new Set();
  return snapshot.processes.map(item => {
    if (!Number.isInteger(item.pid) || item.pid <= 0 || seen.has(item.pid) ||
        typeof item.name !== 'string' || !item.name || item.name.length > 256 ||
        !/^[RSDZTtXxKWPI]$/.test(item.state) || !unsigned(item.start) ||
        typeof item.ticks !== 'bigint' || item.ticks < 0n ||
        (item.memoryBytes !== null && (!Number.isSafeInteger(item.memoryBytes) || item.memoryBytes < 0)))
      throw new Error('Invalid process observation');
    seen.add(item.pid);
    const before = old.get(item.pid + ':' + item.start), ticks = before ? item.ticks - before.ticks : -1n;
    return Object.freeze({ ...item, identity: item.pid + ':' + item.start,
      cpuPercent: delta > 0n && ticks >= 0n ? Number(ticks * 10000n / delta) / 100 : null });
  });
}
export function sortedProcesses(state) {
  const { key, direction } = state.sort;
  return [...state.rows].sort((a, b) => {
    const left = a[key], right = b[key];
    if (left === null || right === null) return left === right ? a.pid - b.pid : left === null ? 1 : -1;
    const result = typeof left === 'string' ? left.localeCompare(right) : left - right;
    return result * direction || a.pid - b.pid;
  });
}
export const PROCESS_STATES = Object.freeze({ R: 'Running', S: 'Sleeping', D: 'Disk wait', Z: 'Zombie',
  T: 'Stopped', t: 'Tracing stop', X: 'Dead', x: 'Dead', K: 'Wakekill', W: 'Waking', P: 'Parked', I: 'Idle' });
