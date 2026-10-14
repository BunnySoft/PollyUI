# Memory-only UEFI development image

**Alpha.8 physical feedback (2026-10-11):** the user reported that actual testing
of the delivered Alpha.8 ISO passed. Record this as user-reported physical
acceptance, not an independently measured hardware/cursor-plane, per-feature or
endurance matrix. The exact delivered ISO and candidate receipts below remain
unchanged. Complete automated VM acceptance is still absent, and the retained
native-mouse failure and earlier Alpha.7 issues are not retroactively resolved.

**Alpha.8 candidate published, not fully qualified:** the user's selected
candidate mode permits delivery without complete VM acceptance. The ISO is under
`dist\pollydesktop-0.1.0-alpha.8-debian13-a357a7d-candidate\`,
707868672 bytes, SHA-256
`07e1fe3292275a577ff20d9d44d62d4d5981c4d6b312d1cc828ad8d14eeeadb4`.
Read `CANDIDATE-NOT-FULLY-QUALIFIED.txt`, `candidate-status.json`,
`candidate-origin.json`, `retained-provenance.json` and `SHA256SUMS`.
The actual clean Git Release runtime is `0.1.0-alpha.8` /
`a357a7dce3b1da11c5881ab354912c6e18159a9a`; its compiled application identity
and frozen package checks passed. All 240 package pins were compared anew:
237 match the immutable base and three exact cached file/libmagic inputs supply
the delta. Actual ISO streaming verified 240 runtime files plus six overlays,
their modes/owners and origin receipt, including all 75 Xcursor files and two
theme indexes under `usr/share/icons/PollyRabbit` and `PollyClassic`.
The overlay/ISO integrity producer is separately
`d2a41b59f7ee0ac77529dc10e426923b00015018`; the ISO builder and baseline harness
remain at the frozen runtime revision.

One normal optical OVMF/KVM baseline passed: 4 GiB, two vCPUs, ordinary seat0
DRM/PAM, Chinese IME commit, native clipboard and workspace switching. No writable
guest disk, NIC, host share, host audio or physical device was attached. This is
**baseline boot/input only**, not complete Settings/theme/Files VM acceptance or
physical hardware cursor-plane qualification. Twelve core native checks passed;
the first build's additional `desktop-native-mouse` failed its expected `c04020`
paint assertion and was not rerun or declared passed. Its raw CTest log remains,
but its original private HOME/screenshots were lost after an evidence-export
failure; no reconstruction is claimed. The final second build's native tar
archives preserve modes/owners despite Windows directory-copy failures.
At delivery, complete VM and physical acceptance were unverified. The later
user-reported physical feedback above does not change those original receipts;
complete VM acceptance remains absent, and historical Alpha.7 issues
below have not been fully retested or declared fixed. Preserve all older images
and failures. The earlier `36b7e4b` WSLg preview exited independently; it is a
separate build, not Alpha.8 media, and was not restarted.
See [the Alpha.8 gate](../ROADMAP.md#alpha8-rabbit-cursor-candidate).
After publication, the parent independently verified all 48 delivery checksums,
the same ISO bytes, all 246 runtime/overlay files in the actual initramfs, and
the 77 installed cursor-theme files against source and package hashes. The
baseline result and original desktop/workspace screenshots were also reviewed.
These integrity checks do not change the candidate's incomplete-acceptance label.

**Alpha.7 unqualified test candidate:** the user explicitly chose delivery for
their own physical-machine testing despite incomplete VM acceptance. The ISO
is under `dist\pollydesktop-0.1.0-alpha.7-debian13-31da563-unqualified-test\`,
707733504 bytes, SHA-256
`25a031343d84850bd738ea8a1f0a07342abe797effb3253d68869891fb7e17b4`.
Read `UNQUALIFIED-NOT-FOR-ACCEPTED-HANDOFF.txt` and `candidate-status.json`.
This is not a fully accepted image: VM keyboard theme selection was inconsistent,
one Settings reopen exceeded its existing 20-second bound with unresolved cause,
and the new ISO-level Files interaction journey was not completed. Native
fixture/package and ISO-byte checks do not replace those missing VM gates.
Original failed/diagnostic evidence is retained, including an incomplete RPC
export. There is no passing complete VM result or physical-hardware claim.

**Historical Alpha.7 source freeze:** `31da563` used `0.1.0-alpha.7`, including the
modern Shell/Settings/Files, JS iwd service, native mouse interaction mechanisms,
and Files text-selection/scrollbar/keyboard-focus polish. Fresh runtime packaging
and ISO content verification passed; complete VM qualification remains blocked.
No physical-machine pass is claimed here. The release producer used the exact
clean freeze commit and record actual build identity, not reuse alpha.6 binaries.
No extra file operations, animated rabbit cursor or materials are in this scope.
See the [Alpha.7 gate](../ROADMAP.md#alpha7-files-interaction-and-physical-test-candidate).

**Historical physically accepted image:** Debian alpha.6, frozen runtime `c9b1fcd`.
The optical ISO passed complete normal OVMF/KVM acceptance, including ordinary
seat0 DRM, Chinese input/clipboard/workspaces, native Files/JSON and independent
Settings selection, user-theme reload/restore, About and close/reopen.
The ISO is 707723264 bytes; SHA-256:
`9f34b85523bbfcb3ec8d4ed022fa1c21da380ada6cb7ed10a8b90722dcf2753b`.
See the [Alpha delivery gate](../ROADMAP.md#new-architecture-alpha-delivery-gate)
and the generated artifact's qualification/provenance records.
On 2026-10-11 the user reported that physical-machine testing of this Alpha passed.
Record this as user-reported acceptance of the delivered image, not independent
per-device, feature or endurance measurements.
The generated USB image has not received this run's optical-boot qualification.
The final optical handoff is under
`dist\pollydesktop-0.1.0-alpha.6-debian13-c9b1fcd-physical-test\`.
It includes `qualification.json`, `HANDOFF.txt`, the VM result/logs/screenshots
and `SHA256SUMS`; all 15 artifact checksums were verified after publication.
The original candidate remains unchanged in its separate directory.

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

## Continuous Live startup (source-wired; new media acceptance pending)

New Debian Live builds use an original Polly monogram and the same `#101824`
background across the graphical UEFI GRUB menu, standard Plymouth DRM/framebuffer
display, and the compositor's initial scene. The monogram comes from
`release/live/boot-brand.h`; Python's standard library generates its PNG for
GRUB/Plymouth, and PollyWM draws the same geometry without a new GPU feature.
The normal entry retains the GRUB framebuffer and reduces routine kernel,
udev and systemd chatter. Firmware, kernel decompression and device mode changes
remain hardware-controlled; source wiring does not guarantee zero black frames
on every machine. CPU/Pixman rendering remains the default.

