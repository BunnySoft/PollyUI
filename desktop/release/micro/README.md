# Polly Micro (prototype)

**Current product name: Mini.** This historical directory and its delivered
`micro-shell.*` artifacts remain unchanged. The canonical product entry is:

```sh
bash tools/build.sh --os mini --plan
bash tools/build.sh --os mini /absolute/output/mini --build
MICRO_PRODUCT=mini MICRO_WORK=/absolute/output/mini \
  sh desktop/release/micro/test-shell.sh --desktop
```

It rebuilds the same Alpine recipe with explicit Mini branding and writes
`mini.iso`, `mini.json` and matching `mini-*-boot.json` reports. It does not
rename an existing Micro ISO or inherit its checksums. Direct old script calls
without `MICRO_PRODUCT=mini` keep the original `micro-shell.*` defaults.

Mini has been rebuilt through the direct `MICRO_PRODUCT=mini` shell entry
(the host had no Node.js; no host packages were installed):

- `D:\temp\PollyOS\mini-92389a08e683\mini.iso`
- 65,286,144 bytes (65.29 MB)
- SHA-256 `92389a08e6833c595b30fca7da2f248e905edef9d1655cc27a55558125faa899`
- Explicit Mini GRUB/welcome branding and `sku=mini`, `product=mini` reports
- GOP/USB and virtio desktop/keyboard/caret/window/application checks passed
- Physical-machine retest remains pending; old Micro images are unchanged

The [SKU / Feature / Component matrix](../../../docs/SKU-MATRIX.md) separates
the product target from actual delivery. The current image adds window
decorations and basic applications; the previous physical-machine report of a
missing desktop bar still needs a retest with this new image. QEMU success is
not a claim that an unknown physical display issue has been fixed.

## Historical Micro UI Shell version

The current Micro target is Alpine/musl + PollyWM + PollyUI Shell, with basic
DejaVu Sans and Mono fonts. It does not include Chinese fonts, Rime or an input method.
Micro prioritizes a small image over 3D support: UI and Canvas 2D retain their
Skia CPU rendering paths, but WebGL2, WebGPU and GPU acceleration are out of
scope. Do not add Mesa/LLVMpipe, Softpipe, Lavapipe or another software 3D
runtime to this SKU. No sufficiently small general-purpose 3D provider has been
qualified for Micro; Canvas 2D performance is a separate measurement.
The current image includes a basic UEFI GOP display path as well as virtio-gpu:

- ISO: **65,286,144 bytes (65.29 MB / 62.26 MiB)**
- SHA-256: `3e2090a252234ab7cb85d03a4fff295710d875fdcb3c6c9ec8861a2548b03eb2`
- 1280x800 desktop, wallpaper, Dock/taskbar and native welcome window visible
- UEFI + standard VGA: actual `simpledrm`/Pixman output, USB keyboard `hello`
  input and USB tablet mouse click delivered to the welcome window
- Virtio GPU and virtio keyboard path also booted with the same ISO
- BusyBox starts seatd and an ordinary UID 1000 session, without PAM or login
- Shared independent Decorator provides real window title bars and controls
- Files, Settings, Processes, File Text and standalone Foot are registered
- Foot, Processes, Settings and Files were opened and closed through real input;
  Files lists the user's home, Processes shows live rows, and Settings uses its
  owned private-bus handshake
- Shared input caret blinking is included from main commit `8a064d5a`;
  both visible/hidden phases were observed in the running ISO
- Welcome-window close leaves the desktop running
- Alpine `6.18.57-0-virt`; no Chinese font or input method
- Source base `8a064d5a`, with the current uncommitted desktop changes explicitly
  recorded as `sourceDirty: true`

The previous 60.87 MB root-session GOP prototype remains at
`D:\temp\PollyOS\micro-shell-gop-48b03625e423\`, SHA-256
`48b03625e42344ff708e19cfe36104863581379e9049ae219ca3e11c12da3d17`.
The original 60.05 MB virtio-only Shell image is retained at
`D:\temp\PollyOS\micro-shell-98448b2c199d\` with SHA-256
`98448b2c199dacc7f8a07d5f55b9c787de1aea9f98f1090650b2dbdc105c6b21`.
The 26 MB result below belongs to the older `tinywl` demo, not either Shell.

### User-reported physical boot (2026-10-20)

After receiving the previous 60.87 MB GOP ISO, the user reported successful boot,
visible output and working mouse/keyboard input on the physical-machine setup
discussed as Quadro P1000. This is a user observation, not independently collected
hardware/driver telemetry: the exact board ID, connector, resolution and DRM
driver were not captured. It establishes basic display/input on that setup, not
all P1000 systems, multi-output, acceleration, hotplug or suspend/resume.
The existing QEMU JSON reports retain their original scope.

```sh
MICRO_WORK=$PWD/build/micro-shell PU_BUILD_JOBS=2 \
  sh desktop/release/micro/build-shell.sh
