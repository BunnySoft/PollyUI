import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export const requiredRuntimeFiles = [
  'usr/bin/pollyui', 'usr/bin/pollywm', 'usr/bin/pollyui-app-launcher', 'usr/bin/polly-app',
  'usr/bin/polly-desktop', 'usr/bin/polly-settings', 'usr/share/applications/polly-settings.desktop',
  'usr/bin/polly-processes', 'usr/share/applications/polly-processes.desktop',
  'usr/lib/pollyui/libSDL3.so.0',
  'usr/share/pollyui/desktop/resources/icons/cursor-manifest.json',
  ...['PollyRabbit', 'PollyClassic'].flatMap(theme => [
    'usr/share/icons/' + theme + '/index.theme',
    ...('default context-menu help pointer progress wait cell crosshair text vertical-text alias copy move ' +
      'no-drop not-allowed grab grabbing e-resize n-resize ne-resize nw-resize s-resize se-resize sw-resize ' +
      'w-resize ew-resize ns-resize nesw-resize nwse-resize col-resize row-resize all-scroll zoom-in zoom-out ' +
      (theme === 'PollyRabbit' ? 'motion press click drag drag-copy drag-move drag-no-drop' : ''))
      .trim().split(/\s+/).map(name => 'usr/share/icons/' + theme + '/cursors/' + name),
  ]),
  ...[
    'desktop/launcher/services.mjs', 'desktop/client/settings.mjs', 'desktop/client/settings-contract.mjs',
    'desktop/shared/settings-environment.mjs', 'desktop/shared/file-system.mjs',
    'desktop/shared/native-files.mjs', 'desktop/shared/theme-resources.mjs',
    'desktop/shell/desktop-shortcuts.mjs', 'desktop/shell/desktop-interactions.mjs',
    'desktop/shell/desktop-view.mjs', 'desktop/shell/desktop-icon-resources.mjs',
    'desktop/shell/companion.mjs', 'desktop/shared/ui/companion.mjs',
    'desktop/shared/ui/animation.mjs', 'desktop/shared/ui/procedural-wallpaper.mjs',
    'desktop/shared/ui/video-wallpaper.mjs', 'desktop/shared/ui/workspace-cube.mjs',
    'desktop/shared/ui/window-switcher.mjs', 'desktop/shell/video-wallpaper.mjs',
    'desktop/resources/companions/polly-rabbit.mjs', 'desktop/resources/companions/polly-rabbit.png',
    'desktop/apps/settings/main.mjs', 'desktop/apps/settings/runtime.mjs',
    'desktop/apps/settings/app.mjs', 'desktop/apps/settings/logic/controller.mjs',
    'desktop/apps/settings/network-client.mjs', 'desktop/client/settings-network-contract.mjs',
    'desktop/client/settings-domains-contract.mjs', 'desktop/apps/settings/logic/pages.mjs',
    'desktop/apps/settings/ui/appearance.mjs', 'desktop/apps/settings/ui/frame.mjs',
    'desktop/apps/settings/ui/displays.mjs', 'desktop/apps/settings/ui/display-inputs.mjs',
    'desktop/apps/settings/ui/display-page.mjs', 'desktop/apps/settings/ui/audio.mjs',
    'desktop/apps/settings/ui/keyboard.mjs', 'desktop/apps/settings/ui/network.mjs',
    'desktop/shell/audio-policy.mjs', 'desktop/shell/settings-domains.mjs', 'desktop/shell/shortcut-recorder.mjs',
    'desktop/shared/shortcuts.mjs',
    ...['themes', 'theme-schema', 'theme-layout', 'luna-primitives', 'presentation', 'button', 'wallpaper']
      .map(name => 'desktop/shared/ui/' + name + '.mjs'),
    'desktop/apps/processes/main.mjs', 'desktop/apps/processes/app.mjs',
    'desktop/apps/processes/logic/model.mjs', 'desktop/apps/processes/logic/controller.mjs',
    'desktop/apps/processes/logic/native-provider.mjs',
    'sysrt/sdk/js/native.mjs', 'sysrt/sdk/js/memory.mjs', 'sysrt/sdk/js/encoding.mjs',
    'sysrt/sdk/js/clock.mjs', 'sysrt/sdk/js/files.mjs', 'sysrt/sdk/js/dbus.mjs',
    'sysrt/sdk/js/process.mjs', 'sysrt/sdk/js/network.mjs',
    'sysrt/bindings/files.mjs', 'sysrt/bindings/dbus.mjs',
    'sysrt/bindings/generated/files-linux-x86_64.mjs',
  ].map(name => 'usr/share/pollyui/' + name),
];
export const hashFile = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const relative = name => typeof name === 'string' && name.length > 0 &&
  !/[\\:\u0000-\u001f]/.test(name) && !name.split('/').some(part => !part || part === '.' || part === '..');
