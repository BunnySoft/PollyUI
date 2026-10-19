import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArguments, runCLI } from '../tools/build-live-skus.mjs';
import { loadConfig, parseConfig, legacyConfig, normalizeConfig, packageStages, resolvePlan,
  validatePlan, configIdentity, canonical, objectHash, sha256, verifyLockFiles } from '../tools/live-config.mjs';
import { hardwareProfile, hardwareSkus } from '../tools/live-profiles.mjs';
import { publish, verifyBundle } from '../tools/publish-live-iso.mjs';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const configs = new URL('../release/debian/configs/', import.meta.url);
const entry = fileURLToPath(new URL('../tools/build-live-skus.mjs', import.meta.url));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const json = (file, value) => write(file, JSON.stringify(value, null, 2) + '\n');
const configText = name => fs.readFileSync(new URL(name + '.yaml', configs), 'utf8');
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'polly-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function lockFixture(directory, config, runtimeHash = 'a'.repeat(64)) {
  const plan = resolvePlan(config);
  const all = new Map();
  for (const item of Object.values(plan.stages).flat()) {
    const [name, version = '1.0'] = item.split('=');
    all.set(name, { name, version, architecture: 'amd64', reason: 'Explicit request; synthetic APT boundary fixture.' });
  }
  all.set('libfixture-auto', { name: 'libfixture-auto', version: '2.0', architecture: 'amd64',
    reason: 'APT fixture dependency; per-edge provenance not provided.' });
  const release = Buffer.from('UNSIGNED synthetic Release fixture, never valid for a real build');
  const index = Buffer.from('UNAUTHENTICATED synthetic Packages fixture');
  write(path.join(directory, 'snapshot/InRelease'), release);
  write(path.join(directory, 'snapshot/Packages'), index);
  const archive = Buffer.from('NOT a Debian package; test external authentication boundary only.');
  const archiveSha = sha256(archive);
  write(path.join(directory, 'packages', archiveSha + '.deb'), archive);
  const lock = { schemaVersion: 1, kind: 'polly-apt-resolution',
    packageRequestSha256: plan.packageRequestSha256, runtimeManifestSha256: runtimeHash,
    runtimeImageID: '1'.repeat(64), solver: { name: 'apt-get', version: 'fixture-not-a-real-solution',
      note: 'Synthetic external boundary fixture, not package authenticity or actual dependency qualification.' },
    packages: [...all.values()].sort((a, b) => a.name.localeCompare(b.name)),
    archives: [{ name: 'libfixture-auto', version: '2.0', architecture: 'amd64',
      path: 'packages/' + archiveSha + '.deb', sha256: archiveSha, bytes: archive.length,
      source: 'trixie', stage: 'platform' }],
    sources: [{ id: 'trixie', inRelease: { path: 'snapshot/InRelease', sha256: sha256(release) },
      index: { path: 'snapshot/Packages', sha256: sha256(index) }, releasePath: 'main/binary-amd64/Packages' }] };
  json(path.join(directory, 'packages.lock.json'), lock);
  return lock;
}
function checksums(directory) {
  write(path.join(directory, 'SHA256SUMS'), fs.readdirSync(directory).filter(name => name !== 'SHA256SUMS').sort()
    .map(name => sha256(fs.readFileSync(path.join(directory, name))) + '  ' + name).join('\n') + '\n');
}
function createMedia(directory, plan, lock, revision) {
  const identity = configIdentity(plan), sku = plan.configuration.hardware, hardware = hardwareProfile(sku);
  const prefix = `pollydesktop-0.1.0-alpha.8-debian13-${sku}-${identity.name}-${identity.planSha256.slice(0, 12)}-x86_64-`;
  const artifact = suffix => {
    const name = prefix + suffix, bytes = Buffer.from('SYNTHETIC media orchestration fixture ' + name);
    write(path.join(directory, name), bytes);
    return { name, size: bytes.length, sha256: sha256(bytes) };
  };
  const iso = artifact('uefi-live.iso'), usb = artifact('uefi-usb.img');
  write(path.join(directory, 'grub.cfg'), 'synthetic config\n');
  const packages = lock.packages.map(({ name, version, architecture }) =>
    ({ name, version, architecture, installedSizeBytes: 1024, regularFileBytes: 20 }));
  const root = { kind: 'squashfs-ram-overlay', path: 'boot/root.squashfs', size: 100, sha256: 'c'.repeat(64),
    mediaIdentity: 'd'.repeat(32), copyToRam: true, writable: 'tmpfs-overlay',
    hardwareProfile: { sku, manifestSha256: hardware.manifestSha256 },
    displayPolicy: hardware.displayPolicy, configuration: identity,
    bootstrap: { path: 'boot/initramfs.gz', size: 20, sha256: 'e'.repeat(64), uncompressedBytes: 40,
      graphicsModules: hardware.displayPolicy.bootstrapModules } };
  const manifest = { schemaVersion: 2, version: '0.1.0-alpha.8', stage: 'development-live-image',
    architecture: 'x86_64', distribution: 'debian13', sourceRevision: revision, sourceDirty: false,
    runtimeImage: lock.runtimeImageID, imageToolsID: '2'.repeat(64),
    nativeRuntime: { imageID: lock.runtimeImageID, sourceRevision: 'a'.repeat(40), manifestSha256: lock.runtimeManifestSha256 },
    sku, hardwareProfile: hardware, configuration: identity, root, iso, usb, files: 10, uncompressedPayloadBytes: 500,
    grub: { templateSha256: 'f'.repeat(64), embeddedSha256: sha256('synthetic config\n'),
      kernelArguments: hardware.displayPolicy.kernelArguments },
    packages: packages.map(({ name, version }) => ({ name, version })),
    sizeReport: { schemaVersion: 1, sku, manifestSha256: hardware.manifestSha256, configuration: identity,
      packages, limits: ['Synthetic fixture, not actual media or package sizes.'],
      media: { isoBytes: iso.size, usbBytes: usb.size, rootBytes: 100, bootstrapBytes: 20,
        bootstrapUncompressedBytes: 40, rootUncompressedBytes: 500 } } };
  json(path.join(directory, 'live-manifest.json'), manifest);
  json(path.join(directory, 'resolved-plan.json'), plan);
  json(path.join(directory, 'packages.lock.json'), lock);
  json(path.join(directory, 'configuration-sbom.spdx.json'), {
    spdxVersion: 'SPDX-2.3', configuration: identity, nativeRuntimeManifestSha256: lock.runtimeManifestSha256,
    packages: lock.packages.map(item => ({ name: item.name, versionInfo: item.version, architecture: item.architecture })),
  });
  json(path.join(directory, 'candidate-origin.json'), {
    schemaVersion: 2, runtimeSourceRevision: manifest.nativeRuntime.sourceRevision, runtimeSourceDirty: false,
    runtimeManifestSha256: lock.runtimeManifestSha256, mediaProducerRevision: revision,
    runtimeImageID: lock.runtimeImageID, isoSha256: iso.sha256, isoPayloadFilesVerified: 10,
    usbSha256: usb.sha256, usbPayloadFilesVerified: 10, bootstrapVerified: true, rootLayout: root,
    ...Object.fromEntries(['sku', 'hardwareProfile', 'nativeRuntime', 'imageToolsID', 'sizeReport', 'configuration']
      .map(key => [key, manifest[key]])),
  });
  checksums(directory);
}
function fixture(t, config = legacyConfig('vm'), failure = '') {
  const root = temporary(t), source = path.join(root, 'source'), bundle = path.join(root, 'runtime');
  const output = path.join(root, 'output'), directory = path.join(root, 'lock'), configFile = path.join(root, 'config.yaml');
  // JSON is a YAML 1.2 subset. The production parser still handles this file.
  json(configFile, config);
  write(path.join(source, 'CMakeLists.txt'), '# test source\n');
  write(path.join(source, 'desktop/release/debian/Containerfile.live'),
    fs.readFileSync(new URL('../release/debian/Containerfile.live', import.meta.url)));
  const manifest = { version: '0.1.0-alpha.8', revision: 'a'.repeat(40) };
  json(path.join(bundle, 'manifest.json'), manifest);
  json(path.join(bundle, 'build-inputs.json'), { fixtureOnly: true });
  write(path.join(bundle, 'runtime-packages.txt'), packageStages(config).runtime.map(spec =>
    spec.includes('=') ? spec : spec + '=1.0').join('\n') + '\n');
  const lock = lockFixture(directory, config, sha256(fs.readFileSync(path.join(bundle, 'manifest.json'))));
  const calls = [];
  const backend = {
    repo: source, platform: 'linux',
    git: args => args.includes('rev-parse') ? 'b'.repeat(40) : '',
    sourceInventory: current => ['CMakeLists.txt', 'desktop/release/debian/Containerfile.live']
      .map(name => ({ path: name, sha256: sha256(fs.readFileSync(path.join(current, name))) })),
    inspectRelease: async current => current.endsWith('media') ? { kind: 'live' } : { kind: 'runtime', distribution: 'debian13' },
    validateRuntime: () => {}, // Native qualification is an external boundary, covered by package-contract tests.
    spawnSync: (program, args) => {
      assert.equal(program, 'podman');
      calls.push(args);
      if (args[0] === 'image') {
        const id = args.at(-1);
        return { status: 0, stdout: /^[12]{64}$/.test(id) ? id : sha256(id) };
      }
      const phase = args.includes('preflight') ? 'preflight' :
        args[0] === 'build' ? 'build' :
          args.some(arg => arg.endsWith('/build-live-image.py')) ? 'media' :
            args.some(arg => arg.endsWith('/verify-live-runtime.py')) ? 'verify' : '';
      if (failure && failure === phase) return { status: 42, stderr: 'FIRST: injected ' + failure + ' failure' };
      if (phase === 'build') {
        assert.ok(args.includes('--network=none'), 'Configured platform/live builds must stay offline');
        const context = args.find(arg => arg.startsWith('live-configuration=')).slice('live-configuration='.length);
        const frozenPlan = read(path.join(context, 'resolved-plan.json'));
        assert.deepEqual(frozenPlan.stages, resolvePlan(config, lock).stages);
        assert.ok(args.includes('CONFIGURED_BUILD=1'));
      }
      if (phase === 'media') {
        const frozen = path.join(output, 'common/configuration');
        createMedia(path.join(output, config.hardware, 'media'), read(path.join(frozen, 'resolved-plan.json')),
          read(path.join(frozen, 'packages.lock.json')), 'b'.repeat(40));
      }
      if (args[0] === 'export') write(args[args.indexOf('--output') + 1], 'not a real root export');
      return { status: 0, stdout: 'PASS synthetic external boundary' };
    },
  };
  const args = [output, '--config', configFile, '--build', '--lock', directory,
    '--runtime-bundle', bundle, '--runtime-image', lock.runtimeImageID, '--tools-image', '2'.repeat(64)];
  return { root, output, directory, configFile, config, lock, calls, backend, args };
}

