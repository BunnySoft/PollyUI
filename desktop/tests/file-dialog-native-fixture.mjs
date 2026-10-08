import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

if (process.platform !== 'linux' || process.getuid() !== 1000 || process.geteuid() !== 1000)
  throw new Error('Run this actual native fixture as ordinary Linux UID1000');
const [runtimeArgument, evidenceArgument, mode] = process.argv.slice(2);
if (mode !== undefined && mode !== '--window-input') throw new Error('Unknown native fixture mode');
const input = mode === '--window-input';
if (!runtimeArgument || !evidenceArgument || !path.isAbsolute(runtimeArgument) || !path.isAbsolute(evidenceArgument))
  throw new Error('Usage: node desktop/tests/file-dialog-native-fixture.mjs ABSOLUTE_NEW_POLLYUI ABSOLUTE_PRIVATE_EVIDENCE');
const runtime = await realpath(runtimeArgument);
assert.equal((await stat(runtime)).isFile(), true);
const repo = fileURLToPath(new URL('../../', import.meta.url));
await mkdir(evidenceArgument, { recursive: true });
const evidence = await mkdtemp(path.join(evidenceArgument, 'file-dialog-native-'));
const privateRoot = await mkdtemp(path.join(tmpdir(), 'polly-file-dialog-'));
await writeFile(path.join(privateRoot, 'fixture-marker.txt'), 'POLLYUI_FILE_DIALOG_PRIVATE_V1', { mode: 0o600 });
await writeFile(path.join(privateRoot, 'hello space "quoted" \u6587.txt'),
  'Native private input.\nUnicode \u6587 and quoted filename.', { mode: 0o600 });
await mkdir(path.join(privateRoot, 'Folder \u6587'), { mode: 0o700 });
if (input)
  await Promise.all(Array.from({ length: 96 }, (_, index) =>
    writeFile(path.join(privateRoot, 'Folder \u6587', 'row-' + String(index).padStart(3, '0') + '.txt'),
      'Private bounded-list row.', { mode: 0o600 })));
let log = '', timedOut = false;
const child = spawn(runtime, ['--desktop', '--app-id', input ? 'org.pollyui.file-dialog-window' : 'org.pollyui.file-dialog-fixture',
  path.join(repo, 'desktop', 'tests', input ? 'file-dialog-window.mjs' : 'file-dialog-native.mjs'), privateRoot, evidence],
{ cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: privateRoot,
  XDG_CONFIG_HOME: path.join(privateRoot, 'config'), XDG_DATA_HOME: path.join(privateRoot, 'data'),
  XDG_CACHE_HOME: path.join(privateRoot, 'cache') } });
for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
  log += data.toString(); process.stdout.write(data);
});
const timeout = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 60000);
const terminate = setTimeout(() => child.kill('SIGKILL'), 65000);
let status, signal;
try {
  [status, signal] = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', (code, value) => resolve([code, value]));
  });
} finally {
  clearTimeout(timeout);
  clearTimeout(terminate);
  await writeFile(path.join(evidence, 'native.log'), log);
}
const hashes = {};
const screenshots = input ? ['input-open-list.png', 'input-folder-wheel.png', 'input-read-content.png',
  'input-new-save.png', 'input-overwrite-question.png', 'input-changed-reconfirm.png', 'input-replace-readback.png'] :
  ['01-open-list.png', '02-read-content.png', '03-new-save-readback.png',
    '04-overwrite-question.png', '05-changed-reconfirm.png', '06-replace-readback.png'];
for (const filename of screenshots) {
  try {
    const data = await readFile(path.join(evidence, filename));
    assert.equal(data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    hashes[filename] = createHash('sha256').update(data).digest('hex');
  } catch (error) {
    hashes[filename] = { error: String(error) };
  }
}
let verified = false;
try {
  assert.equal(timedOut, false); assert.equal(status, 0); assert.equal(signal, null);
  assert.match(log, input ? /FILE_DIALOG_INPUT_PASS/ : /FILE_DIALOG_NATIVE_PASS/);
  assert.doesNotMatch(log, /FILE_DIALOG_(?:NATIVE|INPUT)_FAIL/);
  assert.equal(await readFile(path.join(privateRoot, 'hello space "quoted" \u6587.txt'), 'utf8'), 'PollyUI saved text');
  assert.equal(await readFile(path.join(privateRoot, 'new space "quoted" \u6587.txt'), 'utf8'), 'PollyUI saved text');
  assert.ok(Object.values(hashes).every(hash => typeof hash === 'string'), 'all native screenshots must exist');
  if (input) {
    const receipt = JSON.parse(await readFile(path.join(evidence, 'input-pass.json'), 'utf8'));
    assert.equal(receipt.pass, true); assert.equal(receipt.directory, privateRoot);
    assert.equal(receipt.nativePointer, true); assert.equal(receipt.nativeKeyboard, true);
  }
  verified = true;
} finally {
  await writeFile(path.join(evidence, 'receipt.json'), JSON.stringify({ verified, runtime,
    runtimeSha256: createHash('sha256').update(await readFile(runtime)).digest('hex'),
    privateRoot, evidence, status, signal, timedOut, screenshots: hashes,
    scope: input ? 'Actual ordinary native filesystem/controller/consumer and source-owned compositor pointer/key injector; not physical GPU/input proof.' :
      'Actual ordinary native filesystem/controller/consumer. Programmatic UI actions, not pointer/keyboard or physical GPU proof.' }, null, 2));
  console.log('Retained private native fixture/evidence: ' + privateRoot + ' / ' + evidence);
}