The graphical menu is an original Polly startup selector, not Clover/OpenCore
or firmware replacement. GRUB's native **vertical** `boot_menu` provides the
rounded selection frames, original 32-pixel class icons and keyboard navigation;
it does not promise mouse input, horizontal cards or animation. The main menu
contains **Start PollyDesktop Live (memory only)** (default index 0) and
**Advanced startup**. Advanced contains GPU automatic selection, Intel GPU,
verbose startup, diagnostics console, and the serial VM baseline, in that order,
with the original kernel/search/initrd commands unchanged. Entering Advanced
disables automatic boot (`timeout=-1`); its initial selection is GPU, not a
different hidden normal-boot default. Esc returns to the main menu. No installed
OS entries, disk discovery, mounts or chainloading are added.

The main menu's **8-second** countdown is GRUB's real `__timeout__` component,
not startup progress; keyboard navigation cancels it. Up/Down selects,
Enter starts/opens, E edits a boot entry, and C opens GRUB's console.
Esc here means back, not Plymouth boot details. The layout supports 640x480
and above; Advanced scrolls with the selection and shows a scrollbar when its
five rows do not fit. Explicit supported graphics modes never request a layout
below 640x480. Missing graphics modules, font/theme, or an unavailable supported
video mode leave an explicit **console + serial** text menu; GRUB theme-rendering
errors retain its standard text-menu fallback and serial output.
`release/live/boot-assets.py --theme DIRECTORY` generates the original menu
icons and nine-slice frames. The Debian media builder embeds all these resources,
the unchanged monogram, theme and existing Unicode font in `BOOTX64.EFI`;
Plymouth's `logo()` bytes remain unchanged.

