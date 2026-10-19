import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hardwareSkus, hardwareProfile, hardwareMarker, parseSkus, validateProfileManifest } from '../tools/live-profiles.mjs';
import { parseArguments } from '../tools/build-live-skus.mjs';
import { validateLiveLayout, validateLiveRootReceipt } from '../tools/live-layout.mjs';
import { publish, digest } from '../tools/publish-live-iso.mjs';
import { inspectRelease, compareReleases } from '../tools/release-report.mjs';

export function media(sku) {
  const selected = hardwareProfile(sku);
  const root = { kind: 'squashfs-ram-overlay', path: 'boot/root.squashfs',
    sha256: 'a'.repeat(64), size: 200, mediaIdentity: 'b'.repeat(32), copyToRam: true,
    writable: 'tmpfs-overlay', hardwareProfile: { sku, manifestSha256: selected.manifestSha256 },
    displayPolicy: selected.displayPolicy,
    bootstrap: { path: 'boot/initramfs.gz', size: 100, sha256: 'c'.repeat(64), uncompressedBytes: 300,
      graphicsModules: selected.displayPolicy.bootstrapModules } };
  const kernel = { schemaVersion: 1, kind: 'polly-basic-kernel-pack', kernelRelease: '6.12.111-polly-basic',
    package: { name: 'linux-image-6.12.111-polly-basic', version: '1.0', architecture: 'amd64', sha256: 'a'.repeat(64), size: 100 },
    configSha256: 'b'.repeat(64), packManifestSha256: 'c'.repeat(64), imageSha256: 'd'.repeat(64),
    source: { archiveSha256: 'e'.repeat(64), baseConfigSha256: 'f'.repeat(64), strategy: 'debian-bindeb-pkg-simpledrm-unsigned-dev' } };
  if (sku === 'basic') root.kernelInput = kernel;
  const packages = [...selected.requiredPackages, ...(sku === 'basic' ? [kernel.package.name + '=1.0'] : [])].map(spec => {
    const [name, version = '1.0'] = spec.split('=');
    return { name, version, installedSizeBytes: 1024, regularFileBytes: 321, architecture: 'amd64' };
  });
  const manifest = { schemaVersion: 2, version: '0.1.0-alpha.8', distribution: 'debian13',
    architecture: 'x86_64', stage: 'development-live-image', sourceRevision: 'd'.repeat(40), sourceDirty: false,
    runtimeImage: 'e'.repeat(64), nativeRuntime: { imageID: 'e'.repeat(64),
      sourceRevision: 'f'.repeat(40), manifestSha256: 'a'.repeat(64) }, imageToolsID: 'b'.repeat(64),
    sku, hardwareProfile: selected, root, files: 42, uncompressedPayloadBytes: 999,
    ...(sku === 'basic' ? { kernelInput: kernel } : {}),
    grub: { templateSha256: 'c'.repeat(64), embeddedSha256: 'd'.repeat(64),
      kernelArguments: selected.displayPolicy.kernelArguments },
    packages: packages.map(({ name, version }) => ({ name, version })),
    iso: { name: `pollydesktop-0.1.0-alpha.8-debian13-${sku}-x86_64-uefi-live.iso`, size: 20, sha256: 'a'.repeat(64) },
    usb: { name: `pollydesktop-0.1.0-alpha.8-debian13-${sku}-x86_64-uefi-usb.img`, size: 30, sha256: 'b'.repeat(64) },
    sizeReport: { schemaVersion: 1, sku, manifestSha256: selected.manifestSha256, packages, limits: ['synthetic fixture'],
      media: { isoBytes: 20, usbBytes: 30, rootBytes: 200, rootUncompressedBytes: 999,
        bootstrapBytes: 100, bootstrapUncompressedBytes: 300 } },
  };
  return manifest;
}
function receipt(manifest) {
  return { schemaVersion: 2, runtimeSourceRevision: manifest.nativeRuntime.sourceRevision,
    runtimeSourceDirty: false, mediaProducerRevision: manifest.sourceRevision,
    runtimeImageID: manifest.runtimeImage, isoSha256: manifest.iso.sha256, isoPayloadFilesVerified: 42,
    runtimeManifestSha256: manifest.nativeRuntime.manifestSha256,
    rootLayout: manifest.root, usbSha256: manifest.usb.sha256, usbPayloadFilesVerified: 42, bootstrapVerified: true,
    ...Object.fromEntries(['sku', 'hardwareProfile', 'nativeRuntime', 'imageToolsID', 'sizeReport', 'kernelInput']
      .map(key => [key, manifest[key]])) };
}