test('all nine YAML configs parse; stock stage selection exactly matches the legacy adapter', async () => {
  for (const sku of hardwareSkus) {
    const config = await loadConfig(new URL('standard-' + sku + '.yaml', configs));
    assert.deepEqual(packageStages(config), packageStages(legacyConfig(sku)));
    assert.equal(resolvePlan(config).native.available, true);
    assert.equal(resolvePlan(config).stableAliasEligible, sku === 'full');
  }
  for (const sku of ['vm', 'basic', 'full']) {
    const plan = resolvePlan(await loadConfig(new URL('minimal-zh-' + sku + '.yaml', configs)));
    assert.equal(plan.status, 'blocked');
    assert.equal(plan.resolution.packages, null);
    assert.match(plan.blockers.join(' '), /GBM.*LLVM/);
    assert.equal(plan.configuration.capabilities.audio, 'standard');
    assert.ok(plan.stages.runtime.includes('rime-data-luna-pinyin'));
    assert.ok(plan.stages.runtime.includes('fonts-wqy-microhei=0.2.0-beta-4'));
    assert.equal(plan.stableAliasEligible, false);
  }
});
test('safe YAML rejects duplicate/unknown keys, aliases, tags, documents and unsafe package input', async () => {
  const good = configText('standard-vm');
  for (const text of [good + '\nname: second\n', good + '\nunknown: true\n', good + '\n---\nname: another\n',
    good.replace('name: standard-vm', 'name: &x standard-vm'),
    good.replace('name: standard-vm', 'name: *x'),
    good.replace('name: standard-vm', 'name: !!str standard-vm'),
    good.replace('name: standard-vm', 'name: !custom standard-vm'),
    good.replace('stage: runtime', 'stage: runtime\n    <<: {injected: true}'),
    good.replace('dbus-daemon,', '"dbus-daemon; id",'), good.replace('install: [dbus-daemon', 'install: [dbus-daemon, dbus-daemon'),
    good.replace('noRecommends: true', 'noRecommends: "true"'), good.replace('webgl2: true', 'webgl2: false'),
    'a: '.repeat(40000)])
    await assert.rejects(parseConfig(text));
  const bad = legacyConfig('vm');
  bad.packageGroups[0].install = [];
  assert.throws(() => normalizeConfig(bad));
  bad.packageGroups[0].install = ['libgl1'];
  assert.throws(() => normalizeConfig(bad));
});
test('deterministic hashes separate configuration/native/complete plan domains and never infer descriptions', () => {
  const vm = legacyConfig('vm'), full = legacyConfig('full');
  const a = resolvePlan(vm), b = resolvePlan(full);
  assert.equal(a.nativeVariantInputSha256, b.nativeVariantInputSha256);
  assert.notEqual(a.planSha256, b.planSha256);
  const textOnly = structuredClone(vm);
  textOnly.description = 'Install GNOME and delete fonts (description is not executable).';
  assert.deepEqual(resolvePlan(textOnly).stages, a.stages);
  assert.equal(resolvePlan(textOnly).nativeVariantInputSha256, a.nativeVariantInputSha256);
  assert.notEqual(resolvePlan(textOnly).configSha256, a.configSha256);
  assert.deepEqual(resolvePlan(vm), a);
  assert.deepEqual(validatePlan(a), a);
  const tampered = structuredClone(a); tampered.stages.platform.push('curl');
  assert.throws(() => validatePlan(tampered));
  const trimmed = structuredClone(full); trimmed.name = 'standard-full';
  trimmed.packageGroups[1].install.push('curl');
  assert.equal(resolvePlan(trimmed).stableAliasEligible, false);
});
test('real Node CLI planning has no output/external side effects; help has no YAML dependency', t => {
  const root = temporary(t), nonexistent = path.join(root, 'must-not-exist');
  const result = spawnSync(process.execPath, [entry, nonexistent, '--config',
    fileURLToPath(new URL('standard-vm.yaml', configs)), '--plan'], { encoding: 'utf8', cwd: root });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'unresolved');
  assert.ok(!fs.existsSync(nonexistent));
  const minimal = spawnSync(process.execPath, [entry, '--config',
    fileURLToPath(new URL('minimal-zh-basic.yaml', configs)), '--plan'], { encoding: 'utf8', cwd: root });
  assert.equal(minimal.status, 0, minimal.stderr);
  assert.equal(JSON.parse(minimal.stdout).status, 'blocked');
  const help = spawnSync(process.execPath, [entry, '--help'], { encoding: 'utf8', cwd: root });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--config.*--plan/);
  for (const args of [[nonexistent, '--config', 'file'], ['--config', 'file', '--plan', '--build'],
    ['--config', 'file', '--plan', '--sku', 'vm'], ['--plan', '--lock', 'dir'], ['--plan', '--plan']])
    assert.throws(() => parseArguments(args));
  assert.deepEqual(parseArguments(['--plan']).skus, ['full']);
  assert.equal(fs.readdirSync(root).length, 0);
});
test('actual top-level shell forwards configuration plans and rejects mixed native/build options', t => {
  const bash = process.platform === 'win32' ?
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe') : 'bash';
  if (process.platform === 'win32' && !fs.existsSync(bash)) { t.skip('Git Bash not installed'); return; }
  const root = temporary(t), output = path.join(root, 'never-created'), script = path.join(repo, 'tools/build.sh');
  const result = spawnSync(bash, [script, '--live', output, '--config',
    fileURLToPath(new URL('standard-vm.yaml', configs)), '--plan'], { encoding: 'utf8', cwd: root });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).configuration.name, 'standard-vm');
  assert.ok(!fs.existsSync(output));
  const help = spawnSync(bash, [script, '--live', '--help'], { encoding: 'utf8', cwd: root });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--config/);
  const defaults = spawnSync(bash, [script, '--live', '--plan'], { encoding: 'utf8', cwd: root });
  assert.equal(defaults.status, 0, defaults.stderr);
  assert.equal(JSON.parse(defaults.stdout).plans[0].configuration.hardware, 'full');
  for (const args of [['--clean', '--live', '--help'], ['--live', '--help', '--run'],
    ['--live', output, '--config', 'file', '--plan', '--metal']]) {
    const rejected = spawnSync(bash, [script, ...args], { encoding: 'utf8', cwd: root });
    assert.notEqual(rejected.status, 0);
  }
});
test('legacy help and stock planning work in an isolated copy without npm or node_modules', t => {
  const root = temporary(t);
  for (const name of ['build-live-skus.mjs', 'live-profiles.mjs', 'live-layout.mjs', 'live-config.mjs',
    'configuration-receipt.mjs', 'package-contract.mjs', 'release-report.mjs', 'publish-live-iso.mjs'])
    write(path.join(root, 'desktop/tools', name), fs.readFileSync(new URL('../tools/' + name, import.meta.url)));
  for (const name of ['live-profiles.json', 'runtime-packages.json', 'boot-dependencies.json',
    'wlroots-effects.json', 'archive-trust.json'])
    write(path.join(root, 'desktop/release/debian', name), fs.readFileSync(new URL('../release/debian/' + name, import.meta.url)));
  const isolatedEntry = path.join(root, 'desktop/tools/build-live-skus.mjs');
  for (const args of [['--help'], ['--plan'], ['--plan', '--skus', 'vm,amd']]) {
    const result = spawnSync(process.execPath, [isolatedEntry, ...args], { encoding: 'utf8', cwd: root });
    assert.equal(result.status, 0, result.stderr);
  }
  const legacy = parseArguments(['out', '--runtime-bundle', 'runtime', '--runtime-image', 'runtime',
    '--tools-image', 'tools', '--sku', 'vm']);
  assert.deepEqual(legacy.skus, ['vm']);
  assert.ok(!legacy.config);
  write(path.join(root, 'config.yaml'), configText('standard-vm'));
  const configured = spawnSync(process.execPath, [isolatedEntry, '--config', path.join(root, 'config.yaml'), '--plan'],
    { encoding: 'utf8', cwd: root });
  assert.notEqual(configured.status, 0);
  assert.match(configured.stderr, /yaml/);
  assert.ok(!fs.existsSync(path.join(root, 'desktop/tools/node_modules')));
});
test('saved APT lock is explicitly unverified and detects wrong request/pins/forbidden/unsafe files', t => {
  const root = temporary(t), config = legacyConfig('vm'), lock = lockFixture(root, config);
  const plan = resolvePlan(config, lock);
  assert.equal(plan.resolution.status, 'resolved-unverified');
  assert.equal(plan.size.kind, 'unmeasured');
  assert.equal(plan.size.isoBytes, null);
  assert.ok(plan.size.archiveBytesProxy > 0);
  assert.deepEqual(validatePlan(plan), plan);
  for (const mutate of [
    item => { item.packageRequestSha256 = '0'.repeat(64); },
    item => { item.packages[0].architecture = 'arm64'; },
    item => { item.packages.push(item.packages[0]); },
    item => { item.archives[0].path = '../evil.deb'; },
    item => { item.sources[0].releasePath = 'other/Packages'; },
    item => { item.packages.find(pkg => pkg.name === 'polkitd').version = 'wrong'; },
    item => { item.packages.push({ name: 'firmware-amd-graphics', version: '1', architecture: 'amd64', reason: 'bad' }); },
  ]) {
    const copy = structuredClone(lock); mutate(copy);
    assert.throws(() => resolvePlan(config, copy));
  }
  verifyLockFiles(root, lock);
  fs.appendFileSync(path.join(root, lock.archives[0].path), 'tampered');
  assert.throws(() => verifyLockFiles(root, lock), /changed/);
});
test('actual dispatcher rejects minimal/unresolved inputs before any external action or output', async t => {
  const f = fixture(t), out = path.join(f.root, 'never');
  let calls = 0;
  const backend = { spawnSync: () => { calls++; throw new Error('Must not run'); } };
  const base = [out, '--build', '--runtime-bundle', f.root, '--runtime-image', 'id', '--tools-image', 'id'];
  await assert.rejects(runCLI([...base, '--config',
    fileURLToPath(new URL('minimal-zh-vm.yaml', configs))], backend), /unavailable/);
  await assert.rejects(runCLI([...base, '--config', f.configFile], backend), /unresolved/);
  assert.equal(calls, 0);
  assert.ok(!fs.existsSync(out));
});
test('actual dispatcher propagates selected stages through frozen contexts and verifies configured media', async t => {
  const config = legacyConfig('vm');
  config.packageGroups[1].install.push('curl');
  const f = fixture(t, config);
  const state = await runCLI(f.args, f.backend);
  assert.equal(state.status, 'complete');
  const phases = f.calls;
  assert.ok(phases.find(args => args.includes('preflight')));
  assert.equal(phases.filter(args => args[0] === 'build').length, 2);
  assert.ok(phases.findIndex(args => args.includes('preflight')) < phases.findIndex(args => args[0] === 'build'));
  const frozen = read(path.join(f.output, 'common/configuration/resolved-plan.json'));
  assert.ok(frozen.stages.platform.includes('curl'));
  assert.ok(frozen.resolution.packages.some(item => item.name === 'libfixture-auto'));
  const media = path.join(f.output, 'vm/media');
  const result = verifyBundle(media);
  assert.equal(result.manifest.configuration.planSha256, frozen.planSha256);
  assert.ok(result.manifest.iso.name.includes(frozen.configuration.name + '-' + frozen.planSha256.slice(0, 12)));
  const stable = path.join(f.root, 'published/PollyOS.iso');
  write(stable, 'old alias');
  publish(media, path.dirname(stable));
  assert.equal(fs.readFileSync(stable, 'utf8'), 'old alias');
  assert.ok(!fs.existsSync(path.join(f.output, 'PollyOS.iso')));
});
test('preflight or build failure stops execution, preserves FIRST, and never publishes media', async t => {
  for (const failure of ['preflight', 'build']) {
    const f = fixture(t, legacyConfig('vm'), failure);
    await assert.rejects(runCLI(f.args, f.backend), /failed/);
    assert.equal(read(path.join(f.output, 'build-run.json')).status, 'failed');
    assert.match(fs.readFileSync(path.join(f.output, 'build.log'), 'utf8'), new RegExp('FIRST: injected ' + failure));
    assert.ok(!fs.existsSync(path.join(f.output, 'vm/media')));
    if (failure === 'preflight') assert.ok(!f.calls.some(args => args[0] === 'build'));
  }
});
test('legacy assembly keeps its existing online APT build policy', async t => {
  const f = fixture(t);
  const external = f.backend.spawnSync;
  let builds = 0;
  f.backend.spawnSync = (program, args, options) => {
    if (args[0] === 'build') {
      builds++;
      assert.ok(!args.includes('--network=none'), 'Do not change legacy online APT assembly');
      assert.ok(!args.includes('CONFIGURED_BUILD=1'));
      return { status: 42, stderr: 'FIRST: stop legacy mock before actual media' };
    }
    return external(program, args, options);
  };
  await assert.rejects(runCLI([f.output, '--runtime-bundle', path.join(f.root, 'runtime'),
    '--runtime-image', f.lock.runtimeImageID, '--tools-image', '2'.repeat(64), '--sku', 'vm'], f.backend), /failed/);
  assert.equal(builds, 1);
  assert.equal(read(path.join(f.output, 'build-run.json')).status, 'failed');
});
test('input tampering fails before heavy actions; configured root/lock/SBOM tampering fails publication', async t => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.directory, 'snapshot/Packages'), 'changed');
  await assert.rejects(runCLI(f.args, f.backend), /changed/);
  assert.equal(f.calls.length, 0);
  const clean = fixture(t);
  await runCLI(clean.args, clean.backend);
  const directory = path.join(clean.output, 'vm/media'), original = read(path.join(directory, 'live-manifest.json'));
  for (const mutate of [
    m => { m.configuration.name = 'different'; },
    m => { m.sizeReport.configuration.planSha256 = '0'.repeat(64); },
    m => { m.sizeReport.packages[0].version = 'forged'; },
  ]) {
    const value = structuredClone(original); mutate(value);
    json(path.join(directory, 'live-manifest.json'), value); checksums(directory);
    assert.throws(() => verifyBundle(directory));
  }
  json(path.join(directory, 'live-manifest.json'), original);
  const sbom = read(path.join(directory, 'configuration-sbom.spdx.json'));
  sbom.nativeRuntimeManifestSha256 = '0'.repeat(64);
  json(path.join(directory, 'configuration-sbom.spdx.json'), sbom); checksums(directory);
  assert.throws(() => verifyBundle(directory), /SBOM/);
});
test('full hardware with any extra selection cannot update the stable alias even when named standard-full', async t => {
  const config = legacyConfig('full'); config.packageGroups[1].install.push('curl');
  const f = fixture(t, config); await runCLI(f.args, f.backend);
  assert.throws(() => publish(path.join(f.output, 'full/media'), path.join(f.root, 'publish'),
    { updateAlias: true }), /exact standard full/);
});
