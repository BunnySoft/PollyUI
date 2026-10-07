// Entirely synthetic snapshots and acquisition callbacks, never host enumeration.
const MiB = 1024 * 1024;
export const measurements = {
  payloadBytes: { EFI: 8 * MiB, SYSTEM: 1200 * MiB, PERSISTENT: 100 * MiB, RECOVERY: 400 * MiB },
  headroomMiB: { EFI: 64, SYSTEM: 512, PERSISTENT: 1024, RECOVERY: 64 },
};
const messages = {
  'protected-model': 'This model family is explicitly excluded; do not install on it.',
  'external-provenance-unknown': 'Only corroborated USB media passes this policy; RM alone is insufficient.',
  'not-physical-disk': 'Only a complete whole physical disk may be an installation target.',
  'active-root': 'The disk backs the running root and must remain excluded.',
  'active-boot': 'The disk backs current boot files and must remain excluded.',
  'active-source': 'The disk backs installation input and must remain excluded.',
  mounted: 'The disk or a descendant is mounted; this tool will not unmount it.',
  'conflicting-evidence': 'lsblk and kernel evidence disagree; refresh, do not select this node.',
  'insufficient-capacity': 'Use media large enough for the measured payload and explicit reserves.',
};
const reason = (code, detail) => ({ code, message: messages[code], ...(detail === undefined ? {} : { detail }) });
const clone = value => JSON.parse(JSON.stringify(value));
function disk(name, dev, model, serial, wwn, usb = true) {
  return { name: '/dev/' + name, path: '/dev/' + name, kname: name, 'maj:min': dev,
    type: 'disk', size: 16 * 1024 * MiB, model, serial, wwn, tran: usb ? 'usb' : 'nvme',
    rm: false, ro: false, 'log-sec': 512, pkname: null, mountpoints: [null],
    fstype: null, uuid: null, partuuid: null, start: null, pttype: 'gpt' };
}
function part(parent, name, dev, size) {
  return { ...clone(parent), name: '/dev/' + name, path: '/dev/' + name, kname: name,
    'maj:min': dev, type: 'part', size, pkname: parent.kname, start: 2048, pttype: null,
    fstype: 'ext4', uuid: 'fixture-filesystem', partuuid: 'fixture-partition' };
}
function kernel(raw, parent = null) {
  return {
    sysfsPath: (parent ? parent.sysfsPath + '/' : raw.tran === 'usb' ?
      '/sys/devices/pci0000:00/usb1/1-1/block/' : '/sys/devices/pci0000:00/nvme/nvme0/') + raw.kname,
    dev: raw['maj:min'], sizeSectors512: raw.size / 512, logicalSectorBytes: 512,
    readOnly: false, removable: false, diskseq: 7, partition: parent ? 1 : null,
    startSector512: raw.start, parent: parent?.dev ?? null, holders: [], slaves: [],
    partitions: (raw.children ?? []).map(child => child['maj:min']),
  };
}
export function fixtureSnapshot() {
  const host = disk('nvme0n1', '259:0', 'WD_BLACK SN770 2TB', 'FIXTURE-HOST', '0x1111111111111111', false);
  const root = part(host, 'nvme0n1p1', '259:1', 4 * 1024 * MiB); root.mountpoints = ['/'];
  const external = disk('sdb', '8:16', 'Fixture External SSD', 'FIXTURE-USB-001', '0x1234567890abcdef');
  const existing = part(external, 'sdb1', '8:17', 256 * MiB);
  host.children = [root]; external.children = [existing];
  const samsung = disk('sdc', '8:32', 'Samsung SSD 990 PRO 4TB', 'FIXTURE-EXCLUDED-A', '0x2222222222222222');
  const sandisk = disk('sdd', '8:48', 'SanDisk SDSSDXPS480G', 'FIXTURE-EXCLUDED-B', '0x3333333333333333');
  const hk = kernel(host), ek = kernel(external);
  return {
    lsblk: { blockdevices: [host, external, samsung, sandisk] },
    sysfs: { '259:0': hk, '259:1': kernel(root, hk), '8:16': ek, '8:17': kernel(existing, ek),
      '8:32': kernel(samsung), '8:48': kernel(sandisk) },
    context: { complete: true, root: ['259:1'], boot: ['259:1'], source: ['259:1'],
      mounts: [{ majorMinor: '259:1', target: '/' }], swaps: [], errors: [] },
  };
}
function capacity() {
  let start = 2048;
  const partitions = Object.entries(measurements.payloadBytes).map(([name, payloadBytes]) => {
    const measured = Math.ceil(payloadBytes / MiB);
    const filesystemOverheadMiB = Math.max(16, Math.ceil(measured / 10));
    const reserveMiB = measurements.headroomMiB[name];
    const sizeMiB = measured + filesystemOverheadMiB + reserveMiB;
    const value = { name, startSector: start, sectors: sizeMiB * 2048, sizeMiB, payloadBytes,
      filesystemOverheadMiB, reserveMiB, type: name === 'EFI' ? 'U' : 'L',
      filesystem: name === 'EFI' ? 'FAT32' : 'ext4' };
    start += value.sectors;
    return value;
  });
  return { layout: 'single-system-independent-recovery', requiredBytes: (start + 2048) * 512, partitions };
}
function partition(raw, k) {
  return { path: raw.path, majorMinor: raw['maj:min'], capacityBytes: raw.size, number: k.partition,
    startSector512: raw.start, filesystem: raw.fstype, uuid: raw.uuid, partuuid: raw.partuuid,
    mountpoints: raw.mountpoints.filter(Boolean) };
}
export function makeFixtureEnvelope(generation = 'synthetic-1') {
  const snapshot = fixtureSnapshot(), plan = capacity();
  const flat = snapshot.lsblk.blockdevices.flatMap(raw => [raw, ...(raw.children ?? [])]);
  const devices = flat.map((raw, index) => {
    const k = snapshot.sysfs[raw['maj:min']];
    const partitions = raw.type === 'part' ? [partition(raw, k)] :
      (raw.children ?? []).map(child => partition(child, snapshot.sysfs[child['maj:min']]));
    const reasons = [];
    if (raw.type === 'part') reasons.push(reason('not-physical-disk'));
    if (index === 0 || index === 1 || index === 4 || index === 5)
      reasons.push(reason('protected-model', raw.model));
    if (index < 2) {
      reasons.push(reason('external-provenance-unknown'));
      for (const code of ['active-root', 'active-boot', 'active-source', 'mounted']) reasons.push(reason(code));
    }
    if (raw.type === 'part') reasons.push(reason('conflicting-evidence', 'partition bounds/diskseq'));
    if (raw.size < plan.requiredBytes) reasons.push(reason('insufficient-capacity', { requiredBytes: plan.requiredBytes }));
    const cleanRaw = clone(raw); delete cleanRaw.children;
    return {
      entryId: 'entry-' + index, deviceType: raw.type, model: raw.model, capacityBytes: raw.size,
      removable: raw.rm, identity: { serial: raw.serial, wwn: raw.wwn.slice(2),
        model: raw.model, capacityBytes: raw.size, logicalSectorBytes: 512 },
      partitions, clearingScope: { kind: 'hypothetical-whole-disk', startByte: 0,
        endByteExclusive: raw.size, partitionTable: raw.pttype, partitions: clone(partitions), performed: false },
      observation: { path: raw.path, majorMinor: raw['maj:min'], kname: raw.kname, kernel: k,
        parents: k.parent ? [k.parent] : [], descendants: k.partitions, transport: raw.tran },
      eligible: reasons.length === 0, reasons, raw: cleanRaw,
    };
  });
  return { schemaVersion: 1, readOnly: true, writeAuthorized: false, generation,
    source: { kind: 'memory', description: 'Synthetic Live source backed by fixture root only',
      downloadedBytes: 1024 * MiB, memoryLogicalBytes: 1708 * MiB, exactSourceMapping: true,
      kernelBasis: ['259:1'], reasons: [] },
    report: { schemaVersion: 1, readOnly: true, writeAuthorized: false, capacity: plan, devices,
      errors: [], limitations: ['Eligibility is not permission to write.',
        'No exclusive access or other mount-namespace/raw-opener proof.',
        'No physical-media or destructive-installation acceptance.'] },
  };
}
export function createFixtureProvider() {
  let count = 0, invalidate = null;
  return {
    readReport: async () => makeFixtureEnvelope('synthetic-acquisition-' + ++count),
    subscribeInvalidation(callback) { invalidate = callback; return () => { invalidate = null; }; },
    invalidate: () => invalidate?.('Synthetic hotplug notification. Refresh and explicitly reselect.'),
  };
}
