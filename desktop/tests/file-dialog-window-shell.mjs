const [mode, runtime, script] = application.arguments;
if (mode !== 'file-dialog' || typeof script !== 'string' || !script.endsWith('/file-dialog-window-shell.mjs'))
  throw new Error('Use the source-owned runtime-client file-dialog selector with this absolute Shell entry');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const exits = new Map();
desktop.onExit = event => exits.set(event.pid, event.status);
async function run() {
  const fixture = script.replace(/file-dialog-window-shell\.mjs$/, 'file-dialog-native-fixture.mjs');
  const pid = desktop.spawnApplication(['/usr/bin/node', fixture, runtime, application.cacheDir, '--window-input'],
    '', 'private ordinary file dialog native input fixture');
  const end = Date.now() + 80000;
  while (!exits.has(pid)) {
    if (Date.now() > end) throw new Error('Native chooser fixture process did not exit');
    await wait(20);
  }
  if (exits.get(pid) !== 0) throw new Error('Native chooser fixture failed: ' + exits.get(pid));
  console.log('PASS: independent UID1000 chooser runner verified real file content, input receipt and PNGs');
  const signal = window.create({ title: 'fixture-success', layer: 'overlay', width: 1, height: 1,
    anchors: ['top', 'right'], exclusiveZone: -1 });
  let acknowledged = false;
  signal.onclose = () => { acknowledged = true; };
  while (!acknowledged) {
    if (Date.now() > end) throw new Error('Native harness did not acknowledge fixture success');
    await wait(20);
  }
  window.quit();
}
run().catch(error => {
  console.error('FILE_DIALOG_INPUT_SUPERVISOR_FAIL: ' + String(error) + '\n' + (error.stack || ''));
  window.quit();
});
