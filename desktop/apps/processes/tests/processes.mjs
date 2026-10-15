import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register } from 'node:module';
register('../../../tests/root-loader.mjs', import.meta.url);
const { parseProcessStat, parseCpuTicks, parseResidentBytes, processRows, sortedProcesses } =
  await import('../logic/model.mjs');
const { createProcessController } = await import('../logic/controller.mjs');
const { createProcessesApp } = await import('../app.mjs');
const { fixedRowWindow } = await import('./gui/sdk/js/virtual-list.mjs');
const { applicationHost, deliver } = await import('./desktop/tests/application-host.mjs');
const item = (pid = 42, start = '100', ticks = 20n) =>
  ({ pid, start, ticks, name: 'fixture', state: 'S', memoryBytes: 8192 });
const sample = (processes, totalTicks = 1000n) => ({ processes, totalTicks, complete: true, skipped: 0 });
function processHost(t) {
  const host = applicationHost(t), frames = new Set();
  const previous = { requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame };
  globalThis.requestAnimationFrame = callback => {
    const id = setImmediate(() => { frames.delete(id); callback(Date.now()); });
    frames.add(id); return id;
  };
  globalThis.cancelAnimationFrame = id => { clearImmediate(id); frames.delete(id); };
  t.after(() => {
    for (const surface of host.windows) surface.close();
    for (const id of frames) clearImmediate(id);
    Object.assign(globalThis, previous);
  });
  return host;
}
const settleFrames = async () => {
  for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
};

test('shared fixed-row ranges retain SDK overscan and clamp without dropping observations', () => {
  for (const count of [0, 1, 64, 4096]) for (const height of [0, 1, 42, 436, 640]) {
    for (const scroll of [-10, 0, 120, count * 42 + 100]) {
      const range = fixedRowWindow(count, 42, height, scroll);
      assert.equal(range.total, count * 42);
      assert.equal(range.maximum, Math.max(0, count * 42 - height));
      assert.ok(range.offset >= 0 && range.offset <= range.maximum);
      assert.ok(range.start >= 0 && range.end <= count);
      assert.ok(range.end - range.start <= Math.ceil(height / 42) + 5);
      assert.equal(range.start, Math.max(0, Math.floor(range.offset / 42) - 2));
      assert.equal(range.end, Math.min(count, Math.ceil((range.offset + height) / 42) + 2));
    }
  }
});

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
test('UI sampling prefers cooperative reads and closes their publication scope', async () => {
  let resolve, active, syncCalls = 0;
  const controller = createProcessController({ provider: {
    snapshot() { syncCalls++; throw new Error('Synchronous sampling must not run in the UI'); },
    snapshotAsync(scope) { active = scope; return new Promise(done => { resolve = done; }); },
  } });
  const pending = controller.refresh();
  assert.equal(active(), true);
  controller.close();
  assert.equal(active(), false);
  resolve(sample([item()]));
  assert.equal(await pending, false);
  assert.equal(syncCalls, 0);
  assert.equal(controller.getState().rows.length, 0);
});
test('ordinary Processes window renders observed rows, refreshes/sorts by real controls and never offers an End action', async t => {
  const host = processHost(t); let calls = 0;
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
test('4096 observations keep bounded DOM rows, reach either end and retain scroll through errors', async t => {
  const host = processHost(t); let next = sample(Array.from({ length: 4096 }, (_, i) =>
    ({ ...item(i + 1), memoryBytes: (i + 1) * 4096 })));
  const app = createProcessesApp({ host, native: null, report() {},
    provider: { snapshot() { if (next instanceof Error) throw next; return next; } } }).start();
  t.after(() => app.stop());
  await settleFrames();
  const document = app.getWindow().document;
  const list = document.getElementById('processes-list');
  const visible = () => list.childNodes.filter(node => node.getAttribute('role') === 'row');
  assert.equal(app.controller.getState().rows.length, 4096);
  assert.equal(list.getAttribute('aria-rowcount'), '4096');
  assert.ok(visible().length <= Math.ceil(list.offsetHeight / 42) + 5);
  assert.ok(document.getElementById('processes-pid-4096'));
  assert.equal(document.getElementById('processes-pid-1'), null);
  await deliver(list, 'wheel', { deltaY: 1e6 });
  assert.ok(document.getElementById('processes-pid-1'));
  assert.ok(visible().length <= Math.ceil(list.offsetHeight / 42) + 5);
  const end = list.scrollTop;
  next = new Error('EACCES: retained sample');
  await app.controller.refresh(); await settleFrames();
  assert.strictEqual(document.getElementById('processes-list'), list);
  assert.equal(list.scrollTop, end);
  assert.match(document.getElementById('processes-error').textContent, /retained sample.*stale/);
  next = sample([item(9), item(10)], 2000n);
  await app.controller.refresh(); await settleFrames();
  assert.strictEqual(document.getElementById('processes-list'), list);
  assert.equal(list.scrollTop, 0);
  assert.equal(list.getAttribute('aria-rowcount'), '2');
  assert.equal(visible().length, 2);
  await deliver(document.getElementById('processes-sort-pid'));
  assert.equal(visible()[0].id, 'processes-pid-9');
});
test('viewport updates are bounded and closing cancels deferred measurement', async t => {
  const host = processHost(t);
  const app = createProcessesApp({ host, native: null, provider: { snapshot: () =>
    sample(Array.from({ length: 100 }, (_, i) => item(i + 1))) } }).start();
  await settleFrames();
  const list = app.getWindow().document.getElementById('processes-list');
  list.offsetHeight = 126;
  app.controller.sortBy('pid');
  await settleFrames();
  const visible = list.childNodes.filter(node => node.getAttribute('role') === 'row');
  assert.ok(visible.length <= 8);
  app.controller.sortBy('pid');
  app.stop(); await settleFrames();
  assert.equal(app.getWindow().closed, true);
});
