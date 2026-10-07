import { createTextInput } from './js/textinput.mjs';
import { CANDIDATE_LAYOUT } from './desktop/input-method/view.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(value, message) { if (!value) throw new Error(message); console.log('PASS: ' + message); }
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
  await signal(`fixture-key ${code} 1`); await signal(`fixture-key ${code} 0`);
}
async function run() {
  if (application.arguments[0] === 'reload') { await signal('fixture-success'); window.quit(); return; }
  const editor = window.create({ title: 'IME editor fixture', width: 480, height: 200 });
  check(desktop.sessionServices().inputMethod === 'disabled', 'unrequested IME is disabled, not falsely waiting');
  window.close();
  const field = createTextInput({ document: editor.document, width: 400 });
  const password = createTextInput({ document: editor.document, width: 400, password: true });
  const numeric = createTextInput({ document: editor.document, width: 400, purpose: 'number' });
  editor.document.body.appendChild(field.root); editor.document.body.appendChild(password.root);
  editor.document.body.appendChild(numeric.root);
  field.root.focus();
  let preedit = '', commits = 0, functionKeys = 0;
  field.root.addEventListener('compositionupdate', event => preedit = event.data);
  field.root.addEventListener('textinput', () => commits++);
  field.root.addEventListener('keydown', event => { if (event.key === 'F5') functionKeys++; });
  await until(() => desktop.windows().some(item => item.title === 'IME editor fixture' && item.active), 'editor focus');
  await signal('fixture-ime-start'); await signal('fixture-ime-ready');
  await until(() => desktop.sessionServices().inputMethod === 'ready', 'trusted engine readiness acknowledgment');
  await tap(63);
  await until(() => functionKeys === 1, 'unhandled function key is forwarded');
  for (const code of [49, 23, 35, 30, 24]) await tap(code);
  await until(() => preedit === 'nihao' && field.root.textContent === 'nihao', 'native inline preedit');
  check(field.value === '' && commits === 0, 'native preedit does not mutate application value');
  await signal('fixture-ime-popup');
  await signal(`fixture-ime-click 30 ${CANDIDATE_LAYOUT.padding + CANDIDATE_LAYOUT.header +
    CANDIDATE_LAYOUT.preedit + CANDIDATE_LAYOUT.row / 2}`);
  await until(() => field.value === '\u4f60\u597d', 'native candidate click commits Chinese');
  check(commits === 1, 'candidate click commits exactly once without losing editor focus');
  await signal('fixture-ime-no-popup');
  preedit = '';
  await tap(49); await tap(23);
  await until(() => preedit === 'ni', 'second composition');
  await tap(1);
  await until(() => field.root.textContent === field.value, 'Escape removes inline preedit');
  check(field.value === '\u4f60\u597d' && commits === 1, 'Escape does not commit cancelled input');
  await signal('fixture-ime-no-popup');
  password.root.focus();
  await signal('fixture-ime-idle');
  await tap(49);
  await until(() => password.value === 'n', 'password receives direct keyboard input');
  check(password.root.textContent === '\u2022', 'native password content is masked and bypasses the IME');
  await signal('fixture-ime-no-popup');
  numeric.root.focus();
  await signal('fixture-ime-ready');
  await tap(49);
  await until(() => numeric.value === 'n', 'numeric purpose uses direct ASCII rather than pinyin');
  await signal('fixture-ime-no-popup');
  field.root.focus();
  await signal('fixture-ime-ready');
  for (const code of [16, 22, 23, 20]) await tap(code);
  await signal('fixture-ime-gone');
  await until(() => desktop.sessionServices().inputMethod === 'failed', 'service loss invalidates initialization status');
  await until(() => field.root.textContent === field.value, 'service exit clears unfinished composition');
  await tap(44);
  await until(() => field.value === '\u4f60\u597dz', 'ordinary typing recovers after service exit');
  check(true, 'real Rime, native candidate popup, inline editor and service recovery');
  await signal('fixture-success');
  window.quit();
}
run().catch(error => { console.error('FAIL: ' + String(error) + '\n' + (error.stack || '')); window.quit(); });
