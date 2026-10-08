import { createFilesApp } from './desktop/files/app.mjs';
import { requireFileSystem } from './desktop/files/model.mjs';

const [root, mode] = application.arguments;
if (typeof root !== 'string' || !root.startsWith('/tmp/polly-files-window-') ||
    root.slice('/tmp/'.length).includes('/'))
  throw new Error('Files window fixture requires an explicitly staged private /tmp/polly-files-window-* directory');
const api = requireFileSystem(typeof desktop === 'undefined' ? null : desktop);
for (const name of ['listDirectory', 'stat', 'readText', 'observeText', 'writeText', 'replaceText', 'createDirectory', 'rename'])
  if (!Function.prototype.toString.call(api[name]).includes('[native code]'))
    throw new Error('Fresh real native file API required, not a JS filesystem stub: ' + name);
if (api.locations().home !== root) throw new Error('Private fixture HOME must exactly match the supplied directory');
const marker = api.stat(root + '/fixture-marker.txt', false);
if (marker.uid !== 1000 || marker.type !== 'file' ||
    api.readText(marker.path, marker.identity).text !== 'POLLY-FILES-PRIVATE-WINDOW-V1\n')
  throw new Error('Private fixture marker missing; no host enumeration is permitted');

const app = createFilesApp({ initialPath: root, optInTheme: false }).start();
const evidence = { documents: false, returnedHome: false, folderCreated: false, folderRenamed: false,
  documentOpenRequested: false, cancelled: false, wheel: false, keyboardRename: false, history: false };
const captureStages = ['home-browser', 'scrolled-list', 'new-folder', 'rename-edit', 'renamed-folder', 'before-wm-close'];
const captures = [];
let ticks = 0, last = '', previousDialog = false, passed = false;
const renamedName = mode === '--drive' ? 'New folde' : 'Renamed folder';
let closeObserved = false;
let closingViaDriver = false, driveFailed = false;
function bounds(node) {
  const rect = node.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}
function observe() {
  const state = app.controller.getState(), surface = app.getWindow();
  if (!surface || state.phase !== 'ready') return;
  evidence.documents ||= state.path === root + '/Documents';
  evidence.returnedHome ||= evidence.documents && state.path === root;
  evidence.folderCreated ||= state.message === 'Created folder: New folder';
  evidence.folderRenamed ||= state.message === 'Renamed to: ' + renamedName;
  evidence.documentOpenRequested ||= state.message === 'Open requested: literal %u; 中文.txt';
  evidence.cancelled ||= previousDialog && !state.dialog && !state.message;
  previousDialog = !!state.dialog;
  const list = surface.document.getElementById('files-list');
  evidence.wheel ||= list && Number(list.scrollTop) > 0;
}
const surface = app.getWindow(), originalClose = surface.onclose;
surface.onclose = () => {
  originalClose();
  closeObserved = app.controller.getState().phase === 'disposed';
  const complete = Object.values(evidence).every(Boolean) && captures.length === captureStages.length;
  if (mode === '--drive' && complete && closeObserved && closingViaDriver && !driveFailed) {
    try {
      api.writeText(root, 'files-window-result.json', JSON.stringify({
        version: 1, native: true, root, passed: true, closeObserved, evidence,
        appId: 'org.pollyui.files-window-fixture', renamedName, captures,
      }), api.stat(root, false).identity);
    } catch (error) { console.error('FILES_WINDOW_FAIL: cannot persist actual close receipt: ' + error); }
  }
};
const timer = setInterval(() => {
  try {
    const state = app.controller.getState(), surface = app.getWindow();
    if (state.phase === 'disposed') {
      clearInterval(timer);
      console.log('FILES_WINDOW_CLOSE_PASS: real ordinary Files window disposed');
      return;
    }
    if (++ticks > 6000) throw new Error('Files ordinary-window fixture timed out waiting for real input');
    if (state.phase === 'error' || state.error) throw new Error(state.error || state.phase);
    if (!surface || state.phase !== 'ready') return;
    observe();
    const document = surface.document, list = document.getElementById('files-list');
    const controls = {};
    for (const name of ['back', 'forward', 'parent', 'refresh', 'new-folder', 'rename', 'open', 'open-with',
      'name', 'confirm', 'cancel', 'page-previous', 'page-next', 'place-documents', 'place-home', 'list']) {
      const node = document.getElementById('files-' + name);
      if (node) controls[name] = bounds(node);
    }
    controls.entries = state.snapshot.entries.slice(state.page * 64, (state.page + 1) * 64).map((entry, index) => {
      const node = document.getElementById('files-entry-' + index);
      return { name: entry.name, type: entry.type, ...(node ? bounds(node) : {}) };
    });
    const receipt = JSON.stringify({ path: state.path, generation: state.generation, selection: state.selection?.name ?? null,
      message: state.message, dialog: state.dialog?.kind ?? null, page: state.page, evidence, controls });
    if (receipt !== last) { console.log('FILES_WINDOW_STATE: ' + receipt); last = receipt; }
    if (!passed && mode === '--drive' && Object.values(evidence).every(Boolean)) {
      if (api.stat(root + '/' + renamedName, false).type !== 'directory')
        throw new Error('Actual renamed directory must exist, not only an optimistic UI row');
      passed = true;
      console.log('FILES_WINDOW_ACTIONS_PASS: native ordinary browser/new-folder/rename/MIME Open/cancel/wheel');
    }
  } catch (error) {
    driveFailed = true;
    clearInterval(timer);
    console.error('FILES_WINDOW_FAIL: ' + error); app.stop();
  }
}, 20);