Only the **final Debian Live layer** installs `plymouth` and `libplymouth5`
**24.004.60-5** from Debian trixie. Its built-in script plugin is sufficient;
no desktop environment, `plymouth-themes`, new account or authentication service
is added. `release/debian/boot-dependencies.json` and `boot-files.json` declare
the pins and overlay. `boot-install.py` installs/verifies the exact source bytes,
owners, modes and plugins. The platform/installed layers do not inherit this
installation. The cached profile-only recipe remains a historical account-policy
fixture, not a way to silently qualify old boot payloads for new media.
The Live-only getty drop-in keeps the same `--autologin polly` identity while
using `--noissue --skip-login`, `--noclear` and `.hushlogin` to avoid repainting
login banners over the retained image; PAM and login session registration remain
unchanged.

| Stage | Actual trigger / completion |
|---|---|
| UEFI | GRUB loads its embedded font, menu theme and monogram; it falls back to text if graphics are unavailable |
| System | `polly-live-splash.service` runs after udev starts; activity dots mean waiting, never a measured percentage |
| Session | `polly-live-handoff.service` runs after logind/user-session startup, tells Plymouth to retain its last image and release display ownership before the existing tty1 autologin |
| Desktop | The ordinary-user compositor temporarily draws the matching startup scene while the private Shell initializes |
| Usable desktop | Private Shell wallpaper and panel buffers are mapped on every enabled output, a workspace and input device exist, the Live IME is bound, the real seat is active, and each desktop frame has an actual matching output-present event |

`POLLY_LIVE_STARTUP=1` enables this compositor gate only for the Live session;
`POLLY_LIVE_SPLASH=1` additionally enables its visual scene. The existing
session-status protocol and ordinary/installed startup defaults are unchanged.
`POLLY_LIVE_DESKTOP_READY outputs=N` is now emitted by that native presentation
gate, not the old one-second JS timer. Merely starting the compositor, scheduling
a Shell, submitting a buffer or acknowledging a handoff is not ready. Disabled
and disconnected outputs do not hold readiness; later hotplug does not restart
the boot overlay. This is a startup-operability condition, not per-feature or
physical-hardware acceptance.

The Live supervisor retains a mode-0600 `~/polly-session-*` log and streams the
original output to the journal. Desktop startup has a **90-second** bound,
starting at the ordinary-user session launcher, not at firmware power-on.
It terminates only its own failed launch group, lets the session clean up, and
returns to the existing ordinary user's console with **Retry / Collect
diagnostics / Console** choices. Normal logout still ends at that console.
System-display start/handoff units have separate 15-second limits; failed
handoff stops only the guest's own Plymouth service so it cannot keep the
display from diagnostics. Earlier kernel/system failures retain normal kernel,
systemd and journal reporting; there is no fake successful desktop fallback.

**Diagnostics:** Esc shows Plymouth's boot details while it owns the display.
The GRUB **Advanced startup** submenu keeps explicit **verbose**, **diagnostics
console** (no automatic desktop) and **serial VM baseline** entries; the serial
entry remains last in Advanced. The existing Live boot harness opens this
submenu before selecting its last entry and still accepts historical flat menus.
In the unlocked active Live DRM session,
Ctrl+Alt+F1..F12 requests standard logind/libseat VT switching; F2 offers a
separate console and F1 returns to the desktop. An unsupported backend or denied
seat request is logged explicitly. No lock-state bypass or new installed-system
VT policy is added. Use `polly-live-diagnostics`, `journalctl -b`, and the private
session logs before shutdown; all remain in RAM and should be reviewed before
sharing.

This source change **does not rebuild, replace or requalify Alpha.8 or any older
media**, and does not change `VERSION`, signing, account/PAM policy or installed
first-run setup. Current profile-aware source keeps the already-public Live
presets (`polly/polly`, root maintenance password `polly`); older delivered media
keeps its original credential state. Autologin and public presets are not
authentication or a secure lock.

