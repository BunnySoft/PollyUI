import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
if (process.platform !== 'linux' || args.length !== 4) {
  throw new Error('Usage (Alpine/Debian Linux): node package-linux.mjs BUILD OUTPUT SDL_SOURCE HARFBUZZ_SOURCE');
}
const [build, output, sdl, harfbuzz] = args.map(value => path.resolve(value));
if (existsSync(output)) throw new Error('Refusing to overwrite an existing package directory: ' + output);
const run = (program, argv, options = {}) => execFileSync(program, argv, {
  cwd: repo, encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024, ...options,
}).trim();
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const alpine = existsSync('/etc/alpine-release') ? readFileSync('/etc/alpine-release', 'utf8').trim() : null;
const debian = !alpine && existsSync('/etc/debian_version') &&
  /^VERSION_CODENAME=trixie$/m.test(readFileSync('/etc/os-release', 'utf8'));
if ((!alpine?.startsWith('3.24.') && !debian) || run('uname', ['-m']) !== 'x86_64')
  throw new Error('Runtime packaging supports Alpine 3.24 or Debian trixie on x86_64');
const distribution = debian ? 'debian13' : 'alpine3.24';
const version = readFileSync(path.join(repo, 'desktop/VERSION'), 'utf8').trim();
if (!/^\d+\.\d+\.\d+-alpha\.\d+$/.test(version)) throw new Error('Invalid development package version');
const revision = process.env.POLLY_SOURCE_REVISION || run('git', ['rev-parse', 'HEAD']);
if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error('Invalid source revision');
if (process.env.POLLY_SOURCE_REVISION && !['0', '1'].includes(process.env.POLLY_SOURCE_DIRTY))
  throw new Error('Externally supplied revision also requires POLLY_SOURCE_DIRTY=0 or 1');
const dirty = process.env.POLLY_SOURCE_REVISION ? process.env.POLLY_SOURCE_DIRTY === '1' :
  Boolean(run('git', ['status', '--porcelain', '--untracked-files=normal']));
run('cmake', ['--build', build, '--target', 'pollyui', 'pollywm', '-j', '2']);
const cache = readFileSync(path.join(build, 'CMakeCache.txt'), 'utf8');
const setting = name => cache.match(new RegExp('^' + name + ':[^=]*=(.*)$', 'm'))?.[1].trim();
if (path.resolve(setting('CMAKE_HOME_DIRECTORY') || '.') !== repo)
  throw new Error('Build belongs to a different source checkout');
if (/^CMAKE_(?:(?:C|CXX)_FLAGS|EXE_LINKER_FLAGS)[^:]*:[^=]*=.*-fsanitize=/m.test(cache))
  throw new Error('Use a non-sanitized build for the runtime package');
for (const option of ['PU_BUILD_DESKTOP', 'PU_DESKTOP_SERVICES', 'PU_LAYER_SHELL', 'PU_BUILD_IME_ENGINE'])
  if (setting(option) !== 'ON') throw new Error('Distribution requires ' + option + '=ON');
for (const [name, expected] of [['CMAKE_INSTALL_BINDIR', 'bin'], ['CMAKE_INSTALL_LIBDIR', 'lib'],
  ['CMAKE_INSTALL_DATADIR', 'share']]) {
  const value = setting(name) || (name === 'CMAKE_INSTALL_DATADIR' ? setting('CMAKE_INSTALL_DATAROOTDIR') : '');
  if (value !== expected) throw new Error('Initial package requires ' + name + '=' + expected + '; got ' + value);
}
const skia = setting('SKIA_ROOT');
if (!skia) throw new Error('Build does not record its Skia source');
for (const [source, expected] of [[skia, '08a5439a6be726021c1c1905d23ce298a3edc5e4'],
  [sdl, '8e37db5e797b6167f3a00d697d816a684bd259c7'],
  [harfbuzz, '6f4c5cec306d31e6822303f5ba248a14293d588e']])
  if (run('git', ['-C', source, 'rev-parse', 'HEAD']) !== expected)
    throw new Error('Packaging source does not match the pinned dependency: ' + source);
