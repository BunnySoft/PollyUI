import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
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