test('fresh Live recipe keeps the session-mode overlay executable for strict assembly verification', () => {
  const recipe = fs.readFileSync(new URL('../release/debian/Containerfile.live', import.meta.url), 'utf8');
  const target = '/usr/share/pollyui/desktop/tools/live-session-mode.sh';
  const modes = [...recipe.matchAll(/\bchmod\s+([0-7]{3})\s+([^&]+)(?=&&)/g)]
    .filter(([, , files]) => files.replace(/\\\r?\n/g, ' ').split(/\s+/).includes(target))
    .map(([, mode]) => mode);
  assert.deepEqual(modes, ['755'], 'No later chmod may reset the source-owned .sh overlay to 644');
  assert.ok(recipe.includes('COPY release/live/session-mode ' + target));
  const normalization = recipe.match(/sed -i 's\/\\r\$\/\/' ([^&]+)(?=&&)/)?.[1];
  assert.ok(normalization?.includes(target), 'Preserve existing CRLF normalization');
});

test('strict SKU CLI defaults to full and refuses unknown, duplicate, empty or unsafe selections', () => {
  assert.deepEqual(parseSkus(), ['full']);
  assert.deepEqual(parseSkus(hardwareSkus.join(',')), hardwareSkus);
  for (const text of ['', ',full', 'full,', 'full,,vm', 'full,full', 'unknown', 'Full', ' vm', '../vm', 'vm;id'])
    assert.throws(() => parseSkus(text), /SKU/);
  const args = ['output', '--runtime-bundle', 'runtime', '--runtime-image', 'image', '--tools-image', 'tools'];
  assert.deepEqual(parseArguments(args).skus, ['full']);
  assert.deepEqual(parseArguments([...args, '--skus', 'intel,nvidia']).skus, ['intel', 'nvidia']);
  assert.deepEqual(parseArguments(['--help']), { help: true });
  assert.deepEqual(parseArguments([...args, '--sku', 'amd']).skus, ['amd']);
  assert.deepEqual(parseArguments([...args, '--sku', 'basic', '--basic-kernel-pack', 'kernel']).skus, ['basic']);
  for (const tail of [['--skus', ''], ['--skus', 'vm,vm'], ['--skus'], ['--oops', 'vm'],
    ['--tools-image', 'duplicate'], ['--sku', 'amd', '--skus', 'full'], ['--sku', 'amd', '--sku', 'full'],
    ['--sku', 'amd,full'], ['--sku', 'basic'], ['--basic-kernel-pack', 'unrequested'], ['--help']])
    assert.throws(() => parseArguments([...args, ...tail]));
});
test('manifest is declarative and strict; GPU choice never removes CPU/network/audio requirements', () => {
  const full = hardwareProfile('full'), intel = hardwareProfile('intel'), nv = hardwareProfile('nvidia');
  assert.deepEqual(hardwareProfile('vm').forbiddenPackages.sort(), [
    'firmware-intel-graphics', 'firmware-nvidia-graphics', 'firmware-amd-graphics', 'firmware-iwlwifi', 'firmware-sof-signed'].sort());
  assert.deepEqual(intel.forbiddenPackages, ['firmware-nvidia-graphics', 'firmware-amd-graphics']);
  assert.deepEqual(nv.forbiddenPackages, ['firmware-intel-graphics', 'firmware-amd-graphics']);
  assert.ok(hardwareProfile('amd').requiredPackages.includes('firmware-amd-graphics'));
  assert.ok(hardwareProfile('full').requiredModules.includes('amdgpu'));
  for (const sku of hardwareSkus) {
    assert.ok(hardwareProfile(sku).requiredPackages.includes('intel-microcode'));
    assert.ok(hardwareProfile(sku).shared.some(line => line.includes('Complete corrected Mesa')));
    assert.equal(JSON.parse(hardwareMarker(sku)).sku, sku);
  }
  for (const selected of [full, intel, nv])
    for (const pkg of ['firmware-iwlwifi', 'firmware-sof-signed'])
      assert.ok(selected.requiredPackages.includes(pkg));
  assert.ok(nv.support.some(line => line.includes('no proprietary')));
  const manifest = JSON.parse(fs.readFileSync(new URL('../release/debian/live-profiles.json', import.meta.url)));
  for (const mutate of [
    value => { value.extra = true; },
    value => { value.profiles.unknown = value.profiles.full; },
    value => { value.profiles.vm.packageGroups.push('unknown'); },
    value => { value.packageGroups.common.push(value.packageGroups.common[0]); },
  ]) {
    const copy = structuredClone(manifest);
    mutate(copy);
    assert.throws(() => validateProfileManifest(copy));
  }
});
if (process.platform === 'linux') test('Python assembly and Node publication use the same six source profiles/marker bytes', () => {
  for (const sku of hardwareSkus) {
    const actual = JSON.parse(execFileSync('python3', ['-I', '-B',
      fileURLToPath(new URL('../release/debian/live-profile.py', import.meta.url)), 'describe', '--sku', sku],
    { encoding: 'utf8' }));
    assert.deepEqual(actual.profile, hardwareProfile(sku));
    assert.equal(actual.marker, hardwareMarker(sku));
  }
});
test('all six media layouts bind source profile, root/boot, runtime, sizes and actual receipt', () => {
  for (const sku of hardwareSkus) {
    const manifest = media(sku);
    assert.equal(validateLiveRootReceipt(manifest, receipt(manifest)), 'squashfs-ram-overlay');
    for (const mutate of [
      m => { m.sku = 'unknown'; }, m => { m.sku = ''; },
      m => { delete m.sku; }, m => { m.root.hardwareProfile.sku = 'intel'; m.sku = 'vm'; },
      m => { m.hardwareProfile.manifestSha256 = '0'.repeat(64); },
      m => { m.root.displayPolicy = hardwareProfile(sku === 'basic' ? 'vm' : 'basic').displayPolicy; },
      m => { m.root.bootstrap.graphicsModules = ['i915']; },
      m => { m.grub.kernelArguments = ['nomodeset']; },
      m => { m.iso.name = 'legacy.iso'; }, m => { m.usb.name = 'wrong.img'; },
      m => { m.nativeRuntime.imageID = 'mutable-tag'; }, m => { m.imageToolsID = 'mutable-tools'; },
      m => { m.sizeReport.media.isoBytes++; }, m => { m.sizeReport.media.rootBytes++; },
      m => { m.sizeReport.packages.pop(); },
      m => { m.packages[0] = { ...m.packages[1] }; },
      m => { m.packages[0] = { name: 'unknown-package', version: '1.0' }; },
      m => { m.packages[0] = { name: 'unknown-package' }; },
      m => { m.sizeReport.packages[0].regularFileBytes = -1; },
    ]) {
      const copy = structuredClone(manifest);
      mutate(copy);
      assert.throws(() => validateLiveLayout(copy), `Invalid ${sku} media accepted`);
    }
    const bad = receipt(manifest);
    bad.sku = sku === 'vm' ? 'full' : 'vm';
    assert.throws(() => validateLiveRootReceipt(manifest, bad), /receipt/);
  }
});
test('new SKU publisher isolates release directories and never changes the stable alias implicitly', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'polly-skus-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const destination = path.join(root, 'published');
  fs.mkdirSync(destination);
  const alias = path.join(destination, 'PollyOS.iso');
  fs.writeFileSync(alias, 'old stable media');
  const reports = [];
  for (const sku of hardwareSkus) {
    const directory = path.join(root, sku);
    fs.mkdirSync(directory);
    const m = media(sku);
    fs.writeFileSync(path.join(directory, m.iso.name), 'synthetic ISO');
    fs.writeFileSync(path.join(directory, m.usb.name), 'synthetic USB');
    fs.writeFileSync(path.join(directory, 'grub.cfg'), 'synthetic config');
    for (const key of ['iso', 'usb']) {
      m[key].sha256 = digest(path.join(directory, m[key].name));
      m[key].size = fs.statSync(path.join(directory, m[key].name)).size;
      m.sizeReport.media[key + 'Bytes'] = m[key].size;
    }
    m.grub.embeddedSha256 = digest(path.join(directory, 'grub.cfg'));
    fs.writeFileSync(path.join(directory, 'live-manifest.json'), JSON.stringify(m));
    fs.writeFileSync(path.join(directory, 'candidate-origin.json'), JSON.stringify(receipt(m)));
    fs.writeFileSync(path.join(directory, 'SHA256SUMS'), fs.readdirSync(directory).sort()
      .map(name => digest(path.join(directory, name)) + '  ' + name).join('\n') + '\n');
    const publication = publish(directory, destination);
    assert.equal(publication.alias, null);
    assert.ok(path.basename(publication.releaseDirectory).includes(`-debian13-${sku}-`));
    assert.equal(fs.readFileSync(alias, 'utf8'), 'old stable media');
    reports.push(await inspectRelease(directory));
    assert.equal(reports.at(-1).sku, sku);
    assert.deepEqual(reports.at(-1).sizeReport, m.sizeReport);
    if (sku === 'full') {
      const explicit = publish(directory, destination, { updateAlias: true });
      assert.equal(explicit.alias, alias);
      assert.equal(fs.readFileSync(alias, 'utf8'), 'synthetic ISO');
      fs.unlinkSync(alias);
      fs.writeFileSync(alias, 'old stable media');
    } else assert.throws(() => publish(directory, destination, { updateAlias: true }), /Only the explicit full/);
  }
  assert.equal(new Set(fs.readdirSync(destination).filter(name => name !== 'PollyOS.iso')).size, 6);
  assert.equal(compareReleases(reports[0], reports[1]).sameSku, false);
});