```

Output: `micro-shell.iso` and `micro-shell.json` in `MICRO_WORK`.
The build reuses pinned wlroots/Skia/SDL sources from the existing Debian SDK but
rebuilds them in Alpine for musl; Debian/glibc binaries are not copied into Micro.
Skia and SDL GPU backends, Chinese fonts, IME and PAM authentication are disabled.
The opt-in `PU_SKIA_RASTER_ONLY=ON` build removes Ganesh surface references from
the Linux engine; existing builds default to OFF. It requires WebGL2/WebGPU OFF
and explicitly rejects `PU_RENDERER=gl` rather than pretending GPU support.
The desktop still links its existing D-Bus, text, image and audio client libraries;
this is not a claim that all corresponding system services are provided.
The existing experimental DRM and SDL SHM patches remain prototype-only.

```sh
MICRO_WORK=$PWD/build/micro-shell MICRO_TOOLS=localhost/polly-sku-live-tools \
  MICRO_DISPLAY=simpledrm sh desktop/release/micro/test-shell.sh --desktop
MICRO_WORK=$PWD/build/micro-shell MICRO_TOOLS=localhost/polly-sku-live-tools \
  sh desktop/release/micro/test-shell.sh --desktop
python3 desktop/tests/micro-shell.py
```

The tools image must provide QEMU, OVMF and Python 3; Pillow is not needed.
The native test checks the ISO against its build SHA, requires Shell startup and
real keyboard delivery, and captures a screenshot. The `simpledrm` profile uses
standard VGA and USB HID with PS/2 disabled, checks the actual DRM driver, and
requires a delivered USB pointer click. It cannot pass by using virtio graphics.
The default profile covers virtio; each has its own SHA-bound boot JSON, serial
log and PNG (`micro-shell-simpledrm-*` versus `micro-shell-*`).
The external build report becomes `qemu-pass` only after both profiles pass for
the same ISO; a single profile is `qemu-partial`.
`--desktop` additionally requires the independent Decorator, laid-out taskbar,
UID 1000, caret blink phases, maximize/restore/minimize/switch/close actions,
basic application launch/close and a surviving desktop after welcome close.
It writes a separate `desktopValidation` result; startup alone does not pass it.
QMP quit is not a normal guest shutdown qualification.
The delivered snapshot is at
`D:\temp\PollyOS\micro-desktop-3e2090a25223\micro-shell.iso`, alongside its reports,
serial log and screenshot. It does not replace the existing `PollyOS.iso` alias.

### Basic physical-machine display path

GRUB retains the UEFI GOP framebuffer (`gfxpayload=keep`); the existing kernel's
`simpledrm` module exposes it as DRM/KMS for PollyWM/Pixman and the CPU Shell.
No new kernel build, Mesa, native Intel/AMD/NVIDIA GPU driver or GPU firmware is
needed for this basic path. An active x86-64 UEFI GOP framebuffer is required;
this is not a promise of generic legacy BIOS/CSM display support.

`shell-modules` is the shared build/runtime module list. Packaging resolves each
module's real dependency closure, including simpledrm and USB xHCI/EHCI/OHCI/UHCI,
HID and evdev. PS/2 support is already built into this kernel. Startup reports
actual DRM device drivers and refuses clearly if there is no DRM display.
The full root is an initramfs loaded by the bootloader; initial boot does not
depend on native NVMe/SATA/USB-storage drivers being added to this root.

The GOP mode is firmware-provided; this is software rendering, not GPU
acceleration or general mode switching. Secure Boot signing is unchanged and
outside this work. This remains a development image without PAM/login,
installer or a complete system-service set. The ordinary-user session retains
the shared Files service's refusal of root/setid operations instead of weakening
that contract. Foot uses a real devpts mount and DejaVu Sans Mono; only its
standalone terminal appears in Applications. Server/client helpers are hidden
from menus, and no foot server is started. Automated qualification
covers QEMU/OVMF standard VGA + USB HID and virtio paths; the limited physical
boot observation is recorded above. Hyper-V, wider physical hardware coverage,
multi-output, suspend/resume and performance remain unqualified.

For the three-tier product definition, see `docs/SKU-SIZES.md`: Mini is this
Alpine desktop; Compact adds Debian and Chinese input using basic GOP/simpledrm;
Standard includes general-purpose drivers/firmware. Compact has no separate
vendor editions. Full is no longer a separate product.

## Historical demo

**This is not a PollyOS Debian desktop.** It is a single-application Alpine/musl
Pixman kiosk used to validate the smallest size tier.

## Current status

- Built and booted in QEMU/KVM with `virtio-gpu-pci`
- ISO: **26 MB** (measured `micro.iso`)
- SHA-256: `cfd9fc2d9edb5dbd77326dada0349f8af1f2d41bdc6ec75f0176301ee70c0495`
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