Focused supervisor/configuration checks and a bounded wlroots headless fixture
cover real native frame presentation, rejection of incomplete/wrong Shell
layers, and removal of a blocking disconnected output. Those are **not an ISO
boot**. A newly built target image still needs one normal UEFI boot-to-interactive
desktop check, visible early-boot/timeout/verbose fallback review, and physical
display-transition confirmation. No such new-image or physical acceptance is
claimed by source or native-fixture results.

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

For the frozen offline Debian candidate path, use immutable local image IDs,
`--pull=never` and `--network=none`, and compare every new runtime package pin
against the actual base inventory before assembling the exact cached delta.
`Containerfile.offline-live` clears only the owned Polly runtime namespaces,
including `usr/share/icons/PollyRabbit` and `usr/share/icons/PollyClassic`;
`offline-live-overlay.py` rejects any old or unlisted file in those namespaces.
`verify-live-runtime.py` independently streams the actual ISO initramfs and
checks every packaged runtime/overlay file's bytes, mode and owner, the origin
receipt, and unexpected Polly files, including cursor assets outside
`usr/share/pollyui`. Preserve separate runtime-freeze and media-producer revisions:
a producer-only integrity fix does not change the frozen runtime identity.
These checks do not establish boot, complete VM or physical-hardware acceptance.

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

For Alpha.7, the ordinary-user RAM fixtures check the actual installed runtime's
application metadata against the explicitly selected frozen revision, release
and clean-source state. Production GetAbout/GetAppearance remains restricted to
the current owned Settings PID; an external probe does not bypass that boundary.
Settings captures retain the visible release footer and full About build text
for independent visual review. Each theme keyboard action first uses a real
neutral content-header pointer press/release, with a fresh screenshot-bound
geometry approval (`--settings-geometry-approvals DIRECTORY`). This establishes
the native body focus origin without invoking a theme control. Before, neutral
and after snapshots remain evidence; stale approvals are refused, and original
guest-action deadlines are unchanged. A separate production Files
window is observed, not controlled through its controller: QMP USB pointer/key
events exercise outside-window text capture, clipboard selection, Shift editing,
scrollbar capture/release, viewport paging, focus and disposal. These bounded VM
checks complement the independent normal/narrow native Files qualification;
they do not qualify physical input devices or install fixtures in the ISO.
The installed Files entry also gets a screenshot-reviewed neutral native focus
click before its one Alt+F4 close request. Its original PID must disappear within
10 seconds; observer disposal has the same bounded read-only wait, without another
close request or process kill. These new safety/observation steps increase the
maximum harness work time; they do not extend product RPC deadlines or the
Files observer's 60-second lifetime.
Observer startup must report a ready production view with laid-out controls within
its existing 10-second startup bound, not merely create a snapshot file. Complete
guest JSON records are rejected above the 8192 UTF-8 byte logger limit, counting
the marker prefix and complete JSON; they are never silently shortened. Native Files gesture
coordinates are checked against the actual screenshot and calibrated client bounds.

The optional `--settings-rpc-profile` lane is explicitly **diagnostic, not
acceptance**. It retains private-session `dbus-monitor --profile` headers, bounded
standard daemon PID/UID queries, exact public-starter PIDs and full logs while
keeping the 20-second launcher deadline. It preserves the ordinary boot/input/
theme/page prerequisites, stops after reopen or its first failure, and exports
only fixed non-credential process-environment keys. Observer lifetime is bounded
to 360 seconds. It writes `rpc-diagnostic.json`, never a passing `result.json`;
no instrumented production JavaScript, ambient bus or package installation is used.

Guest action records must contain one complete JSON object from the actual
`polly-vm-check` logger. A timestamped kernel record appended on the same console
line is retained separately without changing the action result; arbitrary
suffixes, extra JSON, duplicates and truncated objects fail. The original raw
serial remains intact, and fatal records in the action's fresh log window are
not hidden by parsing.

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
