import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register } from 'node:module';
register('../../../tests/root-loader.mjs', import.meta.url);
const { parseProcessStat, parseCpuTicks, parseResidentBytes, processRows, sortedProcesses } =
  await import('../logic/model.mjs');
const { createProcessController } = await import('../logic/controller.mjs');
const { createProcessesApp } = await import('../app.mjs');
const { applicationHost, deliver } = await import('./desktop/tests/application-host.mjs');
const item = (pid = 42, start = '100', ticks = 20n) =>
  ({ pid, start, ticks, name: 'fixture', state: 'S', memoryBytes: 8192 });
const sample = (processes, totalTicks = 1000n) => ({ processes, totalTicks, complete: true, skipped: 0 });

test('real proc stat field positions handle spaces/parentheses, CPU excludes guest double-count, RSS is exact bytes', () => {
  const fields = Array(50).fill('0'); fields[0] = 'S'; fields[11] = '17'; fields[12] = '3'; fields[19] = '999';
  assert.deepEqual(parseProcessStat('42 (a tricky ) process) ' + fields.join(' '), 42),
    { pid: 42, name: 'a tricky ) process', state: 'S', start: '999', ticks: 20n });
  assert.equal(parseCpuTicks('cpu  1 2 3 4 5 6 7 8 9 10\ncpu0 1\n'), 36n);
  assert.equal(parseResidentBytes('Name:\tfixture\nVmRSS:\t123 kB\n'), 125952);
  assert.equal(parseResidentBytes('Name:\tzombie\n'), null);
  assert.throws(() => parseProcessStat('43 (wrong) ' + fields.join(' '), 42));
  assert.throws(() => parseCpuTicks('cpu 1 2 nope'));
  assert.throws(() => parseResidentBytes('VmRSS:\tbad kB'));
});
test('CPU samples bind PID and start time, distinguish unavailable from zero, sort nulls last', () => {
  const before = sample([item()]);
  assert.equal(processRows(before)[0].cpuPercent, null);
  assert.equal(processRows(sample([item(42, '100', 22n)], 1100n), before)[0].cpuPercent, 2);
  assert.equal(processRows(sample([item(42, '100', 20n)], 1100n), before)[0].cpuPercent, 0);
  assert.equal(processRows(sample([item(42, '101', 1n)], 1100n), before)[0].cpuPercent, null);
  assert.equal(processRows(sample([item()], 999n), before)[0].cpuPercent, null);
  const rows = [{ ...item(1), cpuPercent: null }, { ...item(2), cpuPercent: 0 }, { ...item(3), cpuPercent: 5 }];
  assert.deepEqual(sortedProcesses({ rows, sort: { key: 'cpuPercent', direction: -1 } }).map(row => row.pid), [3, 2, 1]);
  assert.throws(() => processRows(sample([item(), item()])));
});
test('refresh/sort/failed-state and close are bounded, no process mutation API is exposed', async () => {
  let next = sample([item(7), { ...item(8), memoryBytes: 16384 }]), calls = 0;
  const reports = [];
  const controller = createProcessController({ provider: { snapshot() { calls++; if (next instanceof Error) throw next; return next; } },
    report: value => reports.push(value) });
  await controller.refresh(); controller.sortBy('pid');
  assert.deepEqual(sortedProcesses(controller.getState()).map(row => row.pid), [7, 8]);
  controller.sortBy('pid');
  assert.deepEqual(sortedProcesses(controller.getState()).map(row => row.pid), [8, 7]);
  next = new Error('EACCES: proc unavailable'); await controller.refresh();
  assert.match(controller.getState().error, /EACCES/); assert.equal(reports.length, 1);
  assert.equal(controller.getState().rows.length, 2);
  assert.equal(controller.terminate, undefined); assert.equal(controller.kill, undefined);
  controller.close(); await controller.refresh(); assert.equal(calls, 2);
});
test('a late process snapshot cannot publish after close', async () => {
  let resolve;
  const controller = createProcessController({ provider: { snapshot: () => new Promise(done => { resolve = done; }) } });
  const pending = controller.refresh(); controller.close(); resolve(sample([item()]));
  assert.equal(await pending, false); assert.equal(controller.getState().rows.length, 0);
});
test('ordinary Processes window renders observed rows, refreshes/sorts by real controls and never offers an End action', async t => {
  const host = applicationHost(t); let calls = 0;
  const app = createProcessesApp({ host, native: null, provider: { snapshot() {
    calls++; return sample([{ ...item(42), name: 'owned-fixture' }, { ...item(7), memoryBytes: null }], BigInt(calls * 1000));
  } } }).start();
  t.after(() => app.stop());
  await new Promise(resolve => setImmediate(resolve));
  const document = app.getWindow().document, find = id => document.getElementById(id);
  assert.equal(host.windows.length, 1); assert.equal(host.windows[0].layer, undefined);
  assert.match(find('processes-pid-42').textContent, /owned-fixture.*42.*Sleeping.*8\.0 KiB.*Unavailable/);
  assert.match(document.body.textContent, /Read-only monitor/);
  assert.equal(find('processes-end'), null);
  await deliver(find('processes-sort-pid'));
  assert.equal(app.controller.getState().sort.key, 'pid');
  await deliver(find('processes-refresh'));
  assert.equal(calls, 2); assert.match(find('processes-pid-42').textContent, /0\.0%/);
  app.stop(); assert.equal(host.windows[0].closed, true);
});
