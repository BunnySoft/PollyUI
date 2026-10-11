import { createFilesApp } from './desktop/apps/files/app.mjs';
import { fileSystem as fs } from './desktop/shared/file-system.mjs';
import { verticalScrollMetrics } from './gui/sdk/js/scrollbar.mjs';

const root = application.arguments[0];
if (root !== '/tmp/polly-alpha-interactions' || fs.stat(root, false).uid !== 1000)
  throw new Error('Expected ordinary-user private synthetic Files directory');
const stateFile = root + '/observed.json';
const events = [];
let pointer = null, stopped = false, timer = null, sequence = 0;
const watched = new Set();
const app = createFilesApp({ initialPath: root, optInTheme: false, host: {
  close: () => window.close(),
  create: options => window.create({ ...options, width: 760, height: 540 }),
} }).start();
const surface = app.getWindow(), doc = surface.document;
function save(value) {
  const text = JSON.stringify(value);
  const parent = fs.stat(root, false).identity;
  if (!sequence++) fs.writeText(root, 'observed.json', text, parent);
  else fs.replaceText(stateFile, text, fs.observeText(stateFile).identity, parent);
}
function observe() {
  const state = app.controller.getState();
  const controls = {};
  for (const id of ['filter', 'list', 'scrollbar', 'scroll-thumb', 'columns']) {
    const node = doc.getElementById('files-' + id);
    if (!node) continue;
    const { x, y, width, height } = node.getBoundingClientRect();
    controls[id] = { x, y, width, height, capture: node.hasMouseCapture(),
      scrollTop: Number(node.scrollTop), scrollLeft: Number(node.scrollLeft),
      maximum: Number(node.getAttribute('aria-valuemax')), value: Number(node.getAttribute('aria-valuenow')) };
    if (['filter', 'scrollbar'].includes(id) && !watched.has(node)) {
      watched.add(node);
      for (const type of ['mousedown', 'mousemove', 'mouseup', 'mousecancel', 'lostmousecapture']) {
        node.addEventListener(type, event => {
          events.push({ id, type, x: event.clientX, y: event.clientY, buttons: event.buttons,
            capture: node.hasMouseCapture(), reason: event.reason });
          if (events.length > 24) events.shift();
        });
      }
    }
  }
  const list = doc.getElementById('files-list'), track = doc.getElementById('files-scrollbar');
  save({ sequence, phase: state.phase, error: state.error || '', filter: state.filter,
    activeElement: doc.activeElement?.id || '', controls, events, pointer,
    width: doc.body.offsetWidth, height: doc.body.offsetHeight,
    textStartX: controls.filter ? controls.filter.x + 9 + measureText('r', 14) : null,
    metrics: list && track ? verticalScrollMetrics(list, track.offsetHeight) : null,
    clipboard: clipboard.readText(), stopped });
}
doc.body.addEventListener('mousemove', event => { pointer = { x: event.clientX, y: event.clientY }; });
const originalClose = surface.onclose;
surface.onclose = () => {
  originalClose(); stopped = app.controller.getState().phase === 'disposed';
  clearInterval(timer);
  save({ stopped, phase: app.controller.getState().phase, events });
  window.quit();
};
clipboard.writeText('row');
timer = setInterval(() => {
  try { observe(); }
  catch (error) { console.error('POLLY_VM_FILES_INTERACTIONS_FAILED: ' + error); clearInterval(timer); app.stop(); }
}, 150);
setTimeout(() => {
  if (!stopped) throw new Error('Bounded native Files interaction observation exceeded 60 seconds');
}, 60000);
