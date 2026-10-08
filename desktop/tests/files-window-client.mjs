import { createFilesApp } from './desktop/files/app.mjs';
import { requireFileSystem } from './desktop/files/model.mjs';

const [root] = application.arguments;
if (typeof root !== 'string' || !root.startsWith('/tmp/polly-files-window-') ||
    root.slice('/tmp/'.length).includes('/'))
  throw new Error('Files window fixture requires an explicitly staged private /tmp/polly-files-window-* directory');
const api = requireFileSystem(typeof desktop === 'undefined' ? null : desktop);
for (const name of ['listDirectory', 'stat', 'readText', 'writeText', 'replaceText', 'createDirectory', 'rename'])
  if (!Function.prototype.toString.call(api[name]).includes('[native code]'))
    throw new Error('Fresh real native file API required, not a JS filesystem stub: ' + name);
if (api.locations().home !== root) throw new Error('Private fixture HOME must exactly match the supplied directory');
const marker = api.stat(root + '/fixture-marker.txt', false);
if (marker.uid !== 1000 || marker.type !== 'file' ||
    api.readText(marker.path, marker.identity).text !== 'POLLY-FILES-PRIVATE-WINDOW-V1\n')
  throw new Error('Private fixture marker missing; no host enumeration is permitted');

const app = createFilesApp({ initialPath: root, optInTheme: false }).start();
const evidence = { documents: false, returnedHome: false, folderCreated: false, folderRenamed: false,
  documentOpened: false, cancelled: false, wheel: false };
let ticks = 0, last = '', previousDialog = false, passed = false;
function bounds(node) {
  return { x: node.offsetLeft, y: node.offsetTop, width: node.offsetWidth, height: node.offsetHeight };
}
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
    evidence.documents ||= state.path === root + '/Documents';
    evidence.returnedHome ||= evidence.documents && state.path === root;
    evidence.folderCreated ||= state.message === 'Created folder: New folder';
    evidence.folderRenamed ||= state.message === 'Renamed to: Renamed folder';
    evidence.documentOpened ||= state.message === 'Open requested: literal %u; 中文.txt';
    evidence.cancelled ||= previousDialog && !state.dialog && !state.message;
    previousDialog = !!state.dialog;
    const document = surface.document, list = document.getElementById('files-list');
    evidence.wheel ||= list && Number(list.scrollTop) > 0;
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
    if (!passed && Object.values(evidence).every(Boolean)) {
      if (api.stat(root + '/Renamed folder', false).type !== 'directory')
        throw new Error('Actual renamed directory must exist, not only an optimistic UI row');
      passed = true;
      console.log('FILES_WINDOW_ACTIONS_PASS: native ordinary browser/new-folder/rename/MIME Open/cancel/wheel');
    }
  } catch (error) {
    clearInterval(timer);
    console.error('FILES_WINDOW_FAIL: ' + error); app.stop();
  }
}, 20);
