import { requireFileSystem } from './desktop/files/model.mjs';

const [mode, runtime, ownScript] = application.arguments;
if (mode !== 'initial' || typeof runtime !== 'string' || !runtime.startsWith('/') ||
    typeof ownScript !== 'string' || !ownScript.endsWith('/files-window-shell.mjs'))
  throw new Error('Trusted Files fixture supervisor requires initial, absolute rebuilt runtime and its own script');
const api = requireFileSystem(desktop), root = api.locations().home;
if (!root.startsWith('/tmp/polly-files-window-') || root.slice('/tmp/'.length).includes('/'))
  throw new Error('Files fixture supervisor requires an explicit private fixture HOME');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const exits = new Map();
desktop.onExit = result => exits.set(result.pid, result.status);
async function until(predicate, description) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(20);
  }
  throw new Error('Files fixture supervisor timed out: ' + description);
}
async function run() {
  const client = ownScript.slice(0, -'files-window-shell.mjs'.length) + 'files-window-client.mjs';
  const pid = desktop.spawnApplication([runtime, '--desktop', '--app-id', 'org.pollyui.files-window-fixture',
    client, root, '--drive'], '', 'ordinary Files native pointer fixture');
  await until(() => exits.has(pid), 'ordinary Files child exit');
  if (exits.get(pid) !== 0) throw new Error('Ordinary Files fixture exited ' + exits.get(pid));
  const entry = api.stat(root + '/files-window-result.json', false);
  const receipt = JSON.parse(api.readText(entry.path, entry.identity).text);
  if (receipt.version !== 1 || receipt.native !== true || receipt.root !== root || receipt.passed !== true ||
      receipt.closeObserved !== true || receipt.appId !== 'org.pollyui.files-window-fixture' ||
      receipt.renamedName !== 'New folde' ||
      ['documents', 'returnedHome', 'folderCreated', 'folderRenamed', 'documentOpenRequested',
        'cancelled', 'wheel', 'keyboardRename', 'history'].some(key => receipt.evidence?.[key] !== true) ||
      api.stat(root + '/' + receipt.renamedName, false).type !== 'directory')
    throw new Error('Actual ordinary Files action/close/filesystem receipt is incomplete');
  console.log('FILES_WINDOW_SUPERVISOR_PASS: normal ordinary child exit and exact actual UI/close receipt');
  const marker = window.create({ title: 'fixture-success', layer: 'overlay', width: 1, height: 1,
    anchors: ['top', 'right'], exclusiveZone: -1 });
  let ack = false;
  marker.onclose = () => { ack = true; };
  await until(() => ack, 'trusted completion marker ACK');
  window.quit();
}
run().catch(error => {
  console.error('FILES_WINDOW_SUPERVISOR_FAIL: ' + error); window.quit();
});
