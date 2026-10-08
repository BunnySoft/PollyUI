import { requireFileSystem, childPath, fileEntry } from './desktop/files/model.mjs';
import { createFileTextApp } from './desktop/client/file-dialog-example.mjs';
import { requestPrivateMutation } from './desktop/tests/file-dialog-mutation.mjs';

const [directory, evidence] = application.arguments;
const files = requireFileSystem(typeof desktop === 'undefined' ? null : desktop);
for (const name of ['locations', 'listDirectory', 'stat', 'readText', 'observeText', 'writeText', 'replaceText'])
  if (!Function.prototype.toString.call(files[name]).includes('[native code]'))
    throw new Error('Actual newly compiled ordinary filesystem required: ' + name);
const markerFile = files.stat(childPath(directory, 'fixture-marker.txt'), false);
if (markerFile.uid !== 1000 || files.readText(markerFile.path, markerFile.identity).text !== 'POLLYUI_FILE_DIALOG_PRIVATE_V1' ||
    files.locations().home !== directory)
  throw new Error('Private UID1000 fixture directory and matching private HOME required');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const existingName = 'hello space "quoted" \u6587.txt', existing = childPath(directory, existingName);
const newName = 'new space "quoted" \u6587.txt';
let sequence = 0, app, surface, observer;
function check(condition, message) {
  if (!condition) throw new Error(message);
  console.log('PASS FILE DIALOG INPUT: ' + message);
}
async function until(predicate, message) {
  const end = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Timed out: ' + message);
    await wait(10);
  }
}
async function signal(action) {
  const marker = window.create({ title: 'FileDialogFixture.' + (++sequence) + '.' + action, width: 48, height: 32 });
  let acknowledged = false;
  marker.onclose = () => { acknowledged = true; };
  await until(() => acknowledged, 'native marker onclose ACK: ' + action);
}
async function presented() {
  await until(() => surface.document.getElementById('file-text-root')?.offsetWidth > 0, 'ordinary application presentation');
  await wait(60);
}
async function click(id, scroll = null) {
  await presented();
  const node = surface.document.getElementById(id);
  check(node && node.getAttribute('aria-disabled') !== 'true', 'real enabled control: ' + id);
  if (scroll) {
    const rect = node.getBoundingClientRect(), viewport = scroll.getBoundingClientRect();
    if (rect.y < viewport.y || rect.y + rect.height > viewport.y + viewport.height) {
      scroll.scrollTop = Math.max(0, node.offsetTop - scroll.offsetTop - 8);
      await wait(80);
    }
  }
  const rect = node.getBoundingClientRect();
  check(rect.width > 0 && rect.height > 0 && rect.x >= 0 && rect.y >= 0 &&
    rect.x + rect.width <= surface.document.body.offsetWidth &&
    rect.y + rect.height <= surface.document.body.offsetHeight, 'control inside actual viewport: ' + id);
  await signal('click ' + Math.floor(rect.x + rect.width / 2) + ' ' + Math.floor(rect.y + rect.height / 2));
}
async function key(name) {
  if (!['enter', 'escape', 'tab', 'shift-tab'].includes(name)) throw new Error('Unsupported fixture key');
  await signal('key ' + name);
}
async function focusWithTab(id) {
  for (let count = 0; count < 100; count++) {
    if (surface.document.activeElement?.id === id) return;
    await key('tab');
  }
  throw new Error('Actual native Tab never focused ' + id);
}
function choice(dialog, name) {
  const walk = node => [node, ...Array.from(node.childNodes).flatMap(walk)];
  const node = walk(dialog.element).find(item => item.getAttribute?.('aria-label')?.endsWith(name));
  if (!node) throw new Error('Fixture entry not in current real listing: ' + name);
  return node.id;
}
async function ready() {
  await until(() => app.getDialog()?.controller.getState().phase === 'ready', 'real chooser ready');
  return app.getDialog();
}
async function idle() { await until(() => !app.getState().busy, 'real consumer operation finished'); }
async function capture(tag) {
  await presented();
  surface.capture(childPath(evidence, 'input-' + tag + '.png'));
  console.log('FILE_DIALOG_INPUT_CAPTURE: ' + tag + ' (actual application buffer, not composition)');
}
async function run() {
  app = createFileTextApp({ files, initialDirectory: directory, suggestedName: existingName }).start();
  surface = app.getWindow();
  await click('file-text-open'); let dialog = await ready();
  check(!dialog.controller.getState().selection, 'actual open has no implicit file selection');
  const first = surface.document.activeElement?.id;
  await key('tab'); check(surface.document.activeElement?.id !== first, 'ordinary native Tab changes modal focus');
  await key('shift-tab'); check(surface.document.activeElement?.id === first, 'ordinary native Shift+Tab restores focus');
  await capture('open-list');
  await key('escape'); await idle();
  check(!app.getState().lastPath, 'ordinary native Escape cancelled without content read');

  await click('file-text-open'); dialog = await ready();
  await click(choice(dialog, 'Folder \u6587'));
  await click(dialog.id + '-accept');
  await until(() => dialog.controller.getState().directory?.path === childPath(directory, 'Folder \u6587') &&
    dialog.controller.getState().phase === 'ready', 'actual folder navigation');
  const list = surface.document.getElementById(dialog.id + '-list'), bounds = list.getBoundingClientRect();
  await signal('wheel ' + Math.floor(bounds.x + bounds.width / 2) + ' ' +
    Math.floor(bounds.y + bounds.height / 2) + ' 240');
  check(Number(list.scrollTop) > 0, 'ordinary native wheel scrolls the real bounded file list');
  await capture('folder-wheel');
  await click(dialog.id + '-home');
  await until(() => dialog.controller.getState().directory?.path === directory &&
    dialog.controller.getState().phase === 'ready', 'actual private Home navigation');
  await click(choice(dialog, existingName), surface.document.getElementById(dialog.id + '-list'));
  check(dialog.controller.getState().selection?.path === existing, 'ordinary pointer explicitly selected exact Unicode/quoted file');
  await focusWithTab(dialog.id + '-accept'); await key('enter'); await idle();
  check(app.getState().contents === 'Native private input.\nUnicode \u6587 and quoted filename.',
    'ordinary native Enter opened and actually read selected content');
  await capture('read-content');

  await click('file-text-save'); dialog = await ready();
  // Unicode names are explicit fixture data, not fabricated hardware text input.
  dialog.controller.setName(newName);
  await focusWithTab(dialog.id + '-accept'); await key('enter'); await idle();
  check(app.getState().saved?.path === childPath(directory, newName) &&
    app.getState().contents === 'PollyUI saved text', 'ordinary key save wrote new text and actual native readback');
  await capture('new-save');

  await click('file-text-save'); dialog = await ready(); dialog.controller.setName(existingName);
  await click(dialog.id + '-accept');
  await until(() => dialog.controller.getState().phase === 'overwrite', 'real existing-file question');
  check(surface.document.activeElement?.id === dialog.id + '-keep', 'overwrite defaults to Keep, not destructive Enter');
  await capture('overwrite-question');
  await click(dialog.id + '-cancel'); await idle();
  let actual = files.stat(existing, false);
  check(files.readText(existing, actual.identity).text.startsWith('Native private input.'),
    'ordinary pointer Cancel preserved existing content');

  await click('file-text-save'); dialog = await ready(); dialog.controller.setName(existingName);
  await click(dialog.id + '-accept');
  await until(() => dialog.controller.getState().phase === 'overwrite', 'second real existing-file question');
  const old = dialog.controller.getState().confirmation, parent = files.stat(directory, false);
  actual = fileEntry(files.replaceText(existing, 'External change requiring fresh consent.', old.target.identity, parent.identity));
  await click(dialog.id + '-replace');
  await until(() => dialog.controller.getState().phase === 'overwrite' &&
    dialog.controller.getState().confirmation.target.identity === files.observeText(existing).identity, 'fresh changed observation');
  check(files.readText(existing, actual.identity).text === 'External change requiring fresh consent.',
    'first real Replace did not overwrite changed file');
  check(surface.document.activeElement?.id === dialog.id + '-keep', 'changed question again defaults to Keep');
  await capture('changed-reconfirm');
  await key('tab'); check(surface.document.activeElement?.id === dialog.id + '-replace', 'native Tab explicitly targets Replace');
  await key('enter'); await idle();
  check(app.getState().saved?.path === existing && app.getState().contents === 'PollyUI saved text',
    'fresh ordinary key confirmation actually replaced and read back native content');
  await capture('replace-readback');
  await click('file-text-save'); dialog = await ready(); dialog.controller.setName('eight.txt');
  await click(dialog.id + '-accept');
  await until(() => dialog.controller.getState().phase === 'overwrite', 'real eight-byte existing question');
  const before = dialog.controller.getState().confirmation.target;
  check(before.bytes === 8, 'actual in-place fixture starts with eight bytes');
  await requestPrivateMutation(files, directory, evidence);
  await click(dialog.id + '-replace');
  await until(() => dialog.controller.getState().phase === 'overwrite' &&
    dialog.controller.getState().confirmation.target.identity !== before.identity, 'fresh in-place content observation');
  const after = dialog.controller.getState().confirmation.target;
  console.log('FILE_DIALOG_NATIVE_METADATA_MATCH: ' + String(before.metadataIdentity === after.metadataIdentity));
  check(files.readText(after.path, after.identity).text === 'external', 'first pointer confirmation preserved actual in-place update');
  await capture('in-place-reconfirm');
  await click(dialog.id + '-replace'); await idle();
  check(app.getState().saved?.path === childPath(directory, 'eight.txt') && app.getState().contents === 'PollyUI saved text',
    'second pointer confirmation actually wrote and read back in-place changed document');

  await click('file-text-open'); dialog = await ready();
  observer = window.create({ title: 'FileDialogFixture observer', width: 240, height: 80 });
  const result = dialog.result;
  await signal('close');
  await until(() => surface.closed && app.getState().closed, 'actual WM owner close');
  check((await result).status === 'cancelled', 'actual parent WM close cancelled its modal result');
  const closedState = dialog.controller.getState();
  await wait(100);
  check(dialog.controller.getState() === closedState && !dialog.element.parentNode,
    'observer-kept native event loop did not revive disposed chooser');
  files.writeText(evidence, 'input-pass.json', JSON.stringify({ pass: true,
    nativePointer: true, nativeWheel: true, nativeKeyboard: true, actualReadWrite: true,
    cancelledOwner: true, directory }), files.stat(evidence, false).identity);
  console.log('FILE_DIALOG_INPUT_PASS: actual ordinary pointer/wheel/Tab/ShiftTab/Enter/Escape/read/new-write/reconfirmation/WM-close');
  observer.close();
}
run().catch(error => {
  console.error('FILE_DIALOG_INPUT_FAIL: ' + String(error) + '\n' + (error.stack || ''));
  observer?.close(); app?.stop(); window.quit();
});
