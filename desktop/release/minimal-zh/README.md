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

## CPU-only shell proof (2026-10-20)

The PollyUI shell now renders on the Pixman-only stack:

- **202 MB** test image, SHA-256
  `c6517818edeb24021fd64a3bef301088d127e9c9a4e26c97020ff94fe8003a6d`
- QEMU/KVM + `virtio-gpu-pci`, 1280x800
- PollyWM modeset, PollyUI shell window, taskbar and live welcome UI visible
- SDL software presentation uses the local Wayland SHM framebuffer patch
- Layer-shell windows use `SDL_PROP_WINDOW_CREATE_OPENGL_BOOLEAN=false`
  only when `PU_WEBGL2` is not compiled

This is still a **prototype**, not the final minimal-zh:

- no WQY/Rime
- no systemd/PAM/UID 1000 session
- no decorator (`Window decorations disabled`), no `/usr/bin/logger`
- test image is Debian minbase + BusyBox, not the live/systemd contract

The SDL patch is experimental and is not yet a supported SDK/runtime input.

## Previous issues (resolved for the prototype)

- SDL Wayland had no `CreateWindowFramebuffer`; the local patch adds it.
- `--desktop` is required for application discovery.
- Layer-shell creation previously forced an OpenGL window; the build now
  selects it only when `PU_WEBGL2` is enabled.

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
