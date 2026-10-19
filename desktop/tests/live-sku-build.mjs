import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requiredRuntimeFiles } from '../tools/package-contract.mjs';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, bytes) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
};
const json = (file, value) => write(file, JSON.stringify(value, null, 2) + '\n');
function runtimeFixture(directory) {
  const privateNames = ['usr/lib/pollyui/libwlroots-0.19-polly-effects4.so', 'usr/lib/pollyui/libinput.so.10',
    ...['wlroots-scene-effects.patch', 'wlroots-effects.json', 'apply-wlroots-effects.py']
      .map(name => 'usr/share/licenses/pollyui/wlroots/' + name)];
  const files = [...new Set([...requiredRuntimeFiles, ...privateNames])].map(name => {
    const bytes = Buffer.from('synthetic native fixture, not executable: ' + name);
    const mode = name.startsWith('usr/bin/') ? '0755' : '0644';
    write(path.join(directory, 'rootfs', name), bytes);
    fs.chmodSync(path.join(directory, 'rootfs', name), parseInt(mode, 8));
    return { path: name, mode, size: bytes.length, sha256: sha(bytes) };
  });
  const file = name => files.find(item => item.path === name);
  const effects = read(path.join(repo, 'desktop/release/debian/wlroots-effects.json'));
  const sourceNames = ['sysrt/CMakeLists.txt', 'sysrt/ffi/module.c', 'sysrt/tools/generate-files-abi.py',
    'desktop/launcher/main.c', 'desktop/launcher/services.mjs', 'desktop/install.cmake',
    'desktop/compositor/cursor.c', 'desktop/compositor/cursor.h', 'desktop/tools/generate-cursors.py',
    'desktop/resources/icons/cursor-manifest.json', ...Array.from({ length: 32 }, (_, i) => `shared/source-${i}.mjs`)];
  const sources = [...sourceNames.map(name => ({ path: name, sha256: sha(name) })),
    { path: 'desktop/patches/wlroots-scene-effects.patch', sha256: effects.patchSha256 }];
  const nativeLibraries = [
    { binary: 'usr/bin/pollyui', soname: 'libffi.so.8', package: 'libffi8:amd64', version: '3.4.8', usage: 'elf-link' },
    { binary: 'usr/bin/pollyui', soname: 'libdbus-1.so.3', package: 'libdbus-1-3:amd64', version: '1.16.2', usage: 'elf-link' },
    ...[['desktop/shared/file-system.mjs', 'libcrypto.so.3', 'libssl3t64:amd64', '3.5.7', 'SHA256'],
      ['sysrt/bindings/dbus.mjs', 'libdbus-1.so.3', 'libdbus-1-3:amd64', '1.16.2', 'dbus_connection_open_private']]
      .map(([name, soname, owner, version, symbol]) => ({ binary: 'usr/share/pollyui/' + name, soname,
        package: owner, version, usage: 'js-dlopen', symbol, resolvedFile: '/usr/lib/' + soname, sha256: sha(soname) })),
  ];
  const pins = [...new Set(nativeLibraries.map(item => item.package + '=' + item.version))];
  const abi = file('usr/share/pollyui/sysrt/bindings/generated/files-linux-x86_64.mjs');
  const manifest = { version: '0.1.0-alpha.8', architecture: 'x86_64', revision: 'a'.repeat(40),
    dirty: false, stage: 'development-runtime-bundle', bootable: false, debian: 'trixie', files,
    runtimeContract: { schemaVersion: 1, kind: 'gui-sysrt-js', installFiles: files,
      postprocess: ['usr/bin/pollywm', privateNames[0]].map(name => ({ path: name, tool: 'patchelf',
        rpath: name === 'usr/bin/pollywm' ? '$ORIGIN/../lib/pollyui' : '$ORIGIN',
        before: { sha256: file(name).sha256, size: file(name).size },
        after: { sha256: file(name).sha256, size: file(name).size } })),
      nativeLibraries, bundledLibraries: [
        ['usr/bin/pollyui', 'libSDL3.so.0', 'usr/lib/pollyui/libSDL3.so.0'],
        ['usr/bin/pollywm', 'libwlroots-0.19-polly-effects4.so', privateNames[0]],
        ['usr/bin/pollywm', 'libinput.so.10', privateNames[1]],
      ].map(([binary, soname, name]) => ({ binary, soname, path: name, sha256: file(name).sha256 })),
      abi: { path: abi.path, sha256: abi.sha256, target: 'linux-x86_64-lp64', verified: true },
      wlrootsEffects: effects } };
  json(path.join(directory, 'manifest.json'), manifest);
  json(path.join(directory, 'build-inputs.json'), { schemaVersion: 1, revision: manifest.revision, dirty: false,
    recipes: [], dependencies: [], sourceFiles: sources, build: { revisionSource: 'git',
      strategy: 'reconfigure-clean-first', sourceSha256Before: sha(JSON.stringify(sources)),
      sourceSha256After: sha(JSON.stringify(sources)) } });
  write(path.join(directory, 'runtime-packages.txt'), pins.join('\n') + '\n');
  json(path.join(directory, 'sbom.spdx.json'), { spdxVersion: 'SPDX-2.3', packages: [
    ...pins.map(pin => { const [name, versionInfo] = pin.split('='); return { name, versionInfo }; }),
    { name: 'wlroots', versionInfo: effects.version, licenseComments: `Fixture; ABI ${effects.abi}.`,
      sourceInfo: `PollyUI wlroots patch SHA-256: ${effects.patchSha256}; effects ABI ${effects.abi}.` },
  ] });
  write(path.join(directory, 'Containerfile'), 'FROM fixture\n');
  write(path.join(directory, 'pollydesktop-fixture-x86_64.tar.gz'), 'external package-modes boundary fixture');
  write(path.join(directory, 'SHA256SUMS'), fs.readdirSync(directory).filter(name => name !== 'rootfs').sort()
    .map(name => sha(fs.readFileSync(path.join(directory, name))) + '  ' + name).join('\n') + '\n');
}
function fixture(t, fail = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'polly-entry-control-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), bundle = path.join(root, 'runtime'), output = path.join(root, 'output');
  for (const name of ['build-live-skus.mjs', 'live-profiles.mjs', 'live-config.mjs', 'configuration-receipt.mjs',
    'live-layout.mjs', 'package-contract.mjs',
    'publish-live-iso.mjs', 'release-report.mjs', 'build-live.sh', 'live-root.py',
    'offline-live-overlay.py', 'retain-live-inputs.py', 'build-live-image.py', 'verify-live-runtime.py']) {
    write(path.join(source, 'desktop/tools', name), fs.readFileSync(path.join(repo, 'desktop/tools', name)));
  }
  for (const name of ['live-profiles.json', 'live-profile.py', 'basic-kernel.py', 'live-display.py', 'Containerfile.live',
    'runtime-packages.json', 'boot-dependencies.json', 'live-config.py', 'archive-trust.json'])
    write(path.join(source, 'desktop/release/debian', name), fs.readFileSync(path.join(repo, 'desktop/release/debian', name)));
  for (const name of ['shared/probe', 'sysrt/probe', 'third_party/quickjs/probe', 'third_party/yoga/probe'])
    write(path.join(source, name), 'frozen input\n');
  write(path.join(source, 'CMakeLists.txt'), '# fixture only\n');
  write(path.join(source, 'gui/probe.mjs'), 'FROZEN SOURCE\n');
  write(path.join(source, 'tools/build.sh'), fs.readFileSync(path.join(repo, 'tools/build.sh')));
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const git = args => execFileSync(realGit, ['-C', source, ...args], { encoding: 'utf8' }).trim();
  git(['init', '--quiet', '--initial-branch=fixture']);
  git(['add', '.']);
  git(['-c', 'user.name=SKU Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Synthetic CLI fixture',
    '-m', 'Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>\n' +
      'Copilot-Session: 07c3500a-0c35-4b7c-95a7-dfec58790dd0']);
  const revision = git(['rev-parse', 'HEAD']);
  runtimeFixture(bundle);
  const kernelPack = path.join(root, 'kernel-pack');
  fs.mkdirSync(kernelPack);
  execFileSync('python3', ['-I', '-B', '-c',
    'import runpy,sys; from pathlib import Path; runpy.run_path(sys.argv[1])["pack"](Path(sys.argv[2]))',
    path.join(repo, 'desktop/tests/basic-kernel.py'), kernelPack], { stdio: 'pipe' });
  const bin = path.join(root, 'bin'), shim = fileURLToPath(new URL('./live-sku-build-fixture.mjs', import.meta.url));
  for (const name of ['podman', 'git']) {
    write(path.join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${shim}" ${name} "$@"\n`);
    fs.chmodSync(path.join(bin, name), 0o755);
  }
  json(path.join(root, 'backend.json'), { source, output, tags: {}, containers: {}, mutated: false,
    kernelExternal: kernelPack, runtimeID: '1'.repeat(64), toolsID: '2'.repeat(64), runtimeLookups: 0, toolsLookups: 0 });
  write(path.join(root, 'stable/PollyOS.iso'), 'untouched stable fixture\n');
  const env = { ...process.env, PATH: bin + ':' + process.env.PATH,
    POLLY_SKU_FIXTURE_ROOT: root, POLLY_SKU_FIXTURE_REAL_GIT: realGit, POLLY_SKU_FIXTURE_FAIL: fail };
  const execute = () => spawnSync('bash', [path.join(source, 'tools/build.sh'), '--live', output,
    '--runtime-bundle', bundle, '--runtime-image', 'fixture-runtime', '--tools-image', 'fixture-tools',
    '--skus', 'basic,vm,intel,nvidia,amd,full', '--basic-kernel-pack', kernelPack],
  { cwd: root, env, encoding: 'utf8', timeout: 90000, maxBuffer: 8 * 1024 * 1024 });
  return { root, output, source, revision, execute, env };
}
function events(f) {
  const rows = fs.readFileSync(path.join(f.root, 'trace.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length % 2, 0);
  for (let i = 0; i < rows.length; i += 2) {
    assert.equal(rows[i].event, 'start');
    assert.equal(rows[i + 1].event, 'end');
    assert.equal(rows[i].phase, rows[i + 1].phase, 'Backend operations must not overlap');
  }
  return rows.filter(row => row.event === 'start');
}
const perSku = ['build-platform', 'inspect-platform', 'build-live', 'inspect-live',
  'qualify-template', 'qualify-live', 'assembled', 'export', 'rm', 'retain', 'media', 'verify'];

test('actual shell/Node entry freezes inputs once and serially executes every SKU path without publication',
  { skip: process.platform !== 'linux' }, t => {
    const f = fixture(t), result = f.execute();
    const log = path.join(f.output, 'build.log');
    assert.equal(result.status, 0, result.stderr + '\n' + (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''));
    const trace = events(f), state = read(path.join(f.output, 'build-run.json'));
    assert.deepEqual(trace.map(row => row.phase),
      ['git-head', 'git-status', 'inspect-runtime', 'inspect-tools', 'kernel-pack', 'package-modes', 'clean-runtime',
        ...['basic', 'vm', 'intel', 'nvidia', 'amd', 'full'].flatMap(() => perSku)]);
    assert.equal(state.status, 'complete');
    assert.equal(state.sourceRevision, f.revision);
    assert.deepEqual(state.artifacts.map(item => item.sku), ['basic', 'vm', 'intel', 'nvidia', 'amd', 'full']);
    assert.equal(new Set(state.artifacts.flatMap(item => Object.values(item.tags))).size, 12);
    assert.ok(state.artifacts.every(item => item.report.nativeRuntime.imageID === state.nativeRuntime.imageID &&
      item.report.imageToolsID === state.imageToolsID));
    const backend = read(path.join(f.root, 'backend.json'));
    assert.equal(backend.runtimeLookups, 1);
    assert.equal(backend.toolsLookups, 1);
    assert.equal(fs.readFileSync(path.join(f.source, 'gui/probe.mjs'), 'utf8'), 'DYNAMIC SOURCE CHANGED AFTER FREEZE\n');
    assert.equal(fs.readFileSync(path.join(f.output, 'common/source/gui/probe.mjs'), 'utf8'), 'FROZEN SOURCE\n');
    for (const sku of state.skus)
      assert.ok(fs.existsSync(path.join(f.output, sku, 'media/candidate-origin.json')));
    assert.equal(fs.readFileSync(path.join(f.root, 'stable/PollyOS.iso'), 'utf8'), 'untouched stable fixture\n');
    assert.ok(!fs.existsSync(path.join(f.output, 'PollyOS.iso')));
    assert.deepEqual(state.artifacts[0].report.kernelInput, state.basicKernelInput);
    assert.notEqual(sha(fs.readFileSync(path.join(f.root, 'kernel-pack/kernel-image.deb'))), state.basicKernelInput.package.sha256);
    assert.equal(sha(fs.readFileSync(path.join(f.output, 'common/basic-kernel/kernel-image.deb'))), state.basicKernelInput.package.sha256);
    assert.deepEqual(read(path.join(f.output, 'common/source-inputs.json')).kernelInput, state.basicKernelInput);
    console.log('PASS: real top BUILD entry, kernel pack verification, frozen source/native/tools, six sequential SKUs; external builds mocked');
  });
test('actual entry stops on a failed SKU, cleans its container and never enters later SKUs',
  { skip: process.platform !== 'linux' }, t => {
    const f = fixture(t, 'vm:assembled'), result = f.execute();
    assert.notEqual(result.status, 0);
    const trace = events(f), state = read(path.join(f.output, 'build-run.json'));
    assert.equal(state.status, 'failed');
    assert.deepEqual(state.artifacts.map(item => item.sku), ['basic']);
    assert.deepEqual(trace.slice(-8).map(row => row.phase),
      ['build-platform', 'inspect-platform', 'build-live', 'inspect-live',
        'qualify-template', 'qualify-live', 'assembled', 'rm']);
    assert.ok(!fs.existsSync(path.join(f.output, 'intel')));
    assert.ok(!fs.existsSync(path.join(f.output, 'nvidia')));
    assert.ok(!fs.existsSync(path.join(f.output, 'amd')));
    assert.ok(!fs.existsSync(path.join(f.output, 'vm/media')));
    assert.equal(fs.readFileSync(path.join(f.root, 'stable/PollyOS.iso'), 'utf8'), 'untouched stable fixture\n');
    assert.match(fs.readFileSync(path.join(f.output, 'build.log'), 'utf8'), /injected backend failure/);
    console.log('PASS: real entry failure stopping and cleanup; no later SKU or stable publication');
  });
test('top BUILD --live help has no native/backend/output side effects and rejects mixed native arguments',
  { skip: process.platform !== 'linux' }, t => {
    const f = fixture(t);
    const entry = path.join(f.source, 'tools/build.sh');
    const help = spawnSync('bash', [entry, '--live', '--help'], { env: f.env, encoding: 'utf8' });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /basic,vm,intel,nvidia,amd,full/);
    assert.ok(!fs.existsSync(f.output));
    assert.ok(!fs.existsSync(path.join(f.root, 'trace.jsonl')));
    for (const args of [['--clean', '--live', '--help'], ['--live', '--help', '--metal'],
      ['--live', f.output, '--run'], ['--live', '--help', '--live'], ['--live', f.output, '--unknown']]) {
      const result = spawnSync('bash', [entry, ...args], { env: f.env, encoding: 'utf8' });
      assert.notEqual(result.status, 0);
      assert.ok(!fs.existsSync(f.output));
      assert.ok(!fs.existsSync(path.join(f.root, 'trace.jsonl')));
    }
  });
test('actual entry rejects mutations of frozen source, runtime or dedicated kernel before any SKU build',
  { skip: process.platform !== 'linux' }, t => {
    for (const kind of ['source', 'runtime', 'kernel']) {
      const f = fixture(t);
      f.env.POLLY_SKU_FIXTURE_TAMPER = kind;
      const result = f.execute();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /frozen SKU inputs changed|dedicated basic kernel inputs changed/);
      const state = read(path.join(f.output, 'build-run.json'));
      assert.equal(state.status, 'failed');
      assert.deepEqual(state.artifacts, []);
      assert.ok(!events(f).some(event => event.phase.startsWith('build-')));
    }
  });
