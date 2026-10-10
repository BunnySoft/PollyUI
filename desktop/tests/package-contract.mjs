import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installedInventory, requiredRuntimeFiles, sourceInventory, validateRuntimeContract,
  validateFrozenRuntime } from '../tools/package-contract.mjs';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const root = mkdtempSync(path.join(tmpdir(), 'polly-package-contract-'));
try {
  const stage = path.join(root, 'rootfs'), build = path.join(root, 'build');
  mkdirSync(build);
  const jsonName = 'usr/share/pollyui/desktop/config/test-typed-resource.json';
  const names = [...requiredRuntimeFiles, jsonName, 'usr/share/pollyui/desktop/resources/themes/default.json'];
  const sources = sourceInventory(repo);
  const installedSources = new Map();
  const files = names.map(name => {
    const source = name.startsWith('usr/share/pollyui/') ? name.slice('usr/share/pollyui/'.length) : null;
    const actual = sources.find(file => file.path === source);
    const bytes = actual ? readFileSync(path.join(repo, source)) : Buffer.from('contract-test-only');
    const file = path.join(stage, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    if (source) installedSources.set(source, digest(bytes));
    return { path: name, sha256: digest(bytes), size: bytes.length, mode: name.startsWith('usr/bin/') ? '0755' : '0644' };
  });
  for (const [name, sha256] of installedSources) {
    if (!sources.some(file => file.path === name)) sources.push({ path: name, sha256 });
  }
  sources.sort((a, b) => a.path.localeCompare(b.path));
  writeFileSync(path.join(build, 'install_manifest_PollyDesktop.txt'), names.map(name => '/' + name).join('\n'));
  const installFiles = installedInventory(stage, build, sources);
  assert.ok(installFiles.some(file => file.path === jsonName && file.source.endsWith('.json')),
    'Actual CMake inventory includes typed JSON without naming production configuration modules');
  const inputs = { sourceFiles: sources, build: { strategy: 'reconfigure-clean-first',
    sourceSha256Before: digest(JSON.stringify(sources)), sourceSha256After: digest(JSON.stringify(sources)),
    revisionSource: 'external-label' } };
  const libraries = [
    { binary: 'usr/bin/pollyui', soname: 'libffi.so.8', package: 'libffi8:amd64', version: '3.4.8', usage: 'elf-link' },
    { binary: 'usr/bin/pollyui', soname: 'libdbus-1.so.3', package: 'libdbus-1-3:amd64', version: '1.16.2', usage: 'elf-link' },
    { binary: 'usr/share/pollyui/desktop/shared/file-system.mjs', soname: 'libcrypto.so.3',
      package: 'libssl3t64:amd64', version: '3.5.7', usage: 'js-dlopen', symbol: 'SHA256',
      resolvedFile: '/usr/lib/libcrypto.so.3', sha256: digest('test-only-library') },
    { binary: 'usr/share/pollyui/sysrt/bindings/dbus.mjs', soname: 'libdbus-1.so.3',
      package: 'libdbus-1-3:amd64', version: '1.16.2', usage: 'js-dlopen', symbol: 'dbus_connection_open_private',
      resolvedFile: '/usr/lib/libdbus-1.so.3', sha256: digest('test-only-library') },
  ];
  const packages = [...new Set(libraries.map(file => file.package + '=' + file.version))].join('\n') + '\n';
  const sbom = { packages: libraries.map(file => ({ name: file.package, versionInfo: file.version })) };
  const manifest = { files, runtimeContract: { schemaVersion: 1, kind: 'gui-sysrt-js', installFiles, postprocess: [],
    bundledLibraries: [{ binary: 'usr/bin/pollyui', soname: 'libSDL3.so.0', path: 'usr/lib/pollyui/libSDL3.so.0',
      sha256: files.find(file => file.path.endsWith('/libSDL3.so.0')).sha256 }],
    nativeLibraries: libraries, abi: { path: 'usr/share/pollyui/sysrt/bindings/generated/files-linux-x86_64.mjs',
      sha256: files.find(file => file.path.endsWith('/generated/files-linux-x86_64.mjs')).sha256,
      target: 'linux-x86_64-lp64', verified: true } } };
  const check = (candidate = manifest, provenance = inputs, pins = packages, inventory = sbom) =>
    validateRuntimeContract(candidate, provenance, pins, inventory);
  check();
  assert.throws(() => check({ files }), /legacy packages/);
  for (const name of ['usr/share/pollyui/sysrt/sdk/js/files.mjs', 'usr/bin/polly-settings', jsonName]) {
    assert.throws(() => check({ ...manifest, files: files.filter(file => file.path !== name) }), /missing or changed/);
  }
  assert.throws(() => check({ ...manifest, runtimeContract: { ...manifest.runtimeContract,
    installFiles: installFiles.filter(file => file.path !== 'usr/bin/polly-settings') } }), /Missing new runtime file/);
  assert.throws(() => check({ ...manifest, files: [...files,
    { path: 'usr/share/pollyui/sysrt/tests/nativeffi-oracle.mjs' }] }), /Test-only payload/);
  assert.throws(() => check({ ...manifest, runtimeContract: { ...manifest.runtimeContract,
    installFiles: [...installFiles, installFiles[0]] } }), /duplicate CMake/);
  assert.throws(() => check({ ...manifest, runtimeContract: { ...manifest.runtimeContract,
    abi: { ...manifest.runtimeContract.abi, target: 'windows-x64' } } }), /ABI check/);
  for (const soname of ['libffi.so.8', 'libdbus-1.so.3']) {
    assert.throws(() => check({ ...manifest, runtimeContract: { ...manifest.runtimeContract,
      nativeLibraries: libraries.filter(file => file.soname !== soname) } }), /not resolved by ldd/);
  }
  assert.throws(() => check({ ...manifest, runtimeContract: { ...manifest.runtimeContract,
    nativeLibraries: libraries.filter(file => file.soname !== 'libcrypto.so.3') } }), /explicitly resolved/);
  assert.throws(() => check({ ...manifest, runtimeContract: { ...manifest.runtimeContract,
    nativeLibraries: libraries.filter(file => file.usage !== 'js-dlopen') } }), /explicitly resolved/);
  assert.throws(() => check({ ...manifest, runtimeContract: { ...manifest.runtimeContract,
    bundledLibraries: [] } }), /outside the relocated package/);
  assert.throws(() => check({ ...manifest, runtimeContract: { ...manifest.runtimeContract,
    bundledLibraries: [{ ...manifest.runtimeContract.bundledLibraries[0], path: '../sdk/libSDL3.so.0' }] } }),
  /Bundled loader path/);
  const original = files.find(file => file.path === 'usr/bin/pollywm');
  const processed = { path: original.path, tool: 'patchelf', rpath: '$ORIGIN/../lib/pollyui',
    before: { sha256: original.sha256, size: original.size },
    after: { sha256: digest('relocated-test-ELF'), size: 18 } };
  const relocated = { ...manifest, files: files.map(file => file.path === original.path ? { ...file, ...processed.after } : file),
    runtimeContract: { ...manifest.runtimeContract, postprocess: [processed] } };
  check(relocated);
  assert.throws(() => check({ ...relocated, runtimeContract: { ...relocated.runtimeContract,
    postprocess: [{ ...processed, before: { ...processed.before, sha256: '0'.repeat(64) } }] } }), /original CMake/);
  assert.throws(() => check({ ...relocated, runtimeContract: { ...relocated.runtimeContract,
    postprocess: [{ ...processed, after: { ...processed.after, sha256: '0'.repeat(64) } }] } }), /final payload/);
  assert.throws(() => check(manifest, inputs, 'unrelated=1\n'), /pins\/SBOM/);
  assert.throws(() => check(manifest, inputs, packages, { packages: [] }), /pins\/SBOM/);
  assert.throws(() => check(manifest, { ...inputs, build: { ...inputs.build, strategy: 'reuse-old-build' } }), /rebuild evidence/);
  assert.throws(() => check(manifest, { ...inputs, build: { ...inputs.build, sourceSha256After: '0'.repeat(64) } }),
    /Source changed/);
  assert.throws(() => check(manifest, { ...inputs, sourceFiles: sources.slice(1) }), /does not match rebuild/);
  const frozenManifest = { ...manifest, revision: 'b'.repeat(40), dirty: false };
  const frozenInputs = { ...inputs, revision: frozenManifest.revision, build: { ...inputs.build, revisionSource: 'git' } };
  validateFrozenRuntime(frozenManifest, frozenInputs);
  assert.throws(() => validateFrozenRuntime({ ...frozenManifest, dirty: true }, frozenInputs), /actually clean/);
  assert.throws(() => validateFrozenRuntime(frozenManifest, { ...frozenInputs, build: inputs.build }), /External revision labels/);
  assert.throws(() => validateFrozenRuntime(frozenManifest, { ...frozenInputs, revision: 'a'.repeat(40) }), /revision differs/);
  const stale = files.map(file => file.path === jsonName ? { ...file, sha256: '0'.repeat(64) } : file);
  assert.throws(() => check({ ...manifest, files: stale }), /missing or changed/);
  writeFileSync(path.join(stage, jsonName), 'stale installed configuration');
  assert.throws(() => installedInventory(stage, build, sources), /differs from source/);
  writeFileSync(path.join(stage, jsonName), 'contract-test-only');
  writeFileSync(path.join(build, 'install_manifest_PollyDesktop.txt'), names.map(name => '/' + name).join('\n') +
    '\n/usr/share/pollyui/../escape.json');
  assert.throws(() => installedInventory(stage, build, sources), /Invalid CMake install path/);
  console.log('PASS: synthetic package contract rejects legacy/stale/missing runtime, JSON, ABI, dependency and rebuild evidence');
  if (process.argv[2] === '--packaging-cli') {
    assert.equal(process.platform, 'linux', 'Packaging CLI failures require the isolated Linux SDK');
    const git = spawnSync('git', ['-c', 'safe.directory=' + repo, 'rev-parse', 'HEAD'],
      { cwd: repo, encoding: 'utf8' });
    const revision = git.status === 0 ? git.stdout.trim() : 'a'.repeat(40);
    const environment = { ...process.env, POLLY_SOURCE_REVISION: revision, POLLY_SOURCE_DIRTY: '1' };
    const run = (cache, message) => {
      writeFileSync(path.join(build, 'CMakeCache.txt'), cache);
      const output = path.join(root, 'refused-candidate');
      const result = spawnSync(process.execPath, [path.join(repo, 'desktop/tools/package-linux.mjs'),
        build, output, '/unused-sdl', '/unused-harfbuzz'], {
        cwd: repo, env: environment, encoding: 'utf8', timeout: 20000,
      });
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, message);
      assert.ok(!existsSync(output), 'Rejected preflight must not publish a package');
    };
    run('CMAKE_HOME_DIRECTORY:INTERNAL=/different-checkout\n', /different source checkout/);
    run('CMAKE_HOME_DIRECTORY:INTERNAL=' + repo + '\nCMAKE_C_FLAGS:STRING=-fsanitize=address\n', /non-sanitized/);
    run('CMAKE_HOME_DIRECTORY:INTERNAL=' + repo + '\nCMAKE_SHARED_LINKER_FLAGS:STRING=-fsanitize=undefined\n',
      /non-sanitized/);
    run('CMAKE_HOME_DIRECTORY:INTERNAL=' + repo + '\nPU_BUILD_LAUNCHER:BOOL=OFF\n', /PU_BUILD_LAUNCHER=ON/);
    console.log('PASS: actual packaging CLI fails before building/publishing wrong-checkout, sanitized and GUI-only caches');
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
