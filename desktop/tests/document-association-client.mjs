import { createApplicationLauncher } from './desktop/shell/applications.mjs';
import { localDocument } from './desktop/shell/documents.mjs';

const [mode, first, second, directory] = application.arguments;
const launcher = createApplicationLauncher(desktop);
const id = name => 'org.pollyui.DocumentFixture.' + name + '.desktop';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(value, message) { if (!value) throw new Error(message); console.log('PASS: ' + message); }
function throws(fn, pattern) {
  let error;
  try { fn(); } catch (failure) { error = failure; }
  check(error && pattern.test(String(error)), 'explicit synchronous refusal ' + pattern);
}
async function rejection(promise, pattern) {
  let error;
  try { await promise; } catch (failure) { error = failure; }
  check(error && pattern.test(String(error.code)), 'explicit actual native Open rejection ' + (error && error.code));
}
async function until(predicate, message) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out: ' + message);
    await delay(10);
  }
}
async function run() {
  check(desktop.documentPlatform === 'linux' && typeof desktop.documentMimeType === 'function' &&
    typeof desktop.mimeAssociationFiles === 'function' && typeof desktop.openApplicationDocuments === 'function',
    'requires actual newly built document native API; old binary/stubs are not accepted');
  const uris = [first, second].map(path => localDocument(path).uri);
  if (mode === 'exec') {
    check(desktop.documentMimeType(first) === 'text/plain', 'actual file utility identifies ordinary temporary text document');
    for (const bad of ['relative', '/missing/polly-document-fixture', directory, '/tmp/\0document'])
      throws(() => desktop.documentMimeType(bad), /path|regular file|Cannot read document/);
    throws(() => desktop.documentMimeType(first, 'arbitrary option'), /requires one/);
    const sources = desktop.mimeAssociationFiles();
    check(sources.length === 8 && sources[0].path.endsWith('/polly-mimeapps.list') && sources[0].desktopSpecific &&
      sources[1].path.endsWith('/mimeapps.list') && sources[4].directory === '' &&
      sources[5].directory.endsWith('/applications'), 'actual XDG source ordering/desktop-default-only and data levels');
    const result = launcher.documentApplications(first);
    check(result.mimeType === 'text/plain' && result.defaultApplication === 'editor.desktop' &&
      result.applications.some(app => app.id === 'editor.desktop') &&
      !result.applications.some(app => ['masked.desktop', 'invalid.desktop', 'launch-only.desktop', 'no-mime.desktop']
        .includes(app.id)), 'actual catalog masks/advertising/parameter capability and user defaults');
    const exits = new Map();
    desktop.onExit = event => exits.set(event.id, event.status);
    const pid = launcher.openDocuments([first, uris[1]]);
    check(Number.isInteger(pid) && pid > 0, 'actual Exec document launch has a real child PID');
    await until(() => exits.has('editor.desktop'), 'actual document application exit');
    check(exits.get('editor.desktop') === 0, 'ordinary document application completed with descriptor/environment guards');
    launcher.openDocuments([first, second], 'uri.desktop');
    await until(() => exits.has('uri.desktop'), 'actual URI document application exit');
    check(exits.get('uri.desktop') === 0, 'Exec wins over DBusActivatable and URI argv reaches an ordinary application');
    throws(() => launcher.openDocuments([first, second], 'single.desktop'), /Single-document/);
    throws(() => launcher.openDocuments([], 'editor.desktop'), /1-32/);
    throws(() => launcher.openDocuments(['https://example.invalid/file']), /absolute/);
    throws(() => launcher.openDocuments([first], 'launch-only.desktop'), /not an available handler/);
  } else if (mode === 'open') {
    let settled = false;
    const waiting = launcher.openDocuments([first, second], id('Success')).then(result => { settled = true; return result; });
    await delay(100);
    check(!settled, 'Open is not acknowledged before actual service method-return');
    const result = await waiting;
    check(result.kind === 'dbus' && result.method === 'Open' && result.acknowledged === true &&
      result.id === id('Success') && result.busName === id('Success').slice(0, -8) &&
      result.objectPath === '/org/pollyui/DocumentFixture/Success' && !('pid' in result),
      'standard Open actual acknowledgement has exact target and no fabricated PID/readiness');
    await rejection(launcher.openDocuments([first, second], id('Missing')), /ServiceUnknown/);
    await rejection(launcher.openDocuments([first, second], id('Error')), /org.pollyui.DocumentFixture.Failed/);
    await rejection(launcher.openDocuments([first, second], id('Malformed')), /POLLY_ACTIVATION_INVALID_REPLY/);
    await rejection(launcher.openDocuments([first, second], id('Fds')),
      /POLLY_ACTIVATION_INVALID_REPLY|POLLY_ACTIVATION_DISCONNECTED|org.freedesktop.DBus.Error.Disconnected/);
    await rejection(launcher.openDocuments([first, second], id('Oversized')),
      /POLLY_ACTIVATION_INVALID_REPLY|POLLY_ACTIVATION_DISCONNECTED|POLLY_ACTIVATION_TIMEOUT|org.freedesktop.DBus.Error.Disconnected|org.freedesktop.DBus.Error.NoReply/);
    const start = Date.now();
    await rejection(launcher.openDocuments([first, second], id('Timeout')), /POLLY_ACTIVATION_TIMEOUT|NoReply/);
    check(Date.now() - start >= 2500 && Date.now() - start < 6000, 'Open preserves bounded post-send reply deadline');
    for (const bad of [[], Array(33).fill(uris[0]), ['https://example.invalid/x'], ['file://host/x'],
      ['file:///tmp/%00'], [uris[0] + '?query'], ['file:///tmp/%C0%AF'], ['file:///missing/document']])
      throws(() => desktop.openApplicationDocuments(id('Success'), bad), /1-32|bounded readable/);
    throws(() => desktop.openApplicationDocuments(id('Success'), uris, 'custom'), /requires a desktop-file ID/);
    throws(() => desktop.openApplicationDocuments('org..Bad.desktop', uris), /Invalid D-Bus/);
  } else if (mode === 'bounds') {
    const pending = Array.from({ length: 8 }, () => desktop.openApplicationDocuments(id('Timeout'), uris));
    throws(() => desktop.openApplicationDocuments(id('Timeout'), uris), /queue is full/);
    throws(() => desktop.activateApplication(id('Timeout')), /queue is full/);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    for (const result of await Promise.allSettled(pending))
      check(result.status === 'rejected' && /POLLY_ACTIVATION_TIMEOUT|NoReply/.test(String(result.reason.code)),
        'shared queue Open ends in explicit timeout');
    clearInterval(timer); check(ticks >= 10, 'native Open leaves the timer/UI pump responsive');
  } else if (mode === 'late') {
    const pending = desktop.openApplicationDocuments(id('Late'), uris).then(result => ({ result }), error => ({ error }));
    await until(() => desktop.applicationFiles().some(file => file.id === 'block-now.desktop'), 'actual service delivery marker');
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {}
    const result = await pending;
    check(!result.result && result.error?.code === 'POLLY_ACTIVATION_TIMEOUT' &&
      String(result.error).includes('indeterminate'), 'expiry-first rejects actual late Open reply after blocked pump');
  } else if (mode === 'rediscovery') {
    check(launcher.documentApplications(first).defaultApplication === 'editor.desktop', 'pre-change default exists');
    console.log('WAIT: change synthetic metadata and defaults');
    await until(() => desktop.applicationFiles().some(file => file.id === 'metadata-changed.desktop'), 'metadata marker');
    check(launcher.documentApplications(first).defaultApplication === 'uri.desktop', 'changed defaults are rediscovered');
    throws(() => launcher.openDocuments([first], 'editor.desktop'), /not an available handler/);
    throws(() => launcher.openDocuments([first], 'masked.desktop'), /not an available handler/);
  } else if (mode === 'settings-error') {
    throws(() => launcher.documentApplications(first), /NUL|malformed MIME/);
  } else if (mode === 'guard') {
    check(!desktop.canActivateApplication(), 'unqualified private bus stays unavailable');
    throws(() => desktop.openApplicationDocuments(id('Success'), uris), /qualified private session bus/);
  } else if (mode === 'shutdown') {
    desktop.openApplicationDocuments(id('Timeout'), uris).catch(error => console.log('SHUTDOWN: ' + error.code));
    setTimeout(() => window.close(), 500);
    console.log('PASS: queued Open will be cancelled at native shutdown');
    return;
  } else if (mode === 'disconnect') {
    const pending = desktop.openApplicationDocuments(id('Disconnect'), uris);
    console.log('WAIT: disconnect actual private daemon');
    await rejection(pending, /POLLY_ACTIVATION_DISCONNECTED|org.freedesktop.DBus.Error.Disconnected/);
  } else throw new Error('Unknown document fixture mode');
  window.close();
}
run().catch(error => { console.error('FAIL: ' + String(error) + '\n' + (error.stack || '')); window.quit(); });