async function drive() {
  let sequence = 0;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(predicate, description) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const state = app.controller.getState();
      if (state.error || state.phase === 'error') throw new Error(state.error || state.phase);
      observe();
      if (predicate()) return;
      await wait(20);
    }
    throw new Error('Real Files input timed out: ' + description);
  }
  async function request(command) {
    const marker = window.create({ title: 'FilesFixture.' + (++sequence) + '.' + command, width: 1, height: 1 });
    let ack = false;
    marker.onclose = () => { ack = true; };
    await until(() => ack, 'native marker ACK ' + command);
  }
  async function click(id, rightEnd = false) {
    await until(() => {
      const node = app.getWindow()?.document.getElementById(id);
      return node && bounds(node).width > 0 && bounds(node).height > 0;
    }, 'mapped actual control ' + id);
    const rect = bounds(app.getWindow().document.getElementById(id));
    await request('click ' + Math.round(rect.x + (rightEnd ? rect.width - 5 : rect.width / 2)) +
      ' ' + Math.round(rect.y + rect.height / 2));
  }
  async function wheel(delta) {
    await until(() => {
      const current = app.getWindow();
      if (!current || current.closed) return false;
      const list = current.document.getElementById('files-list');
      const first = current.document.getElementById('files-entry-0');
      if (!list || !first) return false;
      const viewport = bounds(list), frame = bounds(current.document.body), entry = bounds(first);
      return viewport.width > 0 && viewport.height > 0 && entry.width > 0 && entry.height > 0 &&
        viewport.x >= frame.x && viewport.y >= frame.y &&
        viewport.x + viewport.width <= frame.x + frame.width &&
        viewport.y + viewport.height <= frame.y + frame.height;
    }, 'bounded mapped file-list viewport');
    const rect = bounds(app.getWindow().document.getElementById('files-list'));
    await request('wheel ' + Math.round(rect.x + Math.min(120, rect.width / 2)) +
      ' ' + Math.round(rect.y + Math.min(90, rect.height / 2)) + ' ' + delta);
  }
  async function captureFrame(stage) {
    if (stage !== captureStages[captures.length]) throw new Error('Unexpected capture stage: ' + stage);
    const directory = api.stat(root + '/evidence', false);
    if (directory.type !== 'directory' || directory.path !== root + '/evidence' ||
        directory.uid !== 1000 || directory.permissions !== '0700' || !directory.readable || !directory.writable)
      throw new Error('Captures require a staged ordinary-user private evidence directory');
    const path = directory.path + '/files-' + stage + '.png';
    try {
      api.stat(path, false);
      throw new Error('Capture destination already exists: ' + path);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await wait(80);
    const current = app.getWindow(), snapshot = app.controller.getState();
    if (!current || current.closed || snapshot.phase !== 'ready' || typeof current.capture !== 'function' ||
        !Function.prototype.toString.call(current.capture).includes('[native code]'))
      throw new Error('A live actual native window is required for capture');
    current.capture(path);
    const file = api.stat(path, false);
    if (file.type !== 'file' || file.uid !== 1000 || file.bytes <= 8)
      throw new Error('Native capture did not produce an ordinary PNG artifact');
    const record = { stage, path, bytes: file.bytes, kind: 'presented-app-buffer',
      folder: snapshot.path, generation: snapshot.generation, page: snapshot.page,
      scrollTop: Number(current.document.getElementById('files-list').scrollTop),
      selection: snapshot.selection?.name ?? null, dialog: snapshot.dialog?.kind ?? null,
      dialogName: snapshot.dialog?.name ?? null, message: snapshot.message };
    captures.push(record);
    console.log('FILES_WINDOW_CAPTURE: ' + JSON.stringify(record));
  }
  const state = () => app.controller.getState();
  await until(() => state().phase === 'ready' && state().path === root, 'private initial folder');
  await captureFrame('home-browser');
  await click('files-place-documents');
  await until(() => state().phase === 'ready' && state().path === root + '/Documents', 'Documents navigation');
  await click('files-parent');
  await until(() => state().phase === 'ready' && state().path === root, 'Up navigation');
  await click('files-back');
  await until(() => state().phase === 'ready' && state().path === root + '/Documents', 'Back navigation');
  await click('files-forward');
  await until(() => state().phase === 'ready' && state().path === root, 'Forward navigation');
  evidence.history = true;
  await wheel(180);
  await until(() => Number(app.getWindow().document.getElementById('files-list').scrollTop) > 0, 'actual wheel scroll');
  await captureFrame('scrolled-list');
  await wheel(-400);
  await click('files-new-folder');
  await until(() => state().dialog?.kind === 'create' && state().dialog.name === 'New folder', 'editable new folder');
  await request('key escape');
  await until(() => !state().dialog, 'Escape cancellation');
  await click('files-new-folder');
  await until(() => state().dialog?.kind === 'create', 'new folder confirmation');
  await click('files-confirm');
  await until(() => state().phase === 'ready' && state().selection?.name === 'New folder', 'actual create and rescan');
  await captureFrame('new-folder');
  await click('files-rename');
  await until(() => state().dialog?.kind === 'rename', 'rename exact selected folder');
  await click('files-name', true);
  if (app.getWindow().document.activeElement?.id !== 'files-name')
    throw new Error('Actual native pointer must focus the name input');
  await request('key backspace');
  await until(() => state().dialog?.name === 'New folde', 'real Backspace filename edit');
  if (app.getWindow().document.activeElement?.id !== 'files-name')
    throw new Error('Native Backspace must retain actual input focus');
  evidence.keyboardRename = true;
  await captureFrame('rename-edit');
  await click('files-confirm');
  await until(() => state().phase === 'ready' && state().selection?.name === renamedName, 'actual rename and rescan');
  await captureFrame('renamed-folder');
  const index = state().snapshot.entries.findIndex(entry => entry.name === 'literal %u; 中文.txt');
  if (index < 0) throw new Error('Private actual document is missing');
  const page = Math.floor(index / 64);
  while (state().page < page) {
    const old = state().page;
    await click('files-page-next');
    await until(() => state().page === old + 1, 'next visible files page');
  }
  const rowId = 'files-entry-' + (index % 64);
  let visible = false;
  for (let attempt = 0; attempt < 32 && !visible; attempt++) {
    const document = app.getWindow().document, row = bounds(document.getElementById(rowId));
    const list = bounds(document.getElementById('files-list'));
    visible = row.y >= list.y && row.y + row.height <= list.y + list.height;
    if (!visible) await wheel(row.y < list.y ? -240 : 240);
  }
  if (!visible) throw new Error('Native document row did not become visible');
  await click(rowId);
  await until(() => state().selection?.name === 'literal %u; 中文.txt', 'explicit actual document selection');
  await click('files-open');
  await until(() => state().message === 'Open requested: literal %u; 中文.txt', 'actual standard MIME dispatch');
  await captureFrame('before-wm-close');
  observe();
  if (!Object.values(evidence).every(Boolean)) throw new Error('Missing actual Files action evidence: ' + JSON.stringify(evidence));
  console.log('FILES_WINDOW_DRIVE_PASS: native pointer/wheel/name-focus/Backspace/history/MIME-dispatch; helper receipt verified externally');
  closingViaDriver = true;
  await request('close');
  await until(() => closeObserved, 'actual WM close callback');
}
if (mode === '--drive') drive().catch(error => {
  driveFailed = true;
  clearInterval(timer);
  console.error('FILES_WINDOW_FAIL: ' + error); app.stop();
});