const packages = new Map(), providers = new Map();
if (debian) {
  for (const row of run('dpkg-query', ['-W', '-f=${binary:Package}\t${Version}\t${Homepage}\t${Depends}\t${Pre-Depends}\t${Provides}\n']).split('\n')) {
    const [P, V, U, depends, preDepends, provides] = row.split('\t');
    packages.set(P, { P, V, U, D: [depends, preDepends].filter(Boolean).join(', '), L: 'See /usr/share/doc/' + P.split(':')[0] + '/copyright' });
    providers.set(P, P); providers.set(P.split(':')[0], P);
    for (const provided of (provides || '').split(',')) {
      const name = provided.trim().split(/\s/)[0];
      if (name && !providers.has(name)) providers.set(name, P);
    }
  }
} else for (const record of readFileSync('/lib/apk/db/installed', 'utf8').split('\n\n')) {
  const fields = Object.fromEntries(record.split('\n').filter(line => /^[PVLDUp]:/.test(line))
    .map(line => [line[0], line.slice(2)]));
  if (!fields.P) continue;
  packages.set(fields.P, fields);
  providers.set(fields.P, fields.P);
  for (const provided of (fields.p || '').split(' '))
    if (provided) providers.set(provided.split(/[<>=~]/)[0], fields.P);
}
const needed = new Set();
function dependency(spec) {
  if (!spec || spec.startsWith('!')) return;
  const name = debian ? spec.split('|').map(alternative =>
    providers.get(alternative.trim().split(/\s/)[0].replace(/:(any|native)$/, ''))).find(Boolean) :
    providers.get(spec.split(/[<>=~]/)[0]);
  if (!name) throw new Error('Missing installed runtime dependency: ' + spec);
  if (needed.has(name)) return;
  needed.add(name);
  for (const child of (packages.get(name).D || '').split(debian ? ',' : ' ')) dependency(child.trim());
}
const runtimePackages = debian ? [
  'dbus-daemon', 'dbus-bin', 'pipewire-bin', 'libspa-0.2-modules',
  'libegl1', 'libegl-mesa0', 'libgl1', 'libgl1-mesa-dri', 'mesa-vulkan-drivers', 'libgles2', 'libwayland-client0',
  'libwayland-cursor0', 'libwayland-egl1', 'libxkbcommon0', 'xkb-data', 'adwaita-icon-theme',
  'fonts-dejavu-core', 'fonts-noto-core', 'fonts-noto-cjk', 'fonts-noto-color-emoji',
  'librime-data', 'rime-data-luna-pinyin', 'libinput-bin', 'foot', 'ca-certificates',
] : ['dbus', 'pipewire', 'pipewire-tools', 'mesa-egl', 'mesa-gl', 'mesa-gles', 'mesa-dri-gallium',
  'wayland-libs-client', 'wayland-libs-cursor', 'wayland-libs-egl', 'libxkbcommon',
  'xkeyboard-config', 'capitaine-cursors', 'font-dejavu', 'font-noto-cjk', 'font-noto-emoji',
  'font-noto-arabic', 'font-noto-devanagari', 'rime-plum-data', 'foot', 'ca-certificates'];
for (const name of runtimePackages) dependency(name);

