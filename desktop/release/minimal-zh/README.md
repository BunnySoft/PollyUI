# Polly minimal-zh (prototype)

**Not yet the full `minimal-zh` SKU.** This directory records the CPU-only native
work required for it. The complete SKU still needs WQY/Rime, systemd/PAM, shell
integration, an APT lock, and a production DRM allocator path.

## What is proven

- **PollyWM** builds against a Pixman-only wlroots prefix
  (`-Drenderers= -Dallocators= -Dbackends=drm`).
- **PollyUI** (with layer shell) builds with WebGL/WebGPU/Metal disabled.
- Neither `ldd` has `libgbm`, `libEGL`, `libGLES`, or `libLLVM`; PollyUI only
  adds SDL3.
- A Debian minbase rootfs + BusyBox PID 1 + Pixman PollyWM boots under
  QEMU/KVM `virtio-gpu-pci`.
- QEMU log: 1280x800 modeset, `PollyWM ready: WAYLAND_DISPLAY=wayland-0`, a
  client is mapped.
- Test image: **169 MB**, SHA-256
  `6a253290cbb6a278284eef1182f87499a32b34062fa65b59b402f988a97716a7`.
  This is a native-compositor proof, not a `minimal-zh` release.

## Build PollyWM / PollyUI

```sh
PIXMAN_DIR=$PWD/build/pixman-exp OUT=$PWD/build/minimal-zh \
  sh desktop/release/minimal-zh/build-pollywm.sh

OUT=$PWD/build/minimal-zh sh desktop/release/minimal-zh/build-pollyui.sh
```

Prerequisite for PollyWM: build the Pixman prefix with
`desktop/tools/experiments/pixman-build.sh`.

Both scripts use `localhost/polly-debian-sdk` and Podman volumes. They check the
final `ldd` and fail if GBM/EGL/GLES/LLVM appears.

## Current shell integration blocker

A local SDL3 Wayland SHM-framebuffer patch was built and linked into PollyUI;
the software renderer can now present to the layer-shell window. In the Debian
minbase test root the shell now loads themes and reaches the compositor
appearance API, then fails with:

```text
[shell] Application discovery failed: TypeError: not a function
Uncaught Error: The active compositor does not support paired regional Shell
backdrops (appearance v8)
```

The next blocker is therefore **PollyWM's native appearance-v8 capability
reporting**, not SDL or JS loading. Do not claim the PollyUI shell is integrated
until this is fixed and a screenshot shows the actual shell.

The SDL patch is experimental and is not yet a supported SDK/runtime input.

## Remaining for the real minimal-zh

1. Package and run PollyUI as the PollyWM shell, with its JS/assets
2. Install WQY Micro Hei + Rime Luna and test Chinese input/fallback
3. systemd/PAM/UID 1000 session and Live media integration
4. APT lock + `--config minimal-zh-vm --build`
5. Replace the experimental DMABUF-guard removal with a supported `drm_dumb`
   path; test input, multi-output, suspend/resume and physical hardware

## Evidence

- QEMU screenshot: `dist/mini-pollywm.png`
- Serial: `/root/serial.log`
- Test image: `/root/mini.iso`
