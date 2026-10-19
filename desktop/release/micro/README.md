# Polly Micro (prototype)

**This is not a PollyOS Debian desktop.** It is a single-application Alpine/musl
Pixman kiosk used to validate the smallest size tier.

## Current status

- Built and booted in QEMU/KVM with `virtio-gpu-pci`
- ISO: **26 MB** (measured `micro.iso`)
- 1280x800 KMS modeset, `drm_dumb` + Pixman, visible SHM client
- No Rime, PAM, systemd, PollyUI shell, or multi-application desktop

## Build

Requires Podman, KVM only for the test, and the Polly Debian SDK image
`localhost/polly-debian-sdk` (for the pinned patched wlroots source).

```sh
MICRO_WORK=$PWD/build/micro sh desktop/release/micro/build.sh
```

Output: `build/micro/micro.iso`.

The Alpine builder is built from `Containerfile` if
`localhost/polly-micro-builder` is absent. `build-inside.sh`:

1. removes the experimental DRM DMABUF guard
2. builds wlroots with `-Drenderers= -Dallocators= -Dbackends=drm`
3. builds `tinywl` and a small SHM client
4. packs only the virtio-gpu module closure into a BusyBox initramfs
5. creates a GRUB UEFI/BIOS ISO

## Test

Use `-bios /usr/share/ovmf/OVMF.fd` or another UEFI firmware. With
`-vga none -device virtio-gpu-pci -display none`, capture with QMP
`screendump` (see `desktop/tools/experiments/qmp-shot.py`).

The current kernel is Alpine `6.18.57-0-virt`; the module list in
`build-inside.sh` is pinned to that release.

## Limits

- The DMABUF guard removal is experimental; SHM direct scan-out still fails and
  wlroots falls back to compositing into its dumb buffer.
- No input/seat test (uses `LIBSEAT_BACKEND=noop`).
- No physical hardware, multi-output, suspend/resume, or performance qualification.
- Not a supported release artifact.
