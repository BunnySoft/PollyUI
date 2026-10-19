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

## Micro (WIP)

The Alpine `micro` prototype is not yet a working build. Current blocker:

- Alpine `wlroots` needs `hwdata` at pkg-config time; installing the Alpine
  `hwdata` package does not provide a pkg-config file in this builder.
- The Alpine builder also needs `libxkbcommon-dev`; it was added locally but the
  reproducible recipe still needs to be written.

Do not claim a micro ISO exists until an actual image is built and booted.
