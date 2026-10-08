import { requireFileSystem, childPath, fileEntry } from './desktop/files/model.mjs';
import { createFileTextApp } from './desktop/client/file-dialog-example.mjs';
import { requestPrivateMutation } from './desktop/tests/file-dialog-mutation.mjs';

const [directory, evidence] = application.arguments;
const files = requireFileSystem(typeof desktop === 'undefined' ? null : desktop);
for (const name of ['locations', 'listDirectory', 'stat', 'readText', 'observeText', 'writeText', 'replaceText'])
  if (!Function.prototype.toString.call(files[name]).includes('[native code]'))
    throw new Error('New compiled ordinary-user filesystem required; old binary/JS stub rejected: ' + name);
const parent = files.stat(directory, false);
const marker = files.stat(childPath(directory, 'fixture-marker.txt'), false);
if (parent.uid !== 1000 || files.readText(marker.path, marker.identity).text !== 'POLLYUI_FILE_DIALOG_PRIVATE_V1')
  throw new Error('Only the private UID1000 fixture directory is permitted');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const existing = childPath(directory, 'hello space "quoted" \u6587.txt');
let app;
function check(value, message) {
  if (!value) throw new Error(message);
  console.log('PASS FILE DIALOG NATIVE: ' + message);
}
async function until(predicate, message) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(10);
  }
  throw new Error('Timed out: ' + message);
}
async function dialogReady(operation) {
  await until(() => app.getDialog()?.controller.getState().phase === 'ready', operation + ' real listing');
  return app.getDialog();
}
async function capture(name) {
  await wait(100);
  app.getWindow().capture(childPath(evidence, name + '.png'));
}
async function run() {
  app = createFileTextApp({ files, initialDirectory: directory, suggestedName: 'hello space "quoted" \u6587.txt' }).start();
  let operation = app.open(), dialog = await dialogReady('cancel');
  check(dialog.controller.getState().selection === null, 'real native listing has no selected default');
  await capture('01-open-list');
  dialog.controller.cancel(); await operation;
  check(!app.getState().lastPath, 'open cancellation did not read or fabricate a path');
  operation = app.open(); dialog = await dialogReady('read');
  dialog.controller.select(existing); await dialog.controller.openSelection(); await operation;
  check(app.getState().contents === 'Native private input.\nUnicode \u6587 and quoted filename.', 'consumer actually read selected native text');
  await capture('02-read-content');
  operation = app.save(); dialog = await dialogReady('new save');
  dialog.controller.setName('new space "quoted" \u6587.txt'); await dialog.controller.saveSelection(); await operation;
  check(app.getState().saved?.path === childPath(directory, 'new space "quoted" \u6587.txt'),
    'new save actually wrote the qualified native target');
  check(app.getState().contents === 'PollyUI saved text', 'new native save readback equals consumer text');
  await capture('03-new-save-readback');
  operation = app.save(); dialog = await dialogReady('keep existing');
  dialog.controller.setName('hello space "quoted" \u6587.txt'); await dialog.controller.saveSelection();
  check(dialog.controller.getState().phase === 'overwrite', 'existing native target displays explicit confirmation');
  await capture('04-overwrite-question');
  dialog.controller.cancel(); await operation;
  let actual = files.stat(existing, false);
  check(files.readText(existing, actual.identity).text.startsWith('Native private input.'), 'cancel kept existing native content');
  operation = app.save(); dialog = await dialogReady('changed confirmation');
  dialog.controller.setName('hello space "quoted" \u6587.txt'); await dialog.controller.saveSelection();
  const old = dialog.controller.getState().confirmation;
  const observedParent = files.stat(directory, false);
  // A separate real native write simulates a cooperating external editor.
  actual = fileEntry(files.replaceText(existing, 'External change requiring fresh consent.',
    old.target.identity, observedParent.identity));
  await dialog.controller.confirmOverwrite();
  check(dialog.controller.getState().phase === 'overwrite' &&
    dialog.controller.getState().confirmation.target.identity === files.observeText(existing).identity,
  'changed native file was freshly observed, not replaced by the stale confirmation');
  check(files.readText(existing, actual.identity).text === 'External change requiring fresh consent.',
    'first confirmation did not overwrite changed content');
  await capture('05-changed-reconfirm');
  await dialog.controller.confirmOverwrite(); await operation;
  check(app.getState().contents === 'PollyUI saved text' && app.getState().saved?.path === existing,
    'second explicit confirmation actually replaced and read back existing native text');
  await capture('06-replace-readback');
  operation = app.save(); dialog = await dialogReady('in-place content change');
  dialog.controller.setName('eight.txt'); await dialog.controller.saveSelection();
  const before = dialog.controller.getState().confirmation.target;
  check(before.bytes === 8, 'private in-place case starts with eight real bytes');
  await requestPrivateMutation(files, directory, evidence);
  await dialog.controller.confirmOverwrite();
  const after = dialog.controller.getState().confirmation.target;
  check(dialog.controller.getState().phase === 'overwrite' && after.identity !== before.identity,
    'actual in-place content change requires a fresh strong observation and another confirmation');
  console.log('FILE_DIALOG_NATIVE_METADATA_MATCH: ' + String(before.metadataIdentity === after.metadataIdentity));
  check(files.readText(after.path, after.identity).text === 'external', 'strong native read proves first confirmation preserved changed content');
  await capture('07-in-place-reconfirm');
  await dialog.controller.confirmOverwrite(); await operation;
  check(app.getState().saved?.path === childPath(directory, 'eight.txt') && app.getState().contents === 'PollyUI saved text',
    'second explicit confirmation saved and read back the in-place changed document');
  operation = app.open(); dialog = await dialogReady('parent close');
  app.getWindow().close(); await operation;
  check(app.getState().closed, 'parent close disposed its chooser without late resurrection');
  console.log('FILE_DIALOG_NATIVE_PASS: real filesystem/controller/consumer/screenshots; pointer-keyboard acceptance separate');
}
run().catch(error => {
  console.error('FILE_DIALOG_NATIVE_FAIL: ' + String(error) + '\n' + (error.stack || ''));
  app?.stop(); window.quit();
});
