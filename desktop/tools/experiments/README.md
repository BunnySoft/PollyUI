# Experiments

These scripts are reference experiments for the size-SKU work, not supported
build entry points. They may assume the Polly Debian SDK and a Linux host with
Podman/KVM.

## Pixman / CPU-only wlroots

- `pixman-build.sh` — build wlroots 0.19.3 with no GLES/Vulkan/GBM allocator,
  then build `tinywl`. Reuses the patched source in the SDK and removes the
  DRM DMABUF guard.
- `pixman-client.c` — minimal SHM Wayland client used to prove visible DRM
  output. Generate `xdg-shell-client-protocol.h` with `wayland-scanner`.
- `qmp-shot.py` — QEMU screendump over QMP.
- `size-breakdown.py` — package-size analysis for a `live-manifest.json`.

The tested result is documented in `docs/PIXMAN-CPU-DRM.md`.

## Micro

The Alpine `micro` prototype is now built and booted: **26 MB** ISO with
Pixman DRM at 1280x800. Build and test entries live in
`desktop/release/micro/`; the prototype is not a supported PollyOS desktop and
has no Rime/PAM/systemd/multi-app shell.

The earlier builder blockers were resolved by adding an Alpine `hwdata`
pkg-config file, `libxkbcommon-dev`, GLES headers for wlroots' unconditional
`gles2.h` include, and using `LIBSEAT_BACKEND=noop` for the single-app test.
