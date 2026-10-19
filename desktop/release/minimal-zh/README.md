# Polly minimal-zh (prototype)

**Not yet the full `minimal-zh` SKU.** This directory records the CPU-only native
work required for it. The complete SKU still needs WQY/Rime, systemd/PAM,
PollyUI, an APT lock, and a production DRM allocator path.

## What is proven

- **PollyWM** builds against a Pixman-only wlroots prefix
  (`-Drenderers= -Dallocators= -Dbackends=drm`).
- `ldd` has no `libgbm`, `libEGL`, `libGLES`, or `libLLVM`.
- A Debian minbase rootfs + BusyBox PID 1 + Pixman PollyWM boots under
  QEMU/KVM `virtio-gpu-pci`.
- QEMU log: 1280x800 modeset, `PollyWM ready: WAYLAND_DISPLAY=wayland-0`, a
  client is mapped.
- Test image: **169 MB**, SHA-256
  `6a253290cbb6a278284eef1182f87499a32b34062fa65b59b402f988a97716a7`.
  This is a native-compositor proof, not a `minimal-zh` release.

## Build PollyWM

```sh
PIXMAN_DIR=$PWD/build/pixman-exp OUT=$PWD/build/minimal-zh \
  sh desktop/release/minimal-zh/build-pollywm.sh
```

Prerequisite: build the Pixman prefix with
`desktop/tools/experiments/pixman-build.sh`.

The script uses `localhost/polly-debian-sdk` and a Podman volume. It checks the
final `ldd` and fails if GBM/EGL/GLES/LLVM appears.

## Remaining for the real minimal-zh

1. Build PollyUI/Polly shell against the same CPU-only stack
2. Install WQY Micro Hei + Rime Luna and test Chinese input/fallback
3. systemd/PAM/UID 1000 session and Live media integration
4. APT lock + `--config minimal-zh-vm --build`
5. Replace the experimental DMABUF-guard removal with a supported `drm_dumb`
   path; test input, multi-output, suspend/resume and physical hardware

## Evidence

- QEMU screenshot: `dist/mini-pollywm.png`
- Serial: `/root/serial.log`
- Test image: `/root/mini.iso`