const hashPattern = /^[0-9a-f]{64}$/;

export function runtimeSource(name) {
  if (name.startsWith('usr/share/pollyui/')) return name.slice('usr/share/pollyui/'.length);
  if (/^usr\/share\/icons\/Polly(?:Rabbit|Classic)\//.test(name))
    return 'desktop/resources/icons/' + name.slice('usr/share/icons/'.length);
  return null;
}

export function sourceInventory(repo) {
  const files = [];
  function visit(name) {
    const file = path.join(repo, name), info = lstatSync(file);
    if (info.isDirectory()) {
      for (const child of readdirSync(file).sort()) {
        if (['.git', '__pycache__', 'node_modules'].includes(child)) continue;
        visit(path.posix.join(name, child));
      }
    } else {
      assert.ok(info.isFile(), 'Non-regular source input: ' + name);
      files.push({ path: name, sha256: hashFile(file) });
    }
  }
  for (const name of ['CMakeLists.txt', 'tools/build.sh', 'desktop', 'gui', 'shared', 'sysrt',
    'third_party/quickjs', 'third_party/yoga']) visit(name);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function installedInventory(root, build, sources) {
  const sourceHashes = new Map(sources.map(file => [file.path, file.sha256]));
  const names = readFileSync(path.join(build, 'install_manifest_PollyDesktop.txt'), 'utf8')
    .trim().split('\n').map(name => name.startsWith(root + '/') ? name.slice(root.length + 1) : name.replace(/^\//, ''));
  assert.ok(names.length > 30, 'Missing CMake PollyDesktop install inventory');
  assert.equal(new Set(names).size, names.length, 'Duplicate CMake install path');
  return names.sort().map(name => {
    assert.ok(relative(name) && name.startsWith('usr/'), 'Invalid CMake install path: ' + name);
    const file = path.join(root, name), info = lstatSync(file);
    assert.ok(info.isFile(), 'Missing regular CMake-installed payload: ' + name);
    const sha256 = hashFile(file);
    const source = runtimeSource(name);
    if (source && sourceHashes.has(source)) {
      assert.equal(sha256, sourceHashes.get(source), 'Installed resource differs from source: ' + source);
    }
    return { path: name, size: info.size, sha256,
      ...(source && sourceHashes.has(source) ? { source } : {}) };
  });
}

export function validateStandardEffectsRuntime(manifest, inputs, sources) {
  assert.ok(inputs?.configuration?.PU_DESKTOP_VIDEO === 'ON' &&
    inputs.configuration.wlrootsGles2 === 'true' && manifest.runtimeContract?.videoCodecs?.buildInfo &&
    manifest.runtimeContract?.wlrootsEffects?.abi === 4,
  'Standard requires the complete paired GLES desktop-effects runtime with native local-video decoding');
  assert.ok(Array.isArray(sources) && createHash('sha256').update(JSON.stringify(sources)).digest('hex') ===
    inputs.build?.sourceSha256Before, 'Standard effects runtime must match the exact current source byte inventory');
  const installed = new Set(manifest.runtimeContract.installFiles.map(file => file.path));
  for (const name of ['usr/lib/pollyui/polly-video-decoder', ...requiredRuntimeFiles])
    assert.ok(installed.has(name), 'Standard desktop-effects payload is missing: ' + name);
  const names = new Set(inputs.sourceFiles.map(file => file.path));
  for (const name of ['desktop/compositor/workspace-cube.c', 'desktop/compositor/window-previews.c',
    'desktop/compositor/window-opacity.c', 'desktop/native/video-decoder.c',
    'desktop/native/video-client.c', 'desktop/protocols/polly-shortcuts-v1.xml'])
    assert.ok(names.has(name), 'Standard desktop-effects source input is missing: ' + name);
}

export function validateRuntimeContract(manifest, inputs, packages, sbom) {
  const contract = manifest.runtimeContract;
  assert.ok(contract?.schemaVersion === 1 && contract.kind === 'gui-sysrt-js',
    'Missing new-architecture runtime contract (legacy packages are not candidates)');
  assert.equal(inputs?.build?.strategy, 'reconfigure-clean-first', 'Missing actual runtime rebuild evidence');
  assert.equal(inputs.build.sourceSha256Before, inputs.build.sourceSha256After,
    'Source changed during runtime rebuild');
  assert.match(inputs.build.sourceSha256Before, hashPattern);
  assert.ok(Array.isArray(inputs.sourceFiles) && inputs.sourceFiles.length > 30, 'Missing source byte inventory');
  const sourceNames = new Set();
  for (const file of inputs.sourceFiles) {
    assert.ok(relative(file.path) && !sourceNames.has(file.path) && hashPattern.test(file.sha256),
      'Invalid source byte inventory');
    sourceNames.add(file.path);
  }
  assert.equal(createHash('sha256').update(JSON.stringify(inputs.sourceFiles)).digest('hex'),
    inputs.build.sourceSha256Before, 'Source byte inventory does not match rebuild evidence');
  for (const name of ['sysrt/CMakeLists.txt', 'sysrt/ffi/module.c', 'sysrt/tools/generate-files-abi.py',
    'desktop/launcher/main.c', 'desktop/launcher/services.mjs', 'desktop/install.cmake',
    'desktop/compositor/cursor.c', 'desktop/compositor/cursor.h',
    'desktop/tools/generate-cursors.py', 'desktop/resources/icons/cursor-manifest.json'])
    assert.ok(sourceNames.has(name), 'Missing runtime build input: ' + name);
  assert.ok(['git', 'external-label'].includes(inputs.build.revisionSource), 'Missing revision provenance type');
  const payload = new Map(manifest.files.map(file => [file.path, file]));
  const processed = new Map();
  assert.ok(Array.isArray(contract.postprocess), 'Missing explicit packaging postprocess inventory');
  for (const item of contract.postprocess) {
    const expected = { 'usr/bin/pollywm': '$ORIGIN/../lib/pollyui',
      'usr/lib/pollyui/libwlroots-0.19-polly-effects4.so': '$ORIGIN' };
    assert.ok(!processed.has(item.path) && item.tool === 'patchelf' && expected[item.path] === item.rpath &&
      hashPattern.test(item.before?.sha256) && Number.isSafeInteger(item.before?.size),
    'Invalid private ELF postprocess receipt');
    const actual = payload.get(item.path);
    assert.ok(actual && item.after?.sha256 === actual.sha256 && item.after?.size === actual.size,
      'Postprocessed ELF bytes differ from final payload');
    processed.set(item.path, item);
  }
  const installed = new Map();
  assert.ok(Array.isArray(contract.installFiles) && contract.installFiles.length > 0, 'Missing actual CMake inventory');
  for (const file of contract.installFiles) {
    assert.ok(relative(file.path) && !installed.has(file.path), 'Invalid or duplicate CMake install path');
    const actual = payload.get(file.path);
    const change = processed.get(file.path);
    if (change) assert.ok(change.before.sha256 === file.sha256 && change.before.size === file.size,
      'Postprocess input differs from original CMake-installed bytes');
    const expected = change?.after || file;
    assert.ok(actual && actual.size === expected.size && actual.sha256 === expected.sha256,
      'CMake-installed file missing or changed in package: ' + file.path);
    if (file.source) assert.ok(inputs.sourceFiles.some(source =>
      source.path === file.source && source.sha256 === file.sha256),
    'Installed source bytes are not recorded: ' + file.path);
    installed.set(file.path, file);
  }
  for (const name of requiredRuntimeFiles) assert.ok(installed.has(name), 'Missing new runtime file: ' + name);
  for (const name of payload.keys()) assert.ok(!/(?:^|\/)(?:tests|fixtures|test-apps)(?:\/|$)|nativeffi-oracle/.test(name),
    'Test-only payload must not enter runtime package: ' + name);
  const abiPath = 'usr/share/pollyui/sysrt/bindings/generated/files-linux-x86_64.mjs';
  assert.deepEqual(contract.abi, { path: abiPath, sha256: payload.get(abiPath).sha256,
    target: 'linux-x86_64-lp64', verified: true }, 'Missing measured target ABI check');
  assert.ok(Array.isArray(contract.nativeLibraries), 'Missing native runtime dependency inventory');
  const pinned = new Set(packages.trim().split('\n'));
  const listed = new Set(sbom.packages.map(pkg => pkg.name + '=' + pkg.versionInfo));
  for (const library of contract.nativeLibraries) {
    assert.ok(payload.has(library.binary) && typeof library.soname === 'string' &&
      ['elf-link', 'js-dlopen'].includes(library.usage) &&
      /^[a-z0-9][a-z0-9+_.-]*(?::[a-z0-9-]+)?$/.test(library.package) &&
      /^[A-Za-z0-9._+~:-]+$/.test(library.version), 'Invalid native dependency record');
    const pin = library.package + '=' + library.version;
    assert.ok(pinned.has(pin) && listed.has(pin), 'Native library owner missing from pins/SBOM: ' + pin);
    if (library.usage === 'js-dlopen') assert.ok(path.posix.isAbsolute(library.resolvedFile) &&
      hashPattern.test(library.sha256) && typeof library.symbol === 'string', 'Missing loaded JS library byte identity');
  }
  for (const expression of [/^libffi\.so\./, /^libdbus-1\.so\./]) {
    assert.ok(contract.nativeLibraries.some(library =>
      library.binary === 'usr/bin/pollyui' && expression.test(library.soname)),
    'New runtime dependency not resolved by ldd: ' + expression);
  }
  for (const [source, soname] of [
    ['desktop/shared/file-system.mjs', 'libcrypto.so.3'], ['sysrt/bindings/dbus.mjs', 'libdbus-1.so.3'],
  ]) {
    assert.ok(contract.nativeLibraries.some(library => library.binary === 'usr/share/pollyui/' + source &&
      library.soname === soname && library.usage === 'js-dlopen'),
    'JS dynamic library owner not explicitly resolved: ' + soname);
  }
  assert.ok(Array.isArray(contract.bundledLibraries), 'Missing relocated bundled library inventory');
  for (const library of contract.bundledLibraries) {
    assert.ok(payload.has(library.binary) && relative(library.path) &&
      payload.get(library.path)?.sha256 === library.sha256, 'Bundled loader path/hash differs from payload');
  }
  for (const [binary, soname] of [
    ['usr/bin/pollyui', 'libSDL3.so.0'],
    ...(manifest.debian ? [['usr/bin/pollywm', 'libwlroots-0.19-polly-effects4.so'], ['usr/bin/pollywm', 'libinput.so.10']] : []),
  ]) assert.ok(contract.bundledLibraries.some(library => library.binary === binary && library.soname === soname),
    'Runtime resolves a required bundled library outside the relocated package: ' + soname);
  const videoHelper = 'usr/lib/pollyui/polly-video-decoder';
  if (contract.videoCodecs || payload.has(videoHelper)) {
    const video = contract.videoCodecs;
    assert.ok(video?.schemaVersion === 1 && video.name === 'ffmpeg' && video.version === '9.0.2' &&
      video.license === 'LGPL-2.1-or-later' && video.gpl === false && video.nonfree === false &&
      video.network === false && video.audio === false && video.hardwareAcceleration === false &&
      /^[0-9a-f]{128}$/.test(video.sha512) && hashPattern.test(video.sourceArchiveSha256) &&
      hashPattern.test(video.configureSha256), 'Missing admitted local-video source/license identity');
    assert.deepEqual(video.decoders, ['h264', 'vp8', 'vp9'], 'Unexpected local-video decoder inventory');
    assert.deepEqual(video.demuxers, ['mov', 'matroska'], 'Unexpected local-video demuxer inventory');
    assert.deepEqual(video.buildInfo, { schemaVersion: 1, ffmpegVersion: video.version,
      license: video.license, network: false, audio: false, decoders: video.decoders, demuxers: video.demuxers },
    'Installed local-video capabilities differ from the admitted recipe');
    assert.ok(installed.has(videoHelper) && payload.get(videoHelper)?.mode === '0755',
      'Native local-video helper is missing or not executable');
    const notice = 'usr/share/licenses/pollyui/pollyui-video-codecs/';
    for (const name of ['COPYING.LGPLv2.1', 'LICENSE.md', 'README.md', 'video-codecs.json',
      video.archive, video.archive + '.asc', 'ffmpeg-devel.asc', 'configure-arguments.json'])
      assert.ok(payload.has(notice + name), 'Missing local-video source/license input: ' + name);
    assert.equal(payload.get(notice + video.archive).sha256, video.sourceArchiveSha256,
      'Local-video source archive differs from its retained identity');
    assert.equal(payload.get(notice + 'configure-arguments.json').sha256, video.configureSha256,
      'Local-video configure arguments differ from the retained build');
    assert.ok(inputs.sourceFiles.some(file => file.path === 'desktop/release/debian/video-codecs.json' &&
      file.sha256 === payload.get(notice + 'video-codecs.json').sha256),
    'Local-video SDK recipe differs from runtime build inputs');
    for (const component of ['avcodec', 'avformat', 'avutil', 'swscale'])
      assert.ok(contract.bundledLibraries.some(library => library.binary === videoHelper &&
        library.soname.startsWith('lib' + component + '.so.') &&
        library.path === 'usr/lib/pollyui/video/' + library.soname),
      'Local-video library resolves outside its private runtime closure: ' + component);
    assert.ok(sbom.packages.some(pkg => pkg.name === 'FFmpeg-local-video' && pkg.versionInfo === video.version &&
      pkg.licenseDeclared === video.license && pkg.sourceInfo === 'Official release SHA-512: ' + video.sha512),
    'Local-video SBOM differs from source/license identity');
  }
  if (manifest.debian) {
    for (const name of ['usr/bin/pollywm', 'usr/lib/pollyui/libwlroots-0.19-polly-effects4.so'])
      assert.ok(processed.has(name), 'Missing Debian private ELF relocation: ' + name);
    const effects = contract.wlrootsEffects;
    assert.ok(effects?.schemaVersion === 1 && effects.abi === 4 && effects.upstreamVersion === '0.19.3' &&
      effects.version === '0.19.3-polly-effects4' && hashPattern.test(effects.patchSha256),
    'Missing paired wlroots scene-effects identity');
    const patch = 'desktop/patches/wlroots-scene-effects.patch';
    assert.ok(inputs.sourceFiles.some(file => file.path === patch && file.sha256 === effects.patchSha256),
      'wlroots scene-effects patch differs from build inputs');
    for (const name of ['wlroots-scene-effects.patch', 'wlroots-effects.json', 'apply-wlroots-effects.py'])
      assert.ok(payload.has('usr/share/licenses/pollyui/wlroots/' + name),
        'Missing paired wlroots scene-effects source: ' + name);
    assert.ok(sbom.packages.some(pkg => pkg.name === 'wlroots' && pkg.versionInfo === effects.version &&
      typeof pkg.licenseComments === 'string' && pkg.licenseComments.endsWith(`; ABI ${effects.abi}.`) &&
      pkg.sourceInfo === `PollyUI wlroots patch SHA-256: ${effects.patchSha256}; effects ABI ${effects.abi}.`),
      'wlroots scene-effects SBOM differs from dependency identity');
  }
}

export function validateFrozenRuntime(manifest, inputs) {
  assert.equal(manifest.dirty, false, 'Frozen candidate requires an actually clean source checkout');
  assert.equal(inputs.build.revisionSource, 'git', 'External revision labels cannot qualify a frozen candidate');
  assert.equal(inputs.revision, manifest.revision, 'Frozen source revision differs from rebuild receipt');
}
