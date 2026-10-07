import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseBundleManifest, planBundleLaunch } from '../shared/app-bundle.mjs';

const runtime = path.resolve(process.argv[2]);
const temporary = mkdtempSync(path.join(tmpdir(), 'polly-bundle-data-'));
const target = { os: 'linux', architecture: 'x86_64', libc: existsSync('/etc/alpine-release') ? 'musl' : 'glibc' };
const environment = { ...process.env, HOME: path.join(temporary, 'user'),
  XDG_CONFIG_HOME: path.join(temporary, 'config'), XDG_DATA_HOME: path.join(temporary, 'data'),
  XDG_CACHE_HOME: path.join(temporary, 'cache'), XDG_STATE_HOME: path.join(temporary, 'state'),
  SDL_VIDEODRIVER: 'dummy', SDL_RENDER_DRIVER: 'software', PU_RENDERER: 'raster' };
const source = `
const [operation, expected] = application.arguments;
if (operation === 'write') localStorage.setItem('document', expected);
else if (localStorage.getItem('document') !== (expected || null)) throw new Error('Application data changed across versions');
console.log('PATHS ' + JSON.stringify({id: application.id, configDir: application.configDir,
  dataDir: application.dataDir, cacheDir: application.cacheDir}));
console.log('PASS: actual bundle appdata');
window.close();
`;
const base = { schemaVersion: 1, id: 'org.example.notes', name: 'Notes', version: '1.0.0',
  target, launch: { kind: 'pollyui', entry: 'main.mjs' }, data: { layout: 'pollyui', schema: 1 } };
function prepare(directory, manifest, contents = source) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(path.join(directory, manifest.launch.entry), contents);
  return directory;
}
function launch(directory, manifest, env = environment) {
  const plan = planBundleLaunch(manifest, { bundleRoot: directory, platform: target, environment: env, pollyuiExecutable: runtime });
  const child = spawnSync(plan.argv[0], plan.argv.slice(1), {
    cwd: plan.cwd, env: { ...env, ...plan.environmentOverrides }, encoding: 'utf8', timeout: 15000,
  });
  const output = child.stdout + child.stderr;
  assert.equal(child.error, undefined, String(child.error));
  assert.equal(child.status, 0, output);
  assert.doesNotMatch(output, /Uncaught|FAIL:|AddressSanitizer|LeakSanitizer|runtime error:/);
  assert.match(output, /PASS: actual bundle appdata/);
  const reported = JSON.parse(child.stdout.split('\n').find(line => line.startsWith('PATHS ')).slice(6));
  for (const field of ['configDir', 'dataDir', 'cacheDir']) assert.equal(reported[field], plan.paths[field], field);
  assert.equal(reported.id, manifest.id);
  assert.equal(readFileSync(path.join(directory, manifest.launch.entry), 'utf8'), source);
  return plan;
}
try {
  const one = prepare(path.join(temporary, 'Programs', 'Notes v1.app'), base);
  const first = parseBundleManifest(readFileSync(path.join(one, 'manifest.json'), 'utf8'));
  const initial = launch(one, { ...first, launch: { ...first.launch, arguments: ['write', 'retained document'] } });
  const two = prepare(path.join(temporary, 'moved programs', 'Renamed v2.app'), { ...base, name: 'New name', version: '2.0.0' });
  const next = parseBundleManifest(readFileSync(path.join(two, 'manifest.json'), 'utf8'));
  const upgraded = launch(two, { ...next, launch: { ...next.launch, arguments: ['read', 'retained document'] } });
  assert.deepEqual(upgraded.paths, initial.paths);
  const durable = path.join(initial.paths.dataDir, 'localstorage.dat');
  const bytes = readFileSync(durable);
  rmSync(initial.paths.cacheDir, { recursive: true });
  launch(one, { ...first, launch: { ...first.launch, arguments: ['read', 'retained document'] } });
  assert.deepEqual(readFileSync(durable), bytes, 'clearing cache must not alter durable data');
  launch(two, { ...next, id: 'org.example.other', launch: { ...next.launch, arguments: ['read', ''] } });
  launch(two, { ...next, launch: { ...next.launch, arguments: ['read', ''] } }, {
    ...environment, HOME: path.join(temporary, 'other-user'),
    XDG_CONFIG_HOME: '', XDG_DATA_HOME: '', XDG_CACHE_HOME: '', XDG_STATE_HOME: '',
  });
  const native = { ...base, launch: { kind: 'native', entry: 'native.mjs' }, data: { layout: 'xdg', schema: 1 } };
  const nativePlan = planBundleLaunch(native, { bundleRoot: one, platform: target, environment });
  writeFileSync(path.join(one, 'native.mjs'), `
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const directory = process.env.XDG_DATA_HOME;
mkdirSync(directory, { recursive: true });
const file = path.join(directory, 'native-data');
if (process.argv[2] === 'write') writeFileSync(file, 'native retained data');
else if (readFileSync(file, 'utf8') !== 'native retained data') throw new Error('Missing native data');
console.log(process.env.HOME);
`);
  for (const operation of ['write', 'read']) {
    const result = spawnSync(process.execPath, [nativePlan.argv[0], operation], { cwd: nativePlan.cwd,
      env: { ...environment, ...nativePlan.environmentOverrides }, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout.trim(), environment.HOME, 'native XDG adapter leaves HOME unchanged');
  }
  console.log('PASS: actual PollyUI data survives version/location changes, cache rebuild and logical user/app separation');
  console.log('PASS: XDG-compliant subprocess fixture uses independent appdata without changing HOME; not third-party qualification');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
