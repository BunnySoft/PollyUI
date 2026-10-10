import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { validateRuntimeContract, validateFrozenRuntime, hashFile } from '../tools/package-contract.mjs';

const root = path.resolve(process.argv[2]);
execFileSync('python3', ['desktop/tests/package-modes.py', root], { stdio: 'inherit' });
const read = name => readFileSync(path.join(root, name), 'utf8');
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const manifest = JSON.parse(read('manifest.json'));
assert.ok(existsSync(path.join(root, 'build-inputs.json')), 'Missing build provenance');
let inputs;
{
  inputs = JSON.parse(read('build-inputs.json'));
  assert.equal(inputs.schemaVersion, 1);
  assert.equal(inputs.revision, manifest.revision);
  assert.equal(inputs.dirty, manifest.dirty);
  assert.ok(inputs.recipes.length > 5 && inputs.dependencies.length === 3);
  for (const item of inputs.recipes) assert.match(item.sha256, /^[0-9a-f]{64}$/);
  for (const item of inputs.dependencies) {
    assert.match(item.revision, /^[0-9a-f]{40}$/);
    assert.match(item.trackedDiffSha256, /^[0-9a-f]{64}$/);
  }
}
assert.equal(manifest.bootable, false);
assert.equal(manifest.stage, 'development-runtime-bundle');
assert.match(manifest.revision, /^[0-9a-f]{40}$/);
assert.equal(typeof manifest.dirty, 'boolean');
assert.ok(manifest.files.length > 30);
for (const file of manifest.files) {
  assert.ok(!path.isAbsolute(file.path) && !file.path.split('/').includes('..'));
  const payload = path.join(root, 'rootfs', file.path);
  assert.equal(statSync(payload).size, file.size, file.path);
  assert.equal(digest(payload), file.sha256, file.path);
}
for (const relative of [
  'usr/lib/pollyui/install-targets/install/readonly-helper.py',
  'usr/lib/pollyui/install-targets/install/targets.py',
  'usr/lib/pollyui/install-targets/storage/layout.py',
  'usr/lib/pollyui/install-targets/maintenance/payload.py',
]) {
  const record = manifest.files.find(file => file.path === relative);
  assert.ok(record, 'Missing fixed readonly helper dependency: ' + relative);
  assert.equal(record.mode, '0644', relative);
}
assert.ok(!manifest.files.some(file => file.path.startsWith('usr/lib/pollyui/install-targets/') &&
  file.path.includes('fixture')), 'Test helper/provider must not enter runtime packaging');
assert.ok(!manifest.files.some(file => file.path === 'usr/share/pollyui/install-targets/source.json'),
  'No production source receipt is qualified by this package generator');
for (const line of read('SHA256SUMS').trim().split('\n')) {
  const match = line.match(/^([0-9a-f]{64})  ([A-Za-z0-9._-]+)$/);
  assert.ok(match, line);
  assert.equal(digest(path.join(root, match[2])), match[1], match[2]);
}
const packages = read('runtime-packages.txt');
for (const name of manifest.debian ? ['libwayland-egl1', 'libegl-mesa0', 'libgl1', 'libgles2', 'pipewire-bin', 'rime-data-luna-pinyin',
  'file', 'libmagic1t64', 'libmagic-mgc', 'python3'] :
  ['wayland-libs-egl', 'mesa-gl', 'mesa-gles', 'pipewire', 'rime-plum-data', 'file', 'python3', 'libcrypto3'])
  assert.ok(packages.split('\n').some(line => line.split('=')[0].split(':')[0] === name), name);
for (const line of packages.trim().split('\n'))
  assert.match(line, /^[a-z0-9][a-z0-9+_.-]*(?::[a-z0-9-]+)?=[A-Za-z0-9._+~:-]+$/);
const sbom = JSON.parse(read('sbom.spdx.json'));
validateRuntimeContract(manifest, inputs, packages, sbom);
if (process.argv[3] === '--frozen') validateFrozenRuntime(manifest, inputs);
for (const file of manifest.runtimeContract.installFiles) {
  const change = manifest.runtimeContract.postprocess.find(item => item.path === file.path);
  assert.equal(hashFile(path.join(root, 'rootfs', file.path)), change?.after.sha256 || file.sha256, file.path);
}
assert.equal(sbom.spdxVersion, 'SPDX-2.3');
assert.match(sbom.creationInfo.created, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
const ids = new Set([sbom.SPDXID, ...sbom.packages.map(pkg => pkg.SPDXID)]);
assert.equal(ids.size, sbom.packages.length + 1);
for (const relationship of sbom.relationships)
  assert.ok(ids.has(relationship.spdxElementId) && ids.has(relationship.relatedSpdxElement));
const before = digest(path.join(root, 'manifest.json'));
const refused = spawnSync(process.execPath, ['desktop/tools/package-linux.mjs', '/unused-build',
  root, '/unused-sdl', '/unused-harfbuzz'], { encoding: 'utf8' });
assert.notEqual(refused.status, 0);
assert.match(refused.stderr, /Refusing to overwrite/);
assert.equal(digest(path.join(root, 'manifest.json')), before);
console.log('PASS: new runtime CMake inventory, source/rebuild/ABI provenance, native pins/SBOM, payload hashes and overwrite guard');
