# Memory-only UEFI development image

**Current physical-test candidate:** Debian alpha.6, frozen runtime `c9b1fcd`.
The optical ISO passed complete normal OVMF/KVM acceptance, including ordinary
seat0 DRM, Chinese input/clipboard/workspaces, native Files/JSON and independent
Settings selection, user-theme reload/restore, About and close/reopen.
The ISO is 707723264 bytes; SHA-256:
`9f34b85523bbfcb3ec8d4ed022fa1c21da380ada6cb7ed10a8b90722dcf2753b`.
See the [Alpha delivery gate](../ROADMAP.md#new-architecture-alpha-delivery-gate)
and the generated artifact's qualification/provenance records.
This is permission to begin physical testing, not a physical compatibility pass.
The generated USB image has not received this run's optical-boot qualification.

The VM had 4 GiB RAM, two vCPUs, virtio-vga and no NIC, host audio, host shares or
additional writable disk. QMP quit did not test guest power-off. Test-only sources
were injected into guest RAM, not installed in the ISO. An additional ttyS0 login
attempted a second seatless desktop and failed back to its CLI; the primary seat0
desktop stayed alive through all functional checks. Raw failures and earlier
unsuccessful attempts remain preserved, not hidden by the passing result.

The Alpine alpha.4 commands and alpha.5-r2 first-machine history below are retained
as previous physical-validation baselines, not acceptance of alpha.6.
On 2026-10-07 the user confirmed the Debian alpha.5-r2 candidate boots and runs
on physical hardware; per-device and endurance results were not separately reported.
The memory-only format and no-installer/data-persistence limits apply to both.
The separate [installed-development virtual disk](./release/debian/README.md#installed-development-virtual-disk-d1)
uses a normal ext4 disk root and required user-data volume. Its persistence does
not change either Live artifact or turn this builder into a physical installer.
The new [P0 storage target](../docs/POLLYOS-STORAGE-DESIGN.md) is an installed-system
migration with independent recovery, not a change to this Live format or an
implemented rescue partition. Tasks/status are maintained in the
[execution ledger](../docs/POLLYOS-BACKLOG.md#16-完整执行清单与依赖).

The Live builder produces an **unsigned x86_64 UEFI ISO and GPT/FAT32 USB image**,
not an installer.
The preserved Alpine path combines the packaged PollyDesktop runtime with Alpine 3.24's
`linux-lts` kernel, OpenRC, eudev and elogind. GRUB loads Intel early microcode,
the kernel and an
initramfs containing the entire runtime; there is no writable block-device root.
The Debian path uses a minbase-derived runtime, its Debian kernel and
systemd/udev/logind instead of OpenRC/eudev/elogind.

This image prepares a first physical-machine validation preview, with disposable
VM checks before writing any external boot media. The initial
configuration automatically logs in the temporary `polly` user (UID 1000) on
tty1. Root owns system services, while PollyWM, PollyShell, Rime and the private
D-Bus/PipeWire session run as the ordinary user. PAM registers the user's active
elogind session, and libseat uses its logind backend for device access. This
does not make automatic login password-protected. The image deliberately contains
no disk installer, automatic disk mounting or swap configuration. Wired interfaces
matching `eth*`/`en*` use DHCP; iwd owns Wi-Fi configuration and addressing.
Both use openresolv. The ordinary Live user uses iwd's distro-provided `netdev`
policy; this does not grant root or power privileges. Wi-Fi credentials and
files/settings stay in RAM and disappear when the Live system stops.

**Automatic login is not authentication. There is no secure lock screen.**
Do not use this image to protect sensitive information. It does not establish
production signing trust, encrypted persistence, a recovery partition or
hardware compatibility.

## Build

First generate and verify the `0.1.0-alpha.4` runtime package and its runtime
container as described in `README.md`. Then, from the repository root in Linux:

```sh
POLLY_RUNTIME_IMAGE=localhost/pollydesktop-alpha:0.1.0-alpha.4 \
    sh desktop/tools/build-live.sh dist/pollydesktop-0.1.0-alpha.4-live
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

The USB artifact is a regular image file containing a GPT and one FAT32 EFI
System Partition. It boots through `EFI/BOOT/BOOTX64.EFI`, with its own kernel
and initramfs. Construction uses no loop devices, mounts or physical disk writes.
The ISO remains optical media; do not assume that copying an ISO file or
raw-writing the optical ISO is equivalent to writing the USB image.

Outputs include the ISO, `*-uefi-usb.img`, `live-manifest.json`, `SHA256SUMS`, `boot-layout.txt`
and `image-build.log`. Package versions are recorded, but upstream package
availability, source archives and reproducible rebuilds are not guaranteed.
The runtime dependency/license inventory and the Live guest package inventory
are not substitutes for a completed redistribution/source-compliance audit.
No external release is uploaded by this script.

## Validate in a disposable guest

The boot fixture uses OVMF, 4 GiB RAM, two virtual CPUs, virtio-vga and emulated
keyboard/pointer/audio hardware. It attaches **only read-only boot media**:
no writable guest disk, NIC, shared host directory, physical GPU or host audio.
KVM is used only when an already-accessible `/dev/kvm` exists; otherwise it uses
TCG without changing host permissions.

```sh
podman run --rm --network=none --device /dev/kvm --user 1000:1000 \
    -v "$PWD:/workspace" localhost/polly-live-tools \
    python3 /workspace/desktop/tests/live-boot.py \
    /workspace/dist/pollydesktop-0.1.0-alpha.4-live/pollydesktop-0.1.0-alpha.4-x86_64-uefi-live.iso \
    /workspace/build/live-boot
```

Omit `--device /dev/kvm` for TCG. The mount above is available to the test
container for inputs/evidence, **not exported into the guest**. The fixture
records boot logs and screenshots, checks the ordinary-user session and real
guest DRM/libinput backend, and sends virtual keyboard shortcuts to switch to
workspace 2 and back. It also waits for the actual input-method protocol, types
`nihao` into the welcome window's native field, commits Chinese and performs
native clipboard copy/paste. Only fixed success markers are logged, not arbitrary
input content. It stops only its own QEMU process afterward. Existing
evidence is never overwritten.
Pass the `.img` instead and add `--usb` to exercise actual emulated USB mass
storage enumeration and its GPT/ESP, not just an optical boot of the same files.
The fixture explicitly selects the serial VM menu entry; physical boots keep
local logs rather than depending on a serial port.

The original seatd baseline and its PAM/elogind successor were both verified with
OVMF/KVM, virtio-vga, 1280x800, Pixman compositor and
raster PollyUI. Rime and private audio start with the desktop, but this boot
test does not qualify microphone/speaker signal quality, physical Wi-Fi,
DHCP/DNS, Bluetooth, suspend/resume or actual hardware VT handoff.

## Manual use and scope

Attach the ISO as a virtual optical disk to a new UEFI VM with at least 4 GiB
RAM. Use unsigned-development firmware settings in that disposable VM; this
project does not configure or weaken the host's Secure Boot settings.
No guest disk is needed. The image does not provide a BIOS/CSM entry.
Writing the USB `.img` erases its destination: select and confirm an external
USB device separately. No tool in this builder selects a physical destination.
Do not change host Secure Boot, disk encryption or firmware settings automatically.
An unsigned image may be refused by Secure Boot; that is a real boot prerequisite,
not a warning to bypass silently. Before any user-managed firmware change on a
Windows system, ensure its disk-encryption recovery material is available.

After boot, the ordinary user's desktop opens a welcome window. The Polly menu
launches applications; Appearance exposes JSON themes and settings. Workspaces
remain global/manual. Alt+Escape ends the desktop and leaves an ordinary-user
shell on tty1 rather than repeatedly crashing/restarting the GUI.
Boot entries separate baseline DRM/Pixman + raster rendering, GLES GPU rendering,
an explicit Intel-only diagnostic route, and a console without automatic desktop
startup. Intel-only mode requires a display connected to the motherboard and a
unique Intel DRM device; it does not move outputs connected to NVIDIA. The
automatic entries do not assume any particular GPU wiring.

The welcome window exposes Wi-Fi/audio settings, a text/clipboard check field
and local diagnostic collection.
`polly-live-diagnostics` also works from a Live terminal or the diagnostic console.
It writes a private `~/polly-diagnostics.XXXXXX/report.txt` with driver/device,
display connector, ALSA, addressing, session, mount and log information. Unavailable
probes report their failure. It reads no Wi-Fi credential files and uploads
nothing. Reports may contain device identifiers, IP/MAC addresses and application
logs: review them before sharing. Root captures a bounded-lifetime boot report
for the ordinary user; desktop logs remain in that user's temporary home.

The preserved Alpine and previously built Debian media show their actual
`Access denied` power capability state. On 2026-10-08 the user approved normal
shutdown/restart in **both** new Debian Live and installed profiles. The new
shared recipe pins standard polkitd and permits only basic logind actions for
the actual active local `polly` seat session; it adds no custom root proxy or
pkexec/GUI agent. Old media are unchanged, and source-rule checks are not guest
power acceptance. Suspend, hibernate and automatic lid/power-key actions remain
disabled. See [the precise authorization boundary](./SESSION.md#approved-basic-power-authorization-for-debian-live-and-installed-profiles).

## First physical target and acceptance

On 2026-10-07 at 14:07 (UTC+08:00), the user reported that the current Debian
alpha.5-r2 image can boot and run on physical hardware. Record this as successful
physical boot/basic operation, not as an inferred pass for every GPU, network or
audio path. It does not authorize a new media write or imply persistent installation.

On 2026-10-06 the user reported that alpha.4 passed validation on the selected
physical machine. This is user-reported first-stage acceptance, not separately
collected per-GPU/connector measurements or qualification of a wider hardware
matrix. These Alpine artifacts remain the fallback baseline while the planned
[Debian minbase migration](../docs/desktop-base-maintenance.md) is evaluated.

The selected machine is an i7-13700K on ASUS ROG STRIX B760-G GAMING WIFI,
with Intel UHD770, RTX4070Ti and RTX4060Ti, Intel I226-V Ethernet and AX211 Wi-Fi.
Samsung 990 PRO 4TB, SanDisk SDSSDXPS480G and WD_BLACK SN770 2TB are **internal
disks excluded from writes**, not installation targets. Audio is discovered from
actual ALSA devices; a reported NVIDIA HD Audio controller alone does not prove
that a monitor speaker or microphone exists.

The payload includes `i915`, `nouveau`, `igc`, `iwlwifi`, HDA/USB drivers and the
Intel/i915/NVIDIA/SOF firmware packages. Mesa's NVK supports Ada and its Zink path
provides OpenGL on recent NVIDIA hardware; see
[Mesa NVK documentation](https://docs.mesa3d.org/drivers/nvk.html). These package
and upstream capabilities are not proof of this machine's behavior.

The first release gate is a real boot using the user's current display wiring,
ordinary keyboard/mouse operation, app launch and window/focus/workspace/theme
operations, readable text/Chinese input/copy-paste, actual network access, and
audio output/input where connected. Record GPU driver and actual renderer:
CPU fallback success does not qualify GPU acceleration. Repeat cold boots and
one basic usage session, preserving failure evidence. Intel-only testing or
exhaustive three-GPU wiring combinations are diagnostic options, not extra
feature requirements invented for the first preview.

Full file management, portals/recording, comprehensive accessibility, advanced
effects, Xwayland, installation, signed updates and other platforms remain on
the later roadmap, not blockers for this physical-validation preview. Production
security and redistribution compliance are separate claims; do not describe
preparing boot media or passing VM checks as completed physical acceptance.
