import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, mkdir, rename, rmdir, rm, stat, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const ui = resolve(process.argv[2]);
const temporary = await mkdtemp(join(tmpdir(), 'pollyui-xdg-'));
const environment = { ...process.env, HOME: join(temporary, 'home'),
  XDG_CONFIG_HOME: join(temporary, 'config'), XDG_DATA_HOME: join(temporary, 'data'),
  XDG_CACHE_HOME: join(temporary, 'cache'), SDL_VIDEODRIVER: 'dummy',
  SDL_RENDER_DRIVER: 'software', PU_RENDERER: 'raster' };
delete environment.SDL_APP_ID;
const script = join(temporary, 'app.mjs');
const source = `
console.log('APP ' + JSON.stringify(application));
const [operation, encoded, extra] = application.arguments;
const expected = JSON.parse(encoded);
if (extra !== 'argument with spaces') throw new Error('argument boundary lost');
if (operation === 'write') {
  localStorage.setItem('marker', expected);
  localStorage.setItem('nul', 'x\\u0000y');
} else if (localStorage.getItem('marker') !== expected) {
  throw new Error('storage isolation or persistence failed');
}
if (expected !== null && localStorage.getItem('nul') !== 'x\\u0000y') throw new Error('persisted NUL was truncated');
console.log('PASS: XDG application');
setTimeout(() => window.close(), 30);
`;

async function launch(file, id, operation, value, env = environment, onReady) {
  const args = [...(id === null ? [] : ['--app-id', id]), file, operation,
                JSON.stringify(value), 'argument with spaces'];
  const child = spawn(ui, args, { env });
  let output = '', preparation, preparationError;
  child.stdout.on('data', data => {
    output += data;
    if (onReady && !preparation && output.includes('READY')) {
      preparation = onReady().catch(error => { preparationError = error; child.kill(); });
    }
  });
  child.stderr.on('data', data => { output += data; });
  const timer = setTimeout(() => child.kill(), 15000);
  let code;
  try {
    code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
    if (preparation) await preparation;
    if (preparationError) throw preparationError;
  } finally { clearTimeout(timer); }
  return { code, output };
}

function successful(result) {
  if (result.code !== 0 || !result.output.includes('PASS: XDG application'))
    throw new Error(`App failed: ${result.code}\n${result.output}`);
  return JSON.parse(result.output.split('\n').find(line => line.startsWith('APP ')).slice(4));
}

try {
  await writeFile(script, source);
  const first = successful(await launch(script, 'org.pollyui.one', 'write', 'one'));
  successful(await launch(script, 'org.pollyui.two', 'write', 'two'));
  successful(await launch(script, 'org.pollyui.one', 'read', 'one'));
  if (first.dataDir !== join(temporary, 'data', 'pollyui', 'org.pollyui.one'))
    throw new Error('XDG_DATA_HOME was not respected');
  for (const path of [first.configDir, first.dataDir, first.cacheDir]) {
    if ((await stat(path)).mode & 0o077) throw new Error('App directory is not private');
  }
  const storage = join(first.dataDir, 'localstorage.dat');
  if ((await stat(storage)).mode & 0o077) throw new Error('Storage file is not private');
  const original = await readFile(storage);
  if (!original.includes(Buffer.from('x\0y'))) throw new Error('Binary-safe storage encoding missing');

  const automatic = successful(await launch(script, null, 'write', 'automatic'));
  successful(await launch(script, null, 'read', 'automatic'));
  const other = join(temporary, 'other.mjs');
  await writeFile(other, source);
  const distinct = successful(await launch(other, null, 'read', null));
  if (automatic.id === distinct.id) throw new Error('Different script entries share an automatic ID');
  const invalid = await launch(script, '../escape', 'read', null);
  if (invalid.code !== 1 || !invalid.output.includes('Invalid application ID'))
    throw new Error('Unsafe app ID accepted');
  const relative = await launch(script, 'org.pollyui.relative', 'read', null,
    { ...environment, XDG_CONFIG_HOME: 'relative' });
  if (relative.code !== 1 || !relative.output.includes('must be absolute'))
    throw new Error('Relative XDG base accepted');
  const exposed = join(temporary, 'data', 'pollyui', 'org.pollyui.exposed');
  await mkdir(exposed, { mode: 0o755 });
  if ((await launch(script, 'org.pollyui.exposed', 'read', null)).code !== 1)
    throw new Error('Non-private application directory accepted');
  const destination = join(temporary, 'elsewhere');
  await mkdir(destination, { mode: 0o700 });
  await symlink(destination, join(temporary, 'data', 'pollyui', 'org.pollyui.link'));
  if ((await launch(script, 'org.pollyui.link', 'read', null)).code !== 1)
    throw new Error('Symlinked application directory accepted');

  const fallbackEnv = { ...environment };
  delete fallbackEnv.XDG_CONFIG_HOME; delete fallbackEnv.XDG_DATA_HOME; delete fallbackEnv.XDG_CACHE_HOME;
  const fallback = successful(await launch(script, 'org.pollyui.fallback', 'write', 'fallback', fallbackEnv));
  if (fallback.dataDir !== join(environment.HOME, '.local', 'share', 'pollyui', fallback.id))
    throw new Error('HOME fallback was not used');

  const blockedScript = join(temporary, 'blocked.mjs'), gate = join(temporary, 'gate');
  await writeFile(blockedScript, `
console.log('READY');
function attempt() {
  fetch(${JSON.stringify('file://' + gate)}).then(() => {
    let failed = false;
    try { localStorage.setItem('marker', 'should-not-commit'); } catch (_) { failed = true; }
    if (!failed || localStorage.getItem('marker') !== 'one') console.error('FAIL: failed write mutated memory');
    else console.log('PASS: atomic failure preserved memory');
    window.close();
  }, () => setTimeout(attempt, 20));
}
setTimeout(attempt, 20);
`);
  const backup = storage + '.saved';
  const failedWrite = await launch(blockedScript, 'org.pollyui.one', 'read', null, environment, async () => {
    await rename(storage, backup);
    await mkdir(storage);
    await writeFile(gate, 'ready');
  });
  if (failedWrite.code !== 0 || failedWrite.output.includes('FAIL:') ||
      !failedWrite.output.includes('PASS: atomic failure preserved memory'))
    throw new Error(failedWrite.output);
  if (!(await readFile(backup)).equals(original)) throw new Error('Original storage changed on failed write');
  await rmdir(storage); await rename(backup, storage);
  if ((await readdir(first.dataDir)).some(name => name.includes('.tmp.')))
    throw new Error('Failed write leaked a temporary file');
  await writeFile(storage, 'bad-format');
  const malformed = await launch(script, 'org.pollyui.one', 'read', 'one');
  if (malformed.code !== 1 || !malformed.output.includes('Cannot load localStorage') ||
      await readFile(storage, 'utf8') !== 'bad-format')
    throw new Error('Corrupt storage was silently accepted or overwritten');
  console.log('PASS: XDG namespaces, privacy, persistence, fallback, arguments and atomic storage failure');
} finally {
  await rm(temporary, { recursive: true });
}
