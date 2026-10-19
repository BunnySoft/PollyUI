# Polly Thin (prototype)

**Not a full PollyOS Debian desktop.** Thin is a Debian minbase userspace with a
BusyBox PID 1 and a Pixman kiosk, used to fill the 150–220 MB tier.

## Current status

- Built and booted in QEMU/KVM with `virtio-gpu-pci`
- ISO: **169 MB**
- SHA-256: `6c1ff04041314f8265ef7f33177167cf152b933a613b71a7ff8e743565be84d1`
- 1280x800 KMS modeset, `drm_dumb` + Pixman, visible SHM client
- Debian 13 minbase + glibc + BusyBox + kmod modules
- No systemd/PAM, no Rime, no WQY font, no multi-application shell

## Prerequisites

- `PIXMAN_DIR` containing `build/tinywl/tinywl` and
  `prefix/lib/libwlroots-0.19-polly-effects4.so` (build with
  `desktop/tools/experiments/pixman-build.sh`)
- Local images: `polly-debian-minbase`, `polly-debian-live-base`,
  `polly-debian-sdk`, `polly-sku-live-tools`
- Podman; KVM for the test

## Build

```sh
PIXMAN_DIR=$PWD/build/pixman-exp THIN_WORK=$PWD/build/thin \
  sh desktop/release/thin/build.sh
```

Output: `build/thin/thin.iso`.

## Test

```sh
THIN_WORK=$PWD/build/thin sh desktop/release/thin/test-qemu.sh
```

Requires OVMF at `/usr/share/ovmf/OVMF.fd` inside the tools image.

## Limits

- The DRM DMABUF guard removal is experimental; SHM direct scan-out still fails
  and wlroots composites into its dumb buffer.
- `LIBSEAT_BACKEND=builtin`; no login/session manager.
- No input, multi-output, suspend/resume or physical qualification.
- This is a prototype, not a supported release artifact.
