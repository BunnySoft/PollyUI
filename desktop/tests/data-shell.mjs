const [mode, executable, script] = application.arguments;
const text = 'Native \u4e2d\u6587 \ud83d\ude42';
const primary = 'Primary \u4e2d\u6587';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(value, message) {
  if (!value) throw new Error(message);
  console.log('PASS: ' + message);
}
async function until(predicate, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (predicate()) return; await delay(10); }
  throw new Error('Timed out: ' + message);
}
async function signal(title) {
  const marker = window.create({ title, layer: 'overlay', width: 1, height: 1,
    anchors: ['top', 'right'], exclusiveZone: -1 });
  await until(() => marker.closed, title);
}
async function tap(code) {
  await signal(`fixture-key ${code} 1`);
  await signal(`fixture-key ${code} 0`);
}
function result(name, action) {
  try { action(); window.create({ title: 'Data PASS ' + name, width: 120, height: 80 }); }
  catch (error) {
    console.error('FAIL: ' + String(error));
    window.create({ title: 'Data FAIL ' + name, width: 120, height: 80 });
  }
}
async function run() {
  if (mode === 'peer') {
    const peer = window.create({ title: 'Data receiver', width: 300, height: 180 });
    window.close();
    const body = peer.document.body;
    body.style.backgroundColor = '#204060';
    body.tabIndex = 0; body.focus();
    let stage = 0;
    body.addEventListener('keydown', event => {
      if (event.key !== 'p') return;
      const current = stage++;
      result('read-' + current, () => {
        if (current === 0) check(clipboard.readText() === text, 'cross-process Unicode clipboard');
        if (current === 1) check(clipboard.formats().includes('application/x-polly-test') &&
          Array.from(new Uint8Array(clipboard.read('application/x-polly-test'))).join(',') === '1,0,255,42',
        'cross-process MIME clipboard');
        if (current === 2) check(clipboard.readPrimaryText() === primary &&
          clipboard.formats().includes('application/x-polly-test'), 'independent cross-process primary selection');
        if (current === 3) check(clipboard.readText() === '', 'cross-process empty clipboard text');
      });
    });
    body.addEventListener('drop', event => {
      event.preventDefault();
      result(event.files.length ? 'files' : 'text', () => {
        check(event.target === body && event.currentTarget === body, 'drop routes to the recipient document');
        if (event.files.length) check(JSON.stringify(event.files) ===
          JSON.stringify(['/tmp/polly-one.txt', '/tmp/polly two.txt']), 'Wayland URI list becomes native file paths');
        else check(event.text === 'Dropped \u4e2d\u6587', 'Wayland UTF-8 text drop');
      });
    });
    return;
  }
  if (mode === 'reload') { await signal('fixture-success'); window.quit(); return; }
  const source = window.create({ title: 'Data source', width: 300, height: 180 });
  window.close();
  source.document.body.style.backgroundColor = '#402060';
  source.document.body.tabIndex = 0; source.document.body.focus();
  let writes = 0;
  source.document.body.addEventListener('keydown', event => {
    if (event.key === 't') clipboard.writeText(text);
    else if (event.key === 'b') clipboard.write([{ type: 'application/x-polly-test', data: new Uint8Array([1, 0, 255, 42]) }]);
    else if (event.key === 'q') clipboard.writePrimaryText(primary);
    else if (event.key === 'e') clipboard.writeText('');
    else return;
    writes++;
  });
  const item = title => desktop.windows().find(entry => entry.title === title);
  const exits = new Map();
  desktop.onExit = event => exits.set(event.pid, event.status);
  await until(() => item('Data source')?.active, 'source maps and focuses');
  await tap(20);
  await until(() => writes === 1, 'source offers text');
  const pid = desktop.spawnApplication([executable, '--app-id', 'org.pollyui.data-peer', script, 'peer'], '', 'data-peer');
  await until(() => item('Data receiver')?.active, 'independent public recipient');
  let denied = false;
  try { clipboard.readText(); } catch { denied = true; }
  check(denied, 'background application cannot read clipboard through native API');
  async function expect(name) {
    await until(() => desktop.windows().some(entry => entry.title === 'Data PASS ' + name ||
      entry.title === 'Data FAIL ' + name), name);
    check(!!item('Data PASS ' + name), name);
    desktop.closeWindow(item('Data PASS ' + name).id);
    await until(() => !item('Data PASS ' + name), 'result closes');
  }
  async function focus(title) {
    desktop.activateWindow(item(title).id);
    await until(() => item(title)?.active, title + ' focuses');
    await delay(30);
  }
  await tap(25); await expect('read-0');
  for (const [code, stage] of [[48, 1], [16, 2], [18, 3]]) {
    await focus('Data source');
    await tap(code); await until(() => writes === stage + 1, 'new clipboard offer');
    await focus('Data receiver'); await tap(25); await expect('read-' + stage);
  }
  for (const mode of ['invalid', 'source-less', 'escape', 'source-loss']) {
    await focus('Data source');
    await signal('fixture-data-drag ' + mode);
  }
  for (const mode of ['text', 'files']) {
    await focus('Data source');
    await signal('fixture-data-drag ' + mode);
    await expect(mode);
  }
  desktop.closeWindow(item('Data receiver').id);
  await until(() => exits.has(pid), 'recipient exits');
  check(exits.get(pid) === 0, 'recipient cleans up all native data offers');
  await signal('fixture-success');
  window.quit();
}
run().catch(error => {
  console.error('FAIL: ' + String(error) + '\n' + (error.stack || ''));
  for (const item of desktop.windows()) if (item.appId === 'org.pollyui.data-peer') desktop.closeWindow(item.id);
  window.quit();
});
