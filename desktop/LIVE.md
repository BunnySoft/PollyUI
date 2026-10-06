# Memory-only UEFI development image

The Live builder produces an **unsigned x86_64 UEFI ISO**, not an installer.
It combines the already packaged PollyDesktop runtime with Alpine 3.24's
`linux-virt` kernel, OpenRC, eudev and elogind. GRUB loads the kernel and an
initramfs containing the entire runtime; there is no writable block-device root.

This image is for development in a disposable virtual machine. The initial
configuration automatically logs in the temporary `polly` user (UID 1000) on
tty1. Root owns system services, while PollyWM, PollyShell, Rime and the private
D-Bus/PipeWire session run as the ordinary user. PAM registers the user's active
elogind session, and libseat uses its logind backend for device access. This
does not make automatic login password-protected. The image deliberately contains
no disk installer, automatic disk mounting, swap configuration or network
provisioning. Files and settings disappear when the guest stops.

**Automatic login is not authentication. There is no secure lock screen.**
Do not use this image to protect sensitive information. It does not establish
production signing trust, encrypted persistence, a recovery partition or
hardware compatibility.

## Build

First generate and verify the `0.1.0-alpha.3` runtime package and its runtime
container as described in `README.md`. Then, from the repository root in Linux:

```sh
POLLY_RUNTIME_IMAGE=localhost/pollydesktop-alpha:0.1.0-alpha.3 \
    sh desktop/tools/build-live.sh dist/pollydesktop-0.1.0-alpha.3-live
```

The script builds two scoped Podman images: `localhost/polly-live-base` and
`localhost/polly-live-tools`. Package installation takes place only inside
these containers. The runtime container is exported without running its init.
A Python builder streams that export into a `newc` initramfs, preserving file
modes, guest owners and symbolic links without needing privileged extraction.
Kernel device nodes exist only in the archive. Container-specific runtime
mounts, resolver data and machine IDs are excluded.

The builder refuses existing output directories. It records the source
revision/dirty flag, hashes of the live overlay and builder inputs, the runtime
image identity, exact guest APK versions and the ISO SHA-256. A host whose Git
metadata cannot be read inside WSL may explicitly supply `POLLY_SOURCE_REVISION`
and `POLLY_SOURCE_DIRTY=0` or `1`; neither value is inferred as clean.

Outputs include the ISO, `live-manifest.json`, `SHA256SUMS`, `boot-layout.txt`
and `image-build.log`. Package versions are recorded, but upstream package
availability, source archives and reproducible rebuilds are not guaranteed.
The runtime dependency/license inventory and the Live guest package inventory
are not substitutes for a completed redistribution/source-compliance audit.
No external release is uploaded by this script.

## Validate in a disposable guest

The boot fixture uses OVMF, 3 GiB RAM, two virtual CPUs, virtio-vga and emulated
keyboard/pointer/audio hardware. It attaches **only the read-only ISO**:
no writable guest disk, NIC, shared host directory, physical GPU or host audio.
KVM is used only when an already-accessible `/dev/kvm` exists; otherwise it uses
TCG without changing host permissions.

```sh
podman run --rm --network=none --device /dev/kvm --user 1000:1000 \
    -v "$PWD:/workspace" localhost/polly-live-tools \
    python3 /workspace/desktop/tests/live-boot.py \
    /workspace/dist/pollydesktop-0.1.0-alpha.3-live/pollydesktop-0.1.0-alpha.3-x86_64-uefi-live.iso \
    /workspace/build/live-boot
```

Omit `--device /dev/kvm` for TCG. The mount above is available to the test
container for inputs/evidence, **not exported into the guest**. The fixture
records boot logs and screenshots, checks the ordinary-user session and real
guest DRM/libinput backend, and sends virtual keyboard shortcuts to switch to
workspace 2 and back. It stops only its own QEMU process afterward. Existing
evidence is never overwritten.

The original seatd baseline and its PAM/elogind successor were both verified with
OVMF/KVM, virtio-vga, 1280x800, Pixman compositor and
raster PollyUI. Rime and private audio start with the desktop, but this boot
test does not qualify microphone/speaker signal quality, physical Wi-Fi,
DHCP/DNS, Bluetooth, suspend/resume or actual hardware VT handoff.

## Manual use and scope

Attach the ISO as a virtual optical disk to a new UEFI VM with at least 3 GiB
RAM. Use unsigned-development firmware settings in that disposable VM; this
project does not configure or weaken the host's Secure Boot settings.
No guest disk is needed. The image does not provide a BIOS/CSM entry or claim
USB-stick installer compatibility.

After boot, the ordinary user's desktop opens a welcome window. The Polly menu
launches applications; Appearance exposes JSON themes and settings. Workspaces
remain global/manual. Alt+Escape ends the desktop and leaves an ordinary-user
shell on tty1 rather than repeatedly crashing/restarting the GUI.

Power settings show the actual elogind capability failure and disable shutdown
and restart. The current guest returns `Access denied`; authorization integration
is explicitly deferred, with no polkit or privileged proxy added. Suspend,
hibernate and automatic lid/power-key actions remain disabled. See `SESSION.md`.

Remaining release gates include protected login/lock, power authorization,
file/default-app workflows, cross-login persistence, portals/accessibility,
installation/recovery, production signing and rollback, hardware qualification
and redistribution compliance. The ISO demonstrates a bootable development
desktop, not completion of those requirements.
