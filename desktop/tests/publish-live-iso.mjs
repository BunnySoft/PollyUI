import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ALIAS, DEFAULT_DESTINATION, digest, publish } from '../tools/publish-live-iso.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'polly-publish-test-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const destination = path.join(root, 'published');
  const writeJson = (directory, name, value) => fs.writeFileSync(path.join(directory, name), JSON.stringify(value));
  const sums = directory => fs.writeFileSync(path.join(directory, 'SHA256SUMS'),
    fs.readdirSync(directory).filter(name => name !== 'SHA256SUMS').sort()
      .map(name => digest(path.join(directory, name)) + '  ' + name + '\n').join(''));
  function bundle(name, data = 'synthetic ISO, not bootable') {
    const directory = path.join(root, name);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'test.iso'), data);
    const sha = digest(path.join(directory, 'test.iso'));
    writeJson(directory, 'live-manifest.json', {
      version: '0.1.0-alpha.8', distribution: 'debian13', architecture: 'x86_64',
      sourceRevision: 'b'.repeat(40), sourceDirty: false, runtimeImage: 'c'.repeat(64),
      root: 'initramfs, memory only', iso: { name: 'test.iso', size: Buffer.byteLength(data), sha256: sha },
    });
    writeJson(directory, 'candidate-origin.json', {
      runtimeSourceRevision: 'a'.repeat(40), runtimeSourceDirty: false, mediaProducerRevision: 'b'.repeat(40),
      runtimeImageID: 'c'.repeat(64), isoSha256: sha, isoPayloadFilesVerified: 1,
    });
    sums(directory);
    return directory;
  }
  return { root, destination, bundle, sums, writeJson };
}
const same = (a, b) => fs.statSync(a, { bigint: true }).ino === fs.statSync(b, { bigint: true }).ino;

test('real first/second hard links preserve old bytes/inode; retry is idempotent', t => {
  const f = fixture(t), first = publish(f.bundle('first', 'first ISO'), f.destination);
  const inode = fs.statSync(first.iso, { bigint: true }).ino;
  assert.ok(same(first.iso, first.alias));
  const source = f.bundle('second', 'new ISO'), second = publish(source, f.destination);
  assert.ok(same(second.iso, second.alias));
  assert.ok(!same(first.iso, second.alias));
  assert.equal(fs.readFileSync(first.iso, 'utf8'), 'first ISO');
  assert.equal(fs.statSync(first.iso, { bigint: true }).ino, inode);
  assert.equal(publish(source, f.destination).iso, second.iso);
  assert.deepEqual(second.isoFileIdentity, second.aliasFileIdentity);
});
test('checksum failure leaves old alias and unrelated root files untouched', t => {
  const f = fixture(t), first = publish(f.bundle('first'), f.destination);
  for (const name of ['old.iso', 'old.vhdx', 'SHA256SUMS']) fs.writeFileSync(path.join(f.destination, name), name);
  const invalid = f.bundle('invalid');
  fs.writeFileSync(path.join(invalid, 'test.iso'), 'changed after verification');
  assert.throws(() => publish(invalid, f.destination), /checksum mismatch/);
  assert.ok(same(first.iso, first.alias));
  for (const name of ['old.iso', 'old.vhdx', 'SHA256SUMS'])
    assert.equal(fs.readFileSync(path.join(f.destination, name), 'utf8'), name);
});
test('sharing violation retains new version and old alias, never reports success', t => {
  const f = fixture(t), first = publish(f.bundle('first'), f.destination);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === first.alias) throw new Error('sharing violation');
    return rename(from, to);
  });
  assert.throws(() => publish(f.bundle('second', 'new ISO'), f.destination), /alias update failed/);
  assert.ok(same(first.iso, first.alias));
  assert.equal(fs.readdirSync(f.destination).filter(name => name.startsWith('pollydesktop-')).length, 2);
  assert.ok(!fs.readdirSync(f.destination).some(name => name.startsWith('.PollyOS-')));
});
test('hardlink failure cannot silently fall back to copy or symlink', t => {
  const f = fixture(t), first = publish(f.bundle('first'), f.destination);
  t.mock.method(fs, 'linkSync', () => { throw new Error('hard link unavailable'); });
  assert.throws(() => publish(f.bundle('second', 'new ISO'), f.destination), /alias update failed/);
  assert.ok(same(first.iso, first.alias));
});
test('mismatched verification receipt and dirty source are rejected', t => {
  const f = fixture(t);
  for (const [field, value] of [
    ['isoSha256', '0'.repeat(64)], ['runtimeSourceDirty', true],
    ['mediaProducerRevision', 'd'.repeat(40)], ['isoPayloadFilesVerified', 0],
  ]) {
    const directory = f.bundle(field), file = path.join(directory, 'candidate-origin.json');
    f.writeJson(directory, 'candidate-origin.json', { ...JSON.parse(fs.readFileSync(file)), [field]: value });
    f.sums(directory);
    assert.throws(() => publish(directory, f.destination), /receipt/);
  }
  assert.ok(!fs.existsSync(f.destination));
});
test('unsafe checksum paths and conflicting versioned releases are refused', t => {
  const f = fixture(t), directory = f.bundle('badpath');
  fs.appendFileSync(path.join(directory, 'SHA256SUMS'), '0'.repeat(64) + '  ../escape\n');
  assert.throws(() => publish(directory, f.destination), /Unsafe/);
  const valid = f.bundle('valid'), result = publish(valid, f.destination);
  fs.writeFileSync(result.iso, 'modified release');
  assert.throws(() => publish(valid, f.destination), /checksum mismatch/);
});
test('Windows default destination and stable alias are fixed', () => {
  assert.equal(DEFAULT_DESTINATION, String.raw`D:\temp\PollyOS`);
  assert.equal(ALIAS, 'PollyOS.iso');
});
