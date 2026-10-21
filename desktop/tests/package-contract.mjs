import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installedInventory, requiredRuntimeFiles, runtimeSource, sourceInventory, validateRuntimeContract,
  validateFrozenRuntime, validateStandardEffectsRuntime } from '../tools/package-contract.mjs';

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
    const source = runtimeSource(name);
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
  const videoRecipe = JSON.parse(readFileSync(path.join(repo, 'desktop/release/debian/video-codecs.json'), 'utf8'));
  const videoBuildInfo = { schemaVersion: 1, ffmpegVersion: videoRecipe.version, license: videoRecipe.license,
    network: false, audio: false, decoders: videoRecipe.decoders, demuxers: videoRecipe.demuxers };
  const videoRecord = { ...videoRecipe, buildInfo: videoBuildInfo,
    sourceArchiveSha256: digest('fixture-source-archive'), configureSha256: digest('fixture-build-arguments') };
  const videoHelper = { path: 'usr/lib/pollyui/polly-video-decoder', mode: '0755', size: 32, sha256: digest('fixture-decoder') };
  const videoLibraries = [['avformat', 63], ['avcodec', 63], ['avutil', 61], ['swscale', 10]].map(([name, abi]) =>
    ({ path: `usr/lib/pollyui/video/lib${name}.so.${abi}`, size: 16, sha256: digest('fixture-' + name) }));
  const videoNoticeRoot = 'usr/share/licenses/pollyui/pollyui-video-codecs/';
  const videoNotices = ['COPYING.LGPLv2.1', 'LICENSE.md', 'README.md', 'video-codecs.json',
    videoRecipe.archive, videoRecipe.archive + '.asc', 'ffmpeg-devel.asc', 'configure-arguments.json'].map(name =>
    ({ path: videoNoticeRoot + name, size: 16, sha256: name === 'video-codecs.json' ?
      inputs.sourceFiles.find(file => file.path === 'desktop/release/debian/video-codecs.json').sha256 :
      name === videoRecipe.archive ? videoRecord.sourceArchiveSha256 :
        name === 'configure-arguments.json' ? videoRecord.configureSha256 : digest(name) }));
  const videoFiles = [videoHelper, ...videoLibraries, ...videoNotices];
  const videoManifest = { ...manifest, files: [...files, ...videoFiles],
    runtimeContract: { ...manifest.runtimeContract, videoCodecs: videoRecord,
      installFiles: [...installFiles, ...videoFiles],
      bundledLibraries: [...manifest.runtimeContract.bundledLibraries, ...videoLibraries.map(library =>
        ({ binary: videoHelper.path, soname: path.posix.basename(library.path), path: library.path, sha256: library.sha256 }))] } };
  const videoSbom = { packages: [...sbom.packages, { name: 'FFmpeg-local-video', versionInfo: videoRecipe.version,
    licenseDeclared: videoRecipe.license, sourceInfo: 'Official release SHA-512: ' + videoRecipe.sha512 }] };
  check(videoManifest, inputs, packages, videoSbom);
  const standardInputs = { ...inputs, configuration: { PU_DESKTOP_VIDEO: 'ON', wlrootsGles2: 'true' } };
  const standardManifest = { ...videoManifest,
    runtimeContract: { ...videoManifest.runtimeContract, wlrootsEffects: { abi: 4 } } };
  validateStandardEffectsRuntime(standardManifest, standardInputs, sources);
  for (const configuration of [{ PU_DESKTOP_VIDEO: 'OFF', wlrootsGles2: 'true' },
    { PU_DESKTOP_VIDEO: 'ON', wlrootsGles2: 'false' }, {}])
    assert.throws(() => validateStandardEffectsRuntime(standardManifest, { ...inputs, configuration }, sources),
      /Standard requires the complete/);
  assert.throws(() => validateStandardEffectsRuntime(standardManifest, standardInputs, sources.slice(1)),
    /exact current source/);
  assert.throws(() => validateStandardEffectsRuntime({ ...standardManifest,
    runtimeContract: { ...standardManifest.runtimeContract, installFiles: installFiles } }, standardInputs, sources),
  /Standard desktop-effects payload/);
  assert.throws(() => check({ ...videoManifest, runtimeContract: { ...videoManifest.runtimeContract,
    videoCodecs: undefined } }, inputs, packages, videoSbom), /local-video source\/license/);
  for (const patch of [{ gpl: true }, { network: true }, { audio: true }, { license: 'GPL-3.0-only' }])
    assert.throws(() => check({ ...videoManifest, runtimeContract: { ...videoManifest.runtimeContract,
      videoCodecs: { ...videoRecord, ...patch } } }, inputs, packages, videoSbom), /local-video source\/license/);
  assert.throws(() => check({ ...videoManifest, runtimeContract: { ...videoManifest.runtimeContract,
    videoCodecs: { ...videoRecord, buildInfo: { ...videoBuildInfo, network: true } } } }, inputs, packages, videoSbom),
  /local-video capabilities/);
  assert.throws(() => check(videoManifest, inputs, packages, sbom), /Local-video SBOM/);
  assert.throws(() => check({ files }), /legacy packages/);
  for (const name of ['usr/share/pollyui/sysrt/sdk/js/files.mjs', 'usr/bin/polly-settings',
    'usr/share/pollyui/desktop/shell/desktop-shortcuts.mjs',
    'usr/share/pollyui/desktop/shell/desktop-interactions.mjs',
    'usr/share/pollyui/desktop/shell/desktop-view.mjs',
    'usr/share/pollyui/desktop/shell/desktop-icon-resources.mjs', jsonName,
    'usr/share/icons/PollyRabbit/cursors/motion', 'usr/share/icons/PollyClassic/cursors/text']) {
    assert.throws(() => check({ ...manifest, files: files.filter(file => file.path !== name) }), /missing or changed/);
  }
  assert.throws(() => check({ ...manifest, runtimeContract: { ...manifest.runtimeContract,
    installFiles: installFiles.filter(file => file.path !== 'usr/bin/polly-settings') } }), /Missing new runtime file/);
  assert.throws(() => check({ ...manifest, runtimeContract: { ...manifest.runtimeContract,
    installFiles: installFiles.filter(file => file.path !== 'usr/share/icons/PollyRabbit/cursors/default') } }),
  /Missing new runtime file/);
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
  const effects = JSON.parse(readFileSync(path.join(repo, 'desktop/release/debian/wlroots-effects.json'), 'utf8'));
  const privateLibrary = { path: 'usr/lib/pollyui/libwlroots-0.19-polly-effects4.so',
    sha256: digest('private-wlroots-effects-library'), size: 32 };
  const privateInput = { path: 'usr/lib/pollyui/libinput.so.10', sha256: digest('private-input'), size: 16 };
  const notices = ['wlroots-scene-effects.patch', 'wlroots-effects.json', 'apply-wlroots-effects.py'].map(name =>
    ({ path: 'usr/share/licenses/pollyui/wlroots/' + name, sha256: digest(name), size: name.length }));
  const privateRelocation = { path: privateLibrary.path, tool: 'patchelf', rpath: '$ORIGIN',
    before: { sha256: digest('unrelocated-effects-library'), size: 30 }, after: privateLibrary };
  const debian = { ...relocated, debian: true,
    files: [...relocated.files, privateLibrary, privateInput, ...notices],
    runtimeContract: { ...relocated.runtimeContract, wlrootsEffects: effects,
      postprocess: [...relocated.runtimeContract.postprocess, privateRelocation],
      bundledLibraries: [...relocated.runtimeContract.bundledLibraries,
        { binary: 'usr/bin/pollywm', soname: 'libwlroots-0.19-polly-effects4.so',
          path: privateLibrary.path, sha256: privateLibrary.sha256 },
        { binary: 'usr/bin/pollywm', soname: 'libinput.so.10', path: privateInput.path, sha256: privateInput.sha256 }] } };
  const privateSbom = { packages: [...sbom.packages, { name: 'wlroots', versionInfo: effects.version,
    licenseComments: `Pinned scene effects patch; ABI ${effects.abi}.`,
    sourceInfo: `PollyUI wlroots patch SHA-256: ${effects.patchSha256}; effects ABI ${effects.abi}.` }] };
  check(debian, inputs, packages, privateSbom);
  assert.throws(() => check({ ...debian, runtimeContract: { ...debian.runtimeContract,
    wlrootsEffects: { ...effects, abi: 3, version: '0.19.3-polly-effects3' } } },
  inputs, packages, privateSbom), /scene-effects identity/);
  assert.throws(() => check({ ...debian, runtimeContract: { ...debian.runtimeContract,
    wlrootsEffects: undefined } }, inputs, packages, privateSbom), /scene-effects identity/);
  assert.throws(() => check({ ...debian, runtimeContract: { ...debian.runtimeContract,
    wlrootsEffects: { ...effects, patchSha256: '0'.repeat(64) } } }, inputs, packages, privateSbom),
  /patch differs from build inputs/);
  assert.throws(() => check({ ...debian, files: debian.files.filter(file => file.path !== notices[0].path) },
    inputs, packages, privateSbom), /scene-effects source/);
  assert.throws(() => check(debian, inputs, packages, sbom), /scene-effects SBOM/);
  assert.throws(() => check(debian, inputs, packages, { packages: privateSbom.packages.map(pkg =>
    pkg.name === 'wlroots' ? { ...pkg, licenseComments: 'Pinned scene effects patch; ABI 3.' } : pkg) }),
  /scene-effects SBOM/);
  assert.throws(() => check(debian, inputs, packages, { packages: privateSbom.packages.map(pkg =>
    pkg.name === 'wlroots' ? { ...pkg, sourceInfo: 'stale patch identity' } : pkg) }), /scene-effects SBOM/);
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
