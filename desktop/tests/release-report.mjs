import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspectRelease, compareReleases } from '../tools/release-report.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'polly-release-report-'));
const digest = value => createHash('sha256').update(value).digest('hex');
const bytes = Buffer.from('test-only-not-a-bootable-image');
const manifest = { version: '0.1.0-alpha.4', architecture: 'x86_64', sourceRevision: 'a'.repeat(40),
  sourceDirty: true, stage: 'development-live-image', distribution: 'debian13',
  root: 'initramfs, memory only', minimumGuestMemoryMiB: 4096, runtimeImage: 'test-image',
  files: 1, uncompressedPayloadBytes: 50, packages: [{name:'example',version:'1.0'}],
  iso: {name:'test.iso',size:bytes.length,sha256:digest(bytes)} };
async function metadata(value) {
  const text = JSON.stringify(value);
  await writeFile(path.join(root,'live-manifest.json'), text);
  await writeFile(path.join(root,'SHA256SUMS'),
    digest(text)+'  live-manifest.json\n'+digest(bytes)+'  test.iso\n');
}
try {
  await writeFile(path.join(root,'test.iso'),bytes);
  await metadata(manifest);
  const first = await inspectRelease(root);
  assert.equal(first.source.dirty,true,'Dirty candidate must not become clean through verification');
  assert.equal(first.artifacts.find(item=>item.name==='test.iso').bytes,bytes.length);
  const diff = compareReleases(first,{...first,payload:{...first.payload,bytes:60},
    packages:[{name:'example',version:'2.0'},{name:'new',version:'1'}]});
  assert.deepEqual(diff.packages.changed,[{name:'example',previous:'1.0',candidate:'2.0'}]);
  assert.equal(diff.packages.added[0].name,'new');
  assert.equal(diff.payloadBytesDelta,10);
  assert.equal(diff.artifacts[0].deltaBytes, 0);
  assert.throws(()=>compareReleases(first,{...first,kind:'runtime'}),/same-kind/);
  await writeFile(path.join(root,'test.iso'),'changed');
  await assert.rejects(inspectRelease(root),/checksum mismatch/);
  await writeFile(path.join(root,'test.iso'),bytes);
  await metadata({...manifest,iso:{...manifest.iso,size:0}});
  await assert.rejects(inspectRelease(root),/does not match/);
  await metadata({...manifest,packages:[{name:'example',version:'1'},{name:'example',version:'1'}]});
  await assert.rejects(inspectRelease(root),/Duplicate/);
  await metadata({...manifest,sourceDirty:undefined});
  await assert.rejects(inspectRelease(root),/explicit dirty/);
  await metadata(manifest);
  await writeFile(path.join(root,'SHA256SUMS'),digest(bytes)+'  ../escape\n');
  await assert.rejects(inspectRelease(root),/checksum line/);
  await metadata(manifest);
  await rm(path.join(root,'test.iso'));
  await writeFile(path.join(root,'external'),bytes);
  await symlink('external',path.join(root,'test.iso'));
  await assert.rejects(inspectRelease(root),/regular files/);
  console.log('PASS: offline release integrity, provenance, comparison and invalid artifact rejection');
} finally { await rm(root,{recursive:true,force:true}); }

const runtimeRoot = await mkdtemp(path.join(tmpdir(), 'polly-local-release-'));
try {
  await mkdir(path.join(runtimeRoot, 'rootfs/usr/bin'), {recursive: true});
  await writeFile(path.join(runtimeRoot, 'rootfs/usr/bin/pollyui'), bytes);
  const patch = 'local source correction', debName = 'local-' + digest(bytes) + '.deb';
  const pkg = {name: 'mesa-libgallium:amd64', version: '1.0+polly1', architecture: 'amd64',
    file: debName, bytes: bytes.length, sha256: digest(bytes)};
  const local = {schemaVersion: 1, kind: 'polly-rebuilt-debian-packages', sourceVersion: '1.0',
    patchSha256: digest(patch), packages: [pkg]};
  const artifacts = new Map([
    ['manifest.json', JSON.stringify({version: '0.1.0-alpha.5', architecture: 'x86_64',
      revision: 'b'.repeat(40), dirty: true, debian: 'trixie', stage: 'development-runtime-bundle', bootable: false,
      files: [{path: 'usr/bin/pollyui', size: bytes.length, sha256: digest(bytes), mode: '0755'}]})],
    ['runtime-packages.txt', 'mesa-libgallium:amd64=1.0+polly1\n'],
    ['sbom.spdx.json', JSON.stringify({spdxVersion: 'SPDX-2.3', packages: [{name: pkg.name, versionInfo: pkg.version}]})],
    ['Containerfile', 'FROM fixture'], ['pollydesktop-test-x86_64.tar.gz', bytes],
    [debName, bytes], ['mesa-lifetime.patch', patch],
    ['mesa-source-inputs.json', JSON.stringify({sourceVersion: '1.0', rebuiltVersion: pkg.version, patchSha256: digest(patch)})],
    ['local-package-SHA256SUMS', digest(bytes) + '  ' + debName + '\n'],
    ['local-packages.json', JSON.stringify(local)],
  ]);
  async function publishRuntime() {
    for (const [name, value] of artifacts) await writeFile(path.join(runtimeRoot, name), value);
    await writeFile(path.join(runtimeRoot, 'SHA256SUMS'),
      [...artifacts].map(([name, value]) => digest(value) + '  ' + name).join('\n') + '\n');
  }
  await publishRuntime();
  assert.deepEqual((await inspectRelease(runtimeRoot)).localPackages.packages, [pkg]);
  artifacts.set('local-package-SHA256SUMS', '0'.repeat(64) + '  ' + debName + '\n');
  await publishRuntime();
  await assert.rejects(inspectRelease(runtimeRoot), /Installation checksums/);
  artifacts.set('local-package-SHA256SUMS', digest(bytes) + '  ' + debName + '\n');
  artifacts.set('local-packages.json', JSON.stringify({...local, packages: [{...pkg, version: '2'}]}));
  await publishRuntime();
  await assert.rejects(inspectRelease(runtimeRoot), /pinned identity/);
  artifacts.set('local-packages.json', JSON.stringify({...local, patchSha256: '0'.repeat(64)}));
  await publishRuntime();
  await assert.rejects(inspectRelease(runtimeRoot), /source patch/);
  artifacts.delete('local-packages.json');
  await publishRuntime();
  await assert.rejects(inspectRelease(runtimeRoot), /inventory is missing/);
  console.log('PASS: local rebuild provenance, package linkage and installation checksum consistency');
} finally { await rm(runtimeRoot, {recursive: true, force: true}); }
