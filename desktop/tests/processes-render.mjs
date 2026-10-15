import { createProcessesApp } from './desktop/apps/processes/app.mjs';

const check = (value, message) => { if (!value) throw new Error(message); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const settle = () => { host.render(); host.render(); host.render(); host.render(); };

// Headless input helpers drain timers, so the persistent sampler uses a controlled clock here.
export async function checkProcessesTable(directory) {
  check(host.width === 900 && host.height === 640, '900x640 actual Processes fixture');
  let calls = 0, generation = 0, next = 4096, closed = false;
  const snapshot = count => ({
    totalTicks: BigInt(++generation * 100000), complete: true, skipped: 0,
    processes: Array.from({ length: count }, (_, i) => ({
      pid: i + 1, name: 'worker-' + (i + 1), state: 'S', start: String(1000 + i),
      ticks: BigInt(generation + i), memoryBytes: 4096 * (i + 1),
    })),
  });
  const surface = { document, get closed() { return closed; },
    close() { if (!closed) { closed = true; this.onclose?.(); } } };
  const interval = globalThis.setInterval, clear = globalThis.clearInterval, clock = {};
  let periodic = null;
  globalThis.setInterval = (callback, ms) => {
    check(ms === 2000 && periodic === null, 'One unchanged two-second sampler registration');
    periodic = callback; return clock;
  };
  globalThis.clearInterval = id => { if (id === clock) periodic = null; else clear(id); };
  const app = createProcessesApp({
    host: { create: () => surface, close() {} }, native: null, report() {},
    provider: { snapshot() { calls++; if (next instanceof Error) throw next;
      return typeof next === 'number' ? snapshot(next) : next; } },
  }).start();
  const get = id => document.getElementById(id);
  const visible = list => list.childNodes.filter(node => node.getAttribute('role') === 'row');
  const bounded = () => {
    const list = get('processes-list'), rows = visible(list);
    check(rows.length <= Math.ceil(list.offsetHeight / 42) + 5, 'Live DOM is viewport-bounded, not snapshot-bounded');
    return { viewport: [list.offsetWidth, list.offsetHeight], rows: rows.length,
      observations: app.controller.getState().rows.length, scroll: Number(list.scrollTop) };
  };
  const wheel = value => {
    const list = get('processes-list'), box = list.getBoundingClientRect();
    host.scroll(box.x + box.width / 2, box.y + box.height / 2, value); settle();
  };
  const click = node => {
    const box = node.getBoundingClientRect(), x = box.x + box.width / 2, y = box.y + box.height / 2;
    host.mouse('mousemove', x, y); host.mouse('mousedown', x, y);
    host.mouse('mouseup', x, y); host.mouse('click', x, y); settle();
  };
  try {
    await delay(25); settle();
    const list = get('processes-list'), initial = bounded();
    check(initial.observations === 4096 && list.getAttribute('aria-rowcount') === '4096',
      'All 4096 observed processes remain in the model and table semantics');
    check(get('processes-pid-4096') && !get('processes-pid-1'), 'Memory sort starts with the highest resident observation');
    check(host.save(directory + '\\processes-initial.png'), 'Save initial actual virtual table');
    click(get('processes-sort-pid'));
    check(app.controller.getState().sort.key === 'pid' && get('processes-pid-1'),
      'Actual sort control reveals the ascending PID window');
    wheel(1e6);
    const last = get('processes-pid-4096'), end = bounded(), box = last?.getBoundingClientRect();
    const viewport = list.getBoundingClientRect();
    check(last && box.y >= viewport.y && box.y + box.height <= viewport.y + viewport.height,
      'Actual wheel reaches the complete last process rather than truncating observations');
    check(last.getAttribute('aria-rowindex') === '4096', 'Visible row retains its full sorted index');
    check(host.save(directory + '\\processes-last.png'), 'Save final real scroll position');
    wheel(-1e6);
    check(Number(list.scrollTop) === 0 && get('processes-pid-1'), 'Actual reverse wheel returns to the first observation');
    let resolve;
    next = new Promise(done => { resolve = done; });
    const before = calls;
    click(get('processes-refresh'));
    check(calls === before + 1 && get('processes-refresh').getAttribute('aria-disabled') === 'true',
      'Refresh issues one request and disables itself while waiting');
    click(get('processes-refresh'));
    check(calls === before + 1, 'Loading refresh cannot overlap the pending snapshot');
    resolve(snapshot(17)); await delay(25); settle();
    check(bounded().observations === 17 && get('processes-refresh').getAttribute('aria-disabled') === 'false',
      'Pending snapshot updates visible rows and restores refresh');
    wheel(1e6);
    const remembered = Number(list.scrollTop);
    next = new Error('EACCES: controlled sample failure');
    get('processes-refresh').focus();
    host.key('F5', 'keydown', { text: false }); await delay(25); settle();
    check(get('processes-list') === list && Number(list.scrollTop) === remembered &&
      app.controller.getState().rows.length === 17, 'Failed sample retains the actual viewport, sort and data');
    check(get('processes-error').textContent.includes('stale'), 'Failure is explicitly labelled, never an empty success');
    next = 2;
    get('processes-refresh').focus();
    host.key('F5', 'keydown', { text: false }); await delay(25); settle();
    check(get('processes-list') === list && Number(list.scrollTop) === 0 &&
      bounded().observations === 2, 'Shorter successful snapshot clamps old scroll without replacing the list');
    check(get('processes-end') === null, 'Performance work does not add process mutation capabilities');
    check(host.save(directory + '\\processes-short.png'), 'Save clamped short table');
    const timerCalls = calls;
    await periodic(); settle();
    check(calls === timerCalls + 1, 'The registered periodic sampler still refreshes the model');
    console.log('PROCESSES_ACTUAL_TABLE ' + JSON.stringify({ initial, end, shorter: bounded(), calls }));
    app.stop();
    const stoppedCalls = calls;
    host.key('F5', 'keydown', { text: false }); await delay(25);
    check(closed && periodic === null && calls === stoppedCalls, 'Closing removes keyboard refresh, clock and deferred work');
    console.log('PASS: viewport-bounded Processes data, actual scroll/sort/refresh/F5, errors and close');
  } finally {
    app.stop();
    globalThis.setInterval = interval;
    globalThis.clearInterval = clear;
  }
}

export async function checkNativeProcessesResize() {
  const app = createProcessesApp({ host: window, native: null, provider: { snapshot: () => ({
    totalTicks: 1000n, complete: true, skipped: 0,
    processes: Array.from({ length: 4096 }, (_, i) => ({
      pid: i + 1, name: 'native-' + i, state: 'S', start: String(1000 + i),
      ticks: 0n, memoryBytes: i * 4096,
    })),
  }) } }).start();
  const surface = app.getWindow(), request = globalThis.requestAnimationFrame;
  let frames = 0, business = 0;
  const records = [];
  try {
    await delay(150);
    app.controller.close();
    await delay(80);
    surface.onstatechange = () => business++;
    globalThis.requestAnimationFrame = callback => request(time => { frames++; callback(time); });
    for (const height of [420, 760, 640]) {
      frames = 0;
      ownerTest.resize('Processes', 900, height);
      // Native host resize only: no VNode update or forced render.
      await delay(100);
      const list = surface.document.getElementById('processes-list');
      const rows = list.childNodes.filter(node => node.getAttribute('role') === 'row').length;
      console.log('PROCESSES_NATIVE_RESIZE_STEP ' + JSON.stringify({ height, frames,
        viewport: list.offsetHeight, rows }));
      check(frames === 2 && rows <= Math.ceil(list.offsetHeight / 42) + 5,
        'Native resize remeasures the actual viewport in exactly two bounded frames');
      records.push({ height, viewport: list.offsetHeight, rows, frames });
      await delay(50);
      check(frames === 2, 'No recurring viewport polling after native resize');
    }
    check(business > 0 && app.controller.getState().rows.length === 4096,
      'Independent owner sizing preserves business state callbacks and all observations');
    console.log('PROCESSES_NATIVE_RESIZE ' + JSON.stringify({ records, business }));
    console.log('PASS: native Processes host resize retains bounded rows without VNode updates or polling');
  } finally {
    globalThis.requestAnimationFrame = request;
    app.stop(); window.quit();
  }
}