mkdirSync(path.dirname(output), { recursive: true });
const staging = mkdtempSync(path.join(path.dirname(output), '.polly-package-'));
try {
  const root = path.join(staging, 'rootfs');
  mkdirSync(root);
  run('cmake', ['--install', build, '--prefix', '/usr', '--component', 'PollyDesktop'],
    { env: { ...process.env, DESTDIR: root } });
  const licenseRoot = path.join(root, 'usr/share/licenses/pollyui');
  function copy(source, destination) {
    if (!lstatSync(source).isFile()) throw new Error('Expected a regular packaging input: ' + source);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    chmodSync(destination, 0o644);
  }
  for (const [directory, name, license] of [[sdl, 'sdl', 'LICENSE.txt'], [harfbuzz, 'harfbuzz', 'COPYING']])
    copy(path.join(directory, license), path.join(licenseRoot, name, license));
  function notices(directory, relative = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (['.git', 'out', 'node_modules'].includes(entry.name)) continue;
      const source = path.join(directory, entry.name), name = path.join(relative, entry.name);
      if (entry.isDirectory()) notices(source, name);
      else if (/^(LICENSE|COPYING|NOTICE)([.-].*)?$/i.test(entry.name))
        copy(source, path.join(licenseRoot, 'skia', name));
    }
  }
  notices(skia);
  copy(path.join(repo, 'desktop/patches/sdl-wayland-sync-lifetime.patch'),
    path.join(licenseRoot, 'sdl/patches/sdl-wayland-sync-lifetime.patch'));
  if (debian) {
    copy(path.join(repo, 'desktop/release/debian/rime-default.custom.yaml'),
      path.join(root, 'usr/share/rime-data/default.custom.yaml'));
    copy('/opt/pollyui-wlroots/lib/libwlroots-0.19.so', path.join(root, 'usr/lib/pollyui/libwlroots-0.19.so'));
    copy(realpathSync('/opt/pollyui-input/lib/libinput.so.10'), path.join(root, 'usr/lib/pollyui/libinput.so.10'));
    run('patchelf', ['--set-rpath', '$ORIGIN', path.join(root, 'usr/lib/pollyui/libwlroots-0.19.so')]);
    copy('/opt/wlroots-0.19.3/LICENSE', path.join(licenseRoot, 'wlroots/LICENSE'));
    copy('/opt/pollyui-input-source/libinput-1.28.1/COPYING', path.join(licenseRoot, 'libinput/COPYING'));
    copy('/opt/pollyui-input-source/libinput-1.28.1/debian/copyright', path.join(licenseRoot, 'libinput/debian-copyright'));
    copy(path.join(repo, 'desktop/release/debian/sources.json'), path.join(staging, 'sources.json'));
    copy(path.join(repo, 'desktop/release/debian/libinput.json'), path.join(staging, 'libinput.json'));
    copy(path.join(repo, 'desktop/release/debian/debian.sources'), path.join(staging, 'debian.sources'));
    copy(path.join(repo, 'desktop/release/debian/backports.sources'), path.join(staging, 'backports.sources'));
  }
  copy(path.join(repo, debian ? 'desktop/release/debian/Containerfile.runtime' : 'desktop/release/Containerfile'),
    path.join(staging, 'Containerfile'));
  const binaries = ['usr/bin/pollyui', 'usr/bin/pollywm', 'usr/bin/pollyui-app-launcher', 'usr/bin/polly-app'];
  if (existsSync(path.join(root, 'usr/bin/polly-auth-check'))) binaries.push('usr/bin/polly-auth-check');
  for (const binary of binaries) {
    const libraries = run('ldd', [path.join(root, binary)]);
    if (/not found|lib(?:glib|gio|gobject)-2\.0|libharfbuzz/.test(libraries))
      throw new Error('Unexpected or missing desktop runtime dependency:\n' + libraries);
    for (const line of libraries.split('\n')) {
      const library = line.match(/(?:=>\s+|^\s*)(\/.*?)\s+\(/)?.[1];
      if (!library || library.startsWith(root + '/')) continue;
      const owner = debian ? run('dpkg-query', ['-S', realpathSync(library)]).split(': /')[0] :
        run('apk', ['info', '--who-owns', library]).match(/ is owned by (.+)$/)?.[1];
      const pkg = debian ? packages.get(owner) : [...packages.values()].find(item => item.P + '-' + item.V === owner);
      if (!pkg) throw new Error('Cannot identify runtime library owner: ' + library);
      dependency(pkg.P);
    }
  }
  const resolved = [...needed].sort().map(name => packages.get(name));
  writeFileSync(path.join(staging, 'runtime-packages.txt'), resolved.map(pkg => pkg.P + '=' + pkg.V).join('\n') + '\n');
  const sourceComponents = [
    { name: 'PollyDesktop', versionInfo: version, licenseDeclared: 'MIT', downloadLocation: 'NOASSERTION' },
    { name: 'QuickJS-ng', versionInfo: '0.15.1', licenseDeclared: 'MIT', downloadLocation: 'https://github.com/quickjs-ng/quickjs/tree/v0.15.1' },
    { name: 'Yoga', versionInfo: '3.2.1', licenseDeclared: 'MIT', downloadLocation: 'https://github.com/facebook/yoga/tree/v3.2.1' },
    { name: 'Skia', versionInfo: '08a5439a6be726021c1c1905d23ce298a3edc5e4', licenseDeclared: 'BSD-3-Clause',
      downloadLocation: 'https://github.com/aseprite/skia/tree/08a5439a6be726021c1c1905d23ce298a3edc5e4' },
    { name: 'HarfBuzz', versionInfo: '13.2.1', licenseDeclared: 'MIT',
      downloadLocation: 'https://github.com/harfbuzz/harfbuzz/tree/6f4c5cec306d31e6822303f5ba248a14293d588e' },
    { name: 'SDL', versionInfo: '3.4.10-polly-sync-lifetime', licenseDeclared: 'Zlib',
      downloadLocation: 'https://github.com/libsdl-org/SDL/tree/8e37db5e797b6167f3a00d697d816a684bd259c7' },
  ];
  if (debian) sourceComponents.push({ name: 'wlroots', versionInfo: '0.19.3', licenseDeclared: 'MIT',
    downloadLocation: 'https://gitlab.freedesktop.org/wlroots/wlroots/-/archive/0.19.3/wlroots-0.19.3.tar.gz' });
  if (debian) sourceComponents.push({ name: 'libinput-private', versionInfo: '1.28.1-1+deb13u1',
    licenseDeclared: 'MIT', downloadLocation: 'NOASSERTION',
    licenseComments: 'Debian source package; private build without libwacom; packaged COPYING and debian/copyright.' });
  const entries = [...sourceComponents, ...resolved.map(pkg => ({
    name: pkg.P, versionInfo: pkg.V, licenseDeclared: 'NOASSERTION',
    licenseComments: (debian ? 'Debian package: ' : 'Alpine package metadata: ') + (pkg.L || 'unspecified'),
    downloadLocation: 'NOASSERTION', homepage: pkg.U || 'NOASSERTION',
  }))].map((entry, index) => ({ ...entry, SPDXID: 'SPDXRef-Package-' + index,
    filesAnalyzed: false, licenseConcluded: 'NOASSERTION', copyrightText: 'NOASSERTION' }));
  const sbom = { spdxVersion: 'SPDX-2.3', dataLicense: 'CC0-1.0', SPDXID: 'SPDXRef-DOCUMENT',
    name: 'PollyDesktop ' + version + ' runtime inventory',
    documentNamespace: 'https://pollyui.invalid/spdx/' + revision + '-' + Date.now(),
    creationInfo: { created: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      creators: ['Tool: PollyDesktop-package-linux'] },
    packages: entries, relationships: [
      { spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: entries[0].SPDXID },
      ...entries.slice(1).map(entry => ({ spdxElementId: entries[0].SPDXID, relationshipType: 'DEPENDS_ON',
        relatedSpdxElement: entry.SPDXID })),
    ] };
  const manifest = { version, stage: 'development-runtime-bundle', bootable: false,
    architecture: 'x86_64', ...(debian ? { debian: 'trixie' } : { alpine }), revision, dirty,
    limits: ['No installer, login manager, secure lock, update signature or hardware qualification.',
      'Runtime inventory is not a completed third-party license/source-compliance audit.',
      'System-service access and iwd deployment require separate machine policy.'],
    files: [] };
  function inventory(directory, relative = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name), name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) inventory(file, name);
      else if (entry.isFile()) manifest.files.push({ path: name, sha256: hash(file), size: lstatSync(file).size,
        mode: name.startsWith('usr/bin/') || (name.startsWith('usr/share/pollyui/desktop/tools/') && name.endsWith('.sh')) ? '0755' : '0644' });
      else throw new Error('Unexpected non-regular package payload: ' + file);
    }
  }
  inventory(root);
  writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(path.join(staging, 'sbom.spdx.json'), JSON.stringify(sbom, null, 2) + '\n');
  const archive = 'pollydesktop-' + version + '-' + distribution + '-x86_64.tar.gz';
  run('python3', [path.join(repo, 'desktop/tools/package-tar.py'), root, path.join(staging, archive)]);
  const artifacts = [archive, 'manifest.json', 'sbom.spdx.json', 'runtime-packages.txt', 'Containerfile'];
  if (debian) artifacts.push('sources.json', 'libinput.json', 'debian.sources', 'backports.sources');
  writeFileSync(path.join(staging, 'SHA256SUMS'), artifacts.map(file => hash(path.join(staging, file)) + '  ' + file).join('\n') + '\n');
  renameSync(staging, output);
  console.log('Created development runtime bundle: ' + output);
  console.log('This is not a bootable or production-qualified distribution.');
} catch (error) {
  rmSync(staging, { recursive: true, force: true });
  throw error;
}
