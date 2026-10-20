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

## Systemd + PAM + UID 1000 proof (2026-10-20)

The 236 MB prototype boots with **systemd 257 as PID 1** and opens a PAM
session for the graphical user at **UID 1000**:

- Kernel: `systemd.unit=polly.target`
- `Started polly.service` / `Reached target polly.target`
- `POLLY_UID 1000 1000 1000 1000`
- `Seat opened with backend 'seatd'`
- `runuser` opens the PAM session using `/etc/pam.d/runuser`
- PollyWM Pixman modeset at 1280x800
- PollyUI shell, taskbar and welcome UI visible
- Test image SHA-256
  `441855acb8ad06177c06c52ef4c69088bd77ad430c8558b8cd7232cee907be63`
- Units/scripts: `desktop/release/minimal-zh/systemd/`

Still missing from the full contract:

- A graphical login/greeter; the session is opened by `runuser` from root
- `systemd-tmpfiles` and `/sbin/modprobe` helpers are absent, so several
  standard units fail; they do not block `polly.target`
- 236 MB is still below the 300–400 MB target; logind/greeter packages are not
  installed

Chinese input was re-tested on this PAM/UID 1000 image: `nihao` opens the Rime
candidate list and Space commits `你好`.

The earlier non-systemd 236 MB image (`69cbc9…`) is the one used for the
`nihao` / `你好` Chinese input test. The systemd image has not re-run that input
test.

## CPU-only shell + Chinese IME proof (2026-10-20)

The PollyUI shell now renders and performs Chinese input on the Pixman-only
stack:

- **236 MB** test image, SHA-256
  `69cbc9a303d950d079b68409c7fc468ffd8287ed0b6da8721137079111375d66`
- QEMU/KVM + `virtio-gpu-pci`, 1280x800
- PollyWM modeset, PollyUI shell window, taskbar and live welcome UI visible
- udev + libinput + `/dev/shm` are installed; QEMU PS/2 keyboard reaches PollyWM
- Typing `nihao` opens the Rime candidate list (`你好`, `您好`, `逆號`, ...);
  Space commits the first candidate
- WQY Micro Hei font and the 44 MB Rime data tree are installed
- `Input-method protocol ready` / `Input-method engine and protocol initialized`
- SDL software presentation uses the local Wayland SHM framebuffer patch
- Layer-shell windows use `SDL_PROP_WINDOW_CREATE_OPENGL_BOOLEAN=false`
  only when `PU_WEBGL2` is not compiled

This is still a **prototype**, not the final minimal-zh:

- no systemd/PAM/UID 1000 session
- no decorator (`Window decorations disabled`), no `/usr/bin/logger`
- test image is Debian minbase + BusyBox, not the live/systemd contract
- clipboard paste was not separately exercised after the IME commit

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
