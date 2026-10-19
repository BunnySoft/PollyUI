const hash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0 && value < 2 ** 32;
import { validateHardwareMedia } from './live-profiles.mjs';

export function validateLiveLayout(manifest) {
  const hardware = validateHardwareMedia(manifest);
  const root = manifest.root;
  if (hardware && !isDeepStrictEqual(root?.hardwareProfile,
    { sku: hardware.sku, manifestSha256: hardware.manifestSha256 }))
    throw new Error('Root/boot hardware profile does not match media SKU');
  if (root === 'initramfs, memory only' && (manifest.schemaVersion ?? 1) === 1)
    return 'legacy-initramfs';
  const boot = root?.bootstrap;
  if (manifest.schemaVersion !== 2 || manifest.distribution !== 'debian13' ||
      root?.kind !== 'squashfs-ram-overlay' || root.path !== 'boot/root.squashfs' ||
      root.copyToRam !== true || root.writable !== 'tmpfs-overlay' ||
      typeof root.mediaIdentity !== 'string' || !/^[0-9a-f]{32}$/.test(root.mediaIdentity) ||
      !hash(root.sha256) || !positive(root.size) ||
      boot?.path !== 'boot/initramfs.gz' || !hash(boot.sha256) || !positive(boot.size) ||
      !positive(boot.uncompressedBytes) || boot.uncompressedBytes > 64 * 1024 * 1024 ||
      !hash(manifest.grub?.templateSha256) || !hash(manifest.grub?.embeddedSha256))
    throw new Error('Unsupported Live root layout/schema');
  return root.kind;
}

export function validateLiveRootReceipt(manifest, origin) {
  const layout = validateLiveLayout(manifest);
  if (Object.hasOwn(manifest, 'sku')) {
    for (const field of ['sku', 'hardwareProfile', 'nativeRuntime', 'imageToolsID', 'sizeReport', 'kernelInput', 'configuration'])
      if (!isDeepStrictEqual(origin[field], manifest[field]))
        throw new Error('Hardware profile does not match actual root verification receipt: ' + field);
  } else if (Object.hasOwn(origin, 'sku') || origin.hardwareProfile !== undefined || origin.configuration !== undefined)
    throw new Error('Unlabelled hardware profile verification receipt');
  if (layout === 'legacy-initramfs') {
    if ((origin.schemaVersion ?? 1) !== 1 || origin.rootLayout !== undefined)
      throw new Error('Legacy root does not match verification receipt');
  } else if (origin.schemaVersion !== 2 || origin.bootstrapVerified !== true ||
      !isDeepStrictEqual(origin.rootLayout, manifest.root) ||
      origin.usbSha256 !== manifest.usb?.sha256 || !hash(origin.usbSha256) ||
      origin.usbPayloadFilesVerified !== origin.isoPayloadFilesVerified)
    throw new Error('Compressed RAM root does not match verification receipt');
  return layout;
}
import { isDeepStrictEqual } from 'node:util';
