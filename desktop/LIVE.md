# Memory-only UEFI development image

For a new machine, follow [the complete build guide](../docs/BUILDING.md) for
source checkout, native SDK bootstrapping, runtime packaging and ISO generation.
The delivery records below describe historical artifacts, not reusable build
inputs or a requirement to obtain the maintainer's cached containers.

**2026-10-19 compressed RAM-root candidate:** use
`D:\temp\PollyOS\PollyOS-179f20e.iso`, clean runtime/overlay/media source
`179f20e0d28a49071edfae6d0eb57f0cc9b625ac`, 709148672 bytes, SHA-256
`88867bf1a50d326fec2e7251cc7c1372b6d215e2a07bb03f5c270b645194fe89`.
The 4332358-byte bootstrap expands 13120270 regular-file bytes, not the entire
root. The independent 654405632-byte SquashFS is copied to RAM before a read-only
loop/tmpfs-overlay handoff. Actual ISO+USB content and all 145 delivery checksums
passed, including 404 runtime/overlay paths per medium and generated GRUB identity.
**Real boot, startup timing and actual media-eject operation are NOT RUN.**
Windows initially refused replacement of `PollyOS.iso` (`EPERM`), preserving the
old entry and the failed-attempt receipt. After the user reported the handle issue
resolved, a new standard publication succeeded: `PollyOS.iso` and the version-specific
entry now share the verified release inode. No VM/handle was closed by the Agent;
the old 97 release file remains intact. See the current handoff.

**2026-10-19 previous diagnostic candidate (retained):** the stable
`D:\temp\PollyOS\PollyOS.iso` previously pointed to this
clean `97eb6d6fbb11cfb8b55bef5a3ed9cb7734491681` Alpha.8 ISO:
715036672 bytes, SHA-256
`0ce6d1690f9308cc882d61163527af3cb3b3524326ecade07329d85d1a678906`.
The actual ISO includes the enhanced `polly-live-diagnostics` collector
(SHA-256 `00b300c72b875aab942d62be91b15bca1bdc4f8a436152dc0d6f7238eaf863f9`),
the seven-theme catalog including Monterey, and the matched native library;
both experimental backends remain default OFF. All 404 runtime/overlay paths
and 137 delivery checksums were verified. This is not an established black-screen
root cause or boot-delay fix, and **this ISO has not been boot-tested in
UEFI/QEMU, Hyper-V or on physical hardware**. Use Advanced startup → Verbose
startup (no splash) for the user's next Hyper-V test, then collect the private
diagnostics before shutdown. The detailed [current handoff](../docs/POLLYOS-HANDOFF.md)
records the versioned path and unchanged previous media.

**2026-10-18 previous 8433048 candidate (retained):** the stable Windows path
`D:\temp\PollyOS\PollyOS.iso` formerly pointed to this versioned Alpha.8 ISO built from
clean runtime/overlay/media source `8433048a705f2f7b8501d4966ad669ddee7daa73`.
It is 711337984 bytes, SHA-256
`db95f8596b818888a2790c142bed46c2c5b5906bb74ae52b7cea1d59581dd315`.
The new matched ABI4/pin7b58 native library and both default-off backend switches
are packaged. All 328 actual runtime/overlay paths and 125 delivery checksums
were verified, followed by atomic hard-link publication. **This ISO has not been
booted in UEFI/QEMU, Hyper-V or on physical hardware.** Earlier DDD baseline and
historical physical results below do not qualify this new image. Previous
versioned media and the installed VHDX remain unchanged.
See the [current handoff](../docs/POLLYOS-HANDOFF.md) for the versioned path,
source/SDK chain and remaining limitations.

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
systemd/udev/logind instead of OpenRC/eudev/elogind. **Current-source Debian
builds use the compressed RAM-root layout below**, not the historical
full-runtime initramfs. Older delivered images retain their original layout;
Alpine is a historical unsupported path, not qualified by this Debian change.

## Compressed RAM root (new Debian builds; boot qualification pending)

GRUB loads only the kernel, Intel microcode and a bounded bootstrap initramfs.
`boot/root.squashfs` is a separate file on **both** the optical ISO and GPT/FAT32
USB image; it is never embedded in the bootstrap. The early init copies that
compressed file into `/run/polly-live/root.squashfs`, verifies its size and SHA-256,
unmounts the read-only boot medium, and attaches a read-only RAM-backed loop.
SquashFS is the lower root; `upper` and `work` share the same `/run` tmpfs.
The overlay, `/run`, `/dev`, `/proc` and `/sys` survive `switch_root`; the
existing root `/init` recognizes this handoff rather than replacing `/run`.
Systemd, temporary accounts, tty1-only desktop startup, PAM/DRM, IME/clipboard,
workspace contracts and the 90-second desktop gate are unchanged.

The medium can be removed **after** the explicit `Boot medium released` stage.
This is not a media-backed root or persistent installation. No internal
filesystem is mounted writable, no fsck/swap/installer runs, and copy, memory,
module, hash or mount failure stops with a visible error and diagnostic shell,
never an alternate root. At least the compressed root size plus a 1 GiB system
reserve must be available before copying; the supported guest target stays
4 GiB, not a newly measured minimum.

The embedded GRUB config searches only for a unique per-build marker and passes
the selected filesystem's UUID plus the build identity. It does not assume the
standalone GRUB's initial memdisk or the El Torito EFI image is the root medium.
The bootstrap only
reads ISO9660/FAT candidates with that exact UUID and marker, rejects duplicate
matching media, and checks the root hash and size baked into its own archive.
The fixed `POLLYLIVE` label is not an identity or a discovery fallback.
This is local integrity/binding, **not** a signed or authenticated boot chain.

The default/GPU entries retain a static Polly monogram while GRUB loads the
kernel/bootstrap; GRUB cannot animate while blocked on media I/O. Verbose,
console, serial and graphics-unavailable routes print `Loading kernel`,
`Loading bootstrap` and `Starting kernel` only as preceding commands succeed.
Any kernel/bootstrap load failure prints an explicit GRUB error and halts
rather than booting a partial payload.
Early init prints real copy/hash/mount stages with `/proc/uptime` timestamps
before the large copy, also to serial in the serial entry. The retained log is
`/run/polly-live/early-boot.log` and is included by `polly-live-diagnostics`.
The newc writer synthesizes root-owned console/null character entries without
host `mknod`; init opens its console before the first mount. Failures before proc
is available explicitly say `untimed`, never invent a monotonic timestamp.
The bootstrap uses static BusyBox plus `blkid` with its exact ELF loader/library
closure, and only the selected kernel's storage/filesystem module dependency
closure and declared firmware. The builder requires built-in EFI framebuffer,
VT and framebuffer console support; it does not start a second graphics daemon.
Plymouth now starts in early userspace before RAM copy. **Actual Hyper-V screen visibility,
media-detach survival, memory behavior and startup time require fresh boot
qualification.** Smaller structure and earlier source-wired output do not
prove that the user's black interval disappeared or that boot is faster.

`live-manifest.json` schema 2 records the root object
(`kind=squashfs-ram-overlay`, path/hash/size, unique identity, `copyToRam=true`,
`writable=tmpfs-overlay`) and the bounded bootstrap's exact node inventory.
It fingerprints both the GRUB source template and actual embedded generated
config, retaining the latter as checksummed `grub.cfg`. The media verifier
streams actual SquashFS runtime/overlay bytes and checks numeric owner/mode,
origin and unexpected Polly namespaces. USB root/bootstrap/marker must match
the verified ISO. Publication requires a matching schema-2 receipt, USB and
config checksums; it cannot accept an arbitrary root string or a legacy receipt
as compressed-root verification. Exact legacy schema-1/root-string artifacts
remain readable. The low-level builder's explicit `--legacy-initramfs` is only
for historical comparison, never automatic fallback.

Focused Linux checks include `python3 -I -B desktop/tests/live-early-splash.py`,
`python3 -I -B desktop/tests/live-compressed-root.py`
and the existing `live-startup.py`, `verify-live-runtime.py` and
`account-profiles.py`. The same test script's explicit `--mount-handoff`
requires a private container mount/PID namespace (`SYS_ADMIN` in that container)
and exercises actual tmpfs/overlay/mount moves, PID1 `switch_root` and the root
`/init`; it never uses a block device and **does not** test a SquashFS mount,
boot-media discovery, a kernel boot or systemd. Do not confuse these fixtures
with authorized ISO/USB/Hyper-V acceptance.

The image-tools recipe adds `busybox-static`, `squashfs-tools`, `kmod`,
`xz-utils` and explicit `util-linux`; these do not change runtime package pins,
the installed-system builder or the frozen native SDK. Root export validation
rejects traversal, duplicate paths, non-directory parents and unsafe hardlinks
before extraction; symlinks are created last. Ownership, modes, hardlinks and
supported export xattrs (including capabilities) are preserved, and an
unsupported xattr encoding fails rather than being silently discarded.

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

## Optional native backends in current-source builds

Source `8433048` includes two independent startup experiments, both disabled by
default. Images built from earlier revisions do not acquire these switches from
later documentation or from renaming their ISO.

| Startup environment | Unset or exact `0` | Exact `1` |
| --- | --- | --- |
| `POLLY_EXPERIMENTAL_FIR` | Production single-output FIR | Final four-phase FIR |
| `POLLY_EXPERIMENTAL_LAYOUT` | Legacy Yoga pixel-grid behavior | Paired coherent edge/raw-cache corrections |

Set these variables in the environment that launches the desktop session,
before the compositor and GUI applications start. They are not GRUB kernel
parameters or live Settings toggles. Selection is fixed for the scene/process
lifetime; changing an already-running application's environment does not switch
its backend. Empty strings, `true`, `01` and whitespace are rejected explicitly.
FIR opt-in also requires the actual native library to support x86-64 SSE2.

The current source requires its matched ABI4/pin7b58 wlroots library, including
when both switches are off; the old C6/pin01a library cannot satisfy that source
identity. The ISO packages the required library, so users do not install an SDK.
FIR selection does not enable Start material or change recipient permissions,
memory limits or the default solid Start. Historical FIR performance remains
below its complete engineering target. Coherent layout corrects known fractional
edge/cache inconsistencies but has no measured speedup claim; legacy retains
the known one-pixel edge limitation. See the [backend handoff](../docs/POLLYOS-HANDOFF.md).

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
with the same modes and the compressed-root media binding described above. Entering Advanced
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

Only the **final Debian Live layer** installs `plymouth`, `libplymouth5` and `plymouth-label`
**24.004.60-5** from Debian trixie. Its built-in script plugin renders the theme;
`Image.Text` also requires the separately packaged `label-pango.so`; a successful
daemon ping alone never proves that text or the graphical theme rendered.
No desktop environment, `plymouth-themes`, new account or authentication service
is added. `release/debian/boot-dependencies.json` and `boot-files.json` declare
the pins and overlay. `boot-install.py` installs/verifies the exact source bytes,
owners, modes and plugins. The platform/installed layers do not inherit this
installation. The cached profile-only recipe remains a historical account-policy
fixture, not a way to silently qualify old boot payloads for new media.
The Live-only getty drop-in keeps the same `--autologin polly` identity while
using `--noissue --skip-login`, `--noclear` and `.hushlogin` to avoid repainting
login banners over the retained image; PAM and login session registration remain
unchanged.

### Early animation and Esc details

New source starts the same pinned Plymouth daemon inside the bounded bootstrap,
after the required storage/input and Hyper-V/virtio graphics modules load but
**before** copying or hashing the compressed RAM root. The three splash entries
now include the standard `splash` argument: upstream selects the details theme
when only the private `polly.splash=1` argument is present. Verbose, diagnostics
console and serial entries still start without a graphical daemon.

The bootstrap includes only the exported daemon/client, exact recursive ELF
dependencies, script/details/text/label plugins, DRM/framebuffer renderers, theme
assets and one DejaVu Sans font with a minimal fontconfig configuration. It
does not include Python, a whole font directory, a desktop or the compressed
root. All files remain in the exact bootstrap inventory and the **64 MiB
unpacked regular-file limit remains unchanged**. `readelf` in image-tools
resolves these objects from the exported Live root, not from host `/usr`.
The new label package's actual dependencies belong to the final Live inventory;
they must not be disguised as an unchanged old base or old runtime package set.

Before systemd/udev exists, Plymouth uses its supported direct renderer
discovery (`plymouth.ignore-udev`) and legacy kernel-VT keyboard input, not a
second udev/input daemon. The exported kernel includes Hyper-V/virtio DRM module
closures and built-in EFI framebuffer/VT support. No early device/renderer or
failed startup yields an explicit text fallback, not a successful graphical
qualification. Default early stages are logged without painting text over
GRUB's retained image while the graphical display is being prepared.

Plymouth's own **Esc** toggles the graphical theme and console details on the
same boot display, with no login or VT switch. Kernel/console output is captured
using `--attach-to-session`; every large-work stage is both retained in
`/run/polly-live/early-boot.log` and sent as the current graphical status.
Dots mean activity, never measured percentage. `update-root-fs --new-root-dir`
changes the existing daemon's root before `switch_root`; `/run`, PTYs, PID and
resources survive. The systemd helper pings/reuses that daemon without starting
a second one or resetting the selected details view. Unexpected daemon exit
stays visible instead of silently restarting. IPC has finite bounds, and
failed/expired display work is stopped before exposing diagnostics. The 15-second
system service and 90-second desktop gates are not enlarged.

The common Live-only control helper records the root-owned daemon PID and
kernel start time, validates `/proc/exe` (including the old bootstrap's deleted
mapping), and refuses PID0/1 or a mismatched identity. Normal retain-splash quit
remains untouched. Unresponsive IPC gets a one-second client bound, followed by
short exit checks, TERM and, only if still confirmed, KILL. Cleanup confirms
absence or a zombie that has released its file descriptors; otherwise it
reports unconfirmed DRM/input release rather than claiming a console fallback.
The bounded cleanup leaves margin within the existing five-second stop limit.
Hyper-V and virtio GPU modules are alternatives: an unavailable candidate is
logged while other candidates and an existing EFI framebuffer are still tried.

Plymouth's console attachment sends two realtime signals to PID1. The builder
obtains the target libc's real `SIGRTMIN`; bootstrap catches the two signals
with no-op handlers, **not `SIG_IGN`**. Caught handlers reset to default on exec,
so no ignored-signal state is inherited by systemd.

At handoff Plymouth quits with `--retain-splash` and releases DRM/input before
the ordinary user's compositor starts. The existing native Polly image then
bridges to the actual presentation-based desktop-ready gate. **After Plymouth
has exited, Esc belongs to the compositor/apps and no longer toggles Plymouth
details.** There is no new compositor log viewer, privileged relay or alternate
terminal. Plymouth must not retain DRM master while the desktop tries to acquire it.

The final Live layer removes only the two recognized old `polly.conf` and
`live-boot.conf` tty1 overrides, installs `zz-polly-live.conf`, and validates the
effective merged template/drop-ins. This prevents the platform's later-sorting
`ExecStart` from restoring an issue/autologin banner. `--autologin polly`,
`--noclear --noissue --skip-login` and `TTYVTDisallocate=no` remain effective;
PAM, UID1000, installed/template policy and secondary diagnostic consoles do not change.

Component tests distinguish real exported script parsing/font shaping and
same-PID root-switch IPC from control stubs. The isolated IPC test uses only its
own PTY and **does not** attach to the kernel console, use a GPU or prove pixels,
animation or Esc. Fresh authorized ISO/USB/Hyper-V observation is still required
for those properties; the earlier user video describes the preceding image,
not validation of this new feature.

| Stage | Actual trigger / completion |
|---|---|
| UEFI | GRUB loads its embedded font, menu theme and monogram; it falls back to text if graphics are unavailable |
| Bootstrap | Early Plymouth renders the monogram/activity dots and actual RAM copy/hash/root-setup stages; Esc selects details |
| System | `polly-live-splash.service` reuses the early daemon after udev starts; activity dots mean waiting, never a measured percentage |
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
Ctrl+Alt+F1..F12 requests standard logind/libseat VT switching; current-source
secondary logins retain an ordinary diagnostic shell rather than launching
another desktop. F1 requests the original desktop VT. An unsupported backend or denied
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

## Diagnosing a long, silent screen after GRUB

Start with **Advanced startup → Verbose startup (no splash)**. This existing
entry removes `quiet`/`polly.splash=1`, uses `loglevel=7` and
`systemd.show_status=yes`, and keeps the same baseline renderer and desktop
launch. It does not need a rebuilt ISO or change a saved boot configuration.
Esc only reveals Plymouth details after Plymouth is running; it cannot reveal
GRUB file loading or kernel work before that daemon exists.

For a one-boot edit, press **E** on the selected entry, remove `quiet`,
`loglevel=3`, `vt.global_cursor_default=0` and `polly.splash=1` from its `linux`
line, and add `loglevel=7 systemd.show_status=yes`. Keep `rdinit=/init`,
the original `initrd` line and `polly.mode=baseline`; use Ctrl+X or F10 to boot.
Do not begin by adding `nomodeset`, changing GPU/renderer, masking services,
changing memory or rebuilding the image: those alter the path being measured.
`initcall_debug ignore_loglevel` is a separate, very verbose second diagnostic
for a delay already localized to kernel/driver initialization; its logging
overhead can change timings.

### Locate the interval before choosing a cause

Record wall-clock times from selecting the entry to the first Linux text,
then the first systemd text, splash handoff, and the usable desktop. Record
whether a logo/dots ever appeared, whether the desktop eventually opens, and
the actual ISO SHA/source, machine or VM type, RAM, boot medium and display/GPU.
Do not infer the tested ISO revision from the current Git branch.

| Interval | Source-supported explanation to investigate | Evidence |
| --- | --- | --- |
| GRUB selection → first Linux message | `linux`/`initrd` file loading or firmware/media I/O; afterwards kernel initramfs unpacking. The splash cannot cover this whole interval | Stopwatch/video plus verbose first kernel messages; GRUB time is not in the kernel journal |
| First kernel message → systemd | Kernel/driver initialization and initramfs unpacking, then `/init` mounts and `exec /sbin/init` | Earliest `journalctl -b -k -o short-monotonic`; find large gaps around unpacking, firmware and DRM records |
| systemd → tty1/PAM | Unit dependency waits, especially the explicit udev settle → hardware logger → getty chain | `list-jobs`, `critical-chain getty@tty1.service`, actual unit definitions, monotonic start/end properties and journal |
| Plymouth handoff → compositor output | Plymouth exits before getty/PAM, private D-Bus/audio, DRM/logind setup and first compositor output | Handoff/getty/logind journal versus `polly-live`, `polly-login` and `polly-session` records |
| Compositor output → usable desktop | Decorator/Shell/IME or presentation readiness; supervisor waits for actual `POLLY_LIVE_DESKTOP_READY outputs=N` | Private `~/polly-session-*` and tag-filtered journal; output mapping/submission alone is not readiness |

Two specific blind intervals are present in the delivered historical layout, not a proven
diagnosis of an individual user's machine:

- Default GRUB suppresses most kernel messages. This is a memory-root image:
  the delivered `8433048` manifest records **1,509,735,523 unpacked regular-file
  bytes** in a 711,337,984-byte ISO. Loading and unpacking are real work before
  the systemd Plymouth unit. These sizes do not measure their duration. New
  Debian source removes full-root kernel unpacking but still performs real
  media loading, RAM copy and hash work; no measured speedup is implied.
- `polly-hardware-log.service` wants and waits for
  `systemd-udev-settle.service`, and tty1 getty waits for that hardware logger.
  The logger itself runs `lspci -nnk` and `dmesg`. Global udev settle can wait
  on unrelated hardware events; the exact timeout must be read from the
  running image, not guessed. Separately, `polly-live-handoff.service` quits
  Plymouth before getty and does not wait for the hardware logger. Thus a
  retained splash can be handed off while a different getty prerequisite is
  still pending. Whether that display becomes black depends on the real
  firmware/DRM/VT transition.

The desktop supervisor's **90 seconds start only after the ordinary-user
launcher begins**. They do not bound GRUB, unpacking, kernel init, systemd or
the earlier udev/getty wait. Plymouth's unit timeout and its configured device
timeout are different bounds, not a whole-system startup deadline.

### Collect evidence in the running Live guest

If the desktop eventually starts, use its terminal or Ctrl+Alt+F2. If necessary
choose **Advanced startup → Diagnostics console (no desktop)** on the next
boot; that still uses the system/getty prerequisites and is not a bypass of
udev settle. Run as the ordinary Live user:

```sh
cat /proc/cmdline
cat /proc/uptime
cat /usr/share/pollyui/runtime-origin.json
systemctl list-jobs --no-pager
systemd-analyze --no-pager time
systemd-analyze --no-pager blame
systemd-analyze --no-pager critical-chain getty@tty1.service
systemctl cat systemd-udev-settle.service polly-hardware-log.service \
  polly-live-splash.service polly-live-handoff.service getty@tty1.service
journalctl -b -k -o short-monotonic --no-pager
journalctl -b -o short-monotonic --no-pager \
  -u systemd-udev-settle.service -u polly-hardware-log.service \
  -u polly-live-splash.service -u polly-live-handoff.service -u getty@tty1.service
journalctl -b -o short-monotonic --no-pager -t polly-live -t polly-login -t polly-session
polly-live-diagnostics
```

`systemd-analyze time/blame/critical-chain` may report that boot is not finished;
preserve that error and collect `list-jobs`, journal and unit properties instead.
`blame` is not proof of the critical path and normally does not include time
queued before activation or GRUB/firmware time. In a memory-root boot the kernel
may report initramfs unpacking as kernel time rather than a separate systemd
initrd phase; do not add overlapping times. A missing origin file means this
older image does not carry that receipt, not that the source revision is known.

Current-source `polly-live-diagnostics` additionally records these timelines and
monotonic unit properties, including actual timeout settings. Older delivered
ISOs keep their original collector; the individual commands above work without
that collector update. Missing tools/permissions are explicitly retained as
`[unavailable or failed: exit N]`, not replaced by an empty success result.
If kernel logs are denied, use only an already-authorized guest administrator
session to read them; do not weaken host or guest log-access policy.

The report is private/local under `~/polly-diagnostics.*/report.txt`, and both
journal and HOME disappear at shutdown in this memory-only system. Review for
device identifiers, network addresses, filenames and other private data before
exporting. Do not upload a whole report without review.

### Existing 97eb6d6 ISO: collect from the root terminal without a second login

The delivered 97 ISO predates the secondary-login correction: `polly`'s login
shell is `/usr/bin/polly-live-session`, so logging in again on tty2/serial can
start another desktop rather than a shell. Do not use `su - polly`, rerun
`polly-live-session`, `polly-desktop`, `startx`, or `footclient` to collect a
report. `footclient` requires an existing foot server socket and is not the
diagnostics command. Current source reserves automatic desktop launch for
`/dev/tty1`; secondary logins keep a shell after the existing profile/PAM checks.
This source correction does not update the already-generated ISO.

At an existing `root@polly-live` terminal, first check the actual UID:

```sh
id -u
```

If it prints `0`, use the already-authorized guest root session only to execute
the collector as the existing ordinary user, without invoking their login shell:

```sh
runuser -u polly -- env HOME=/home/polly XDG_RUNTIME_DIR=/run/user/1000 /usr/bin/polly-live-diagnostics
```

If `id -u` prints `1000`, run `polly-live-diagnostics` directly. No new compositor
or GPU test is needed. The result ends with
`Saved local diagnostics: /home/polly/polly-diagnostics.XXXXXX`; inspect that
directory's `report.txt`, not just terminal startup warnings. Do not reboot
before saving it. Do not weaken the collector's UID guard to run the full report
as root; missing kernel-log permission remains explicitly reported.

Compositor log timestamps such as `00:00:00.567 ... DESKTOP_READY` are relative
to that compositor's start, not to GRUB selection or kernel boot. An atomic DRM
commit `Permission denied`, followed by seat disable and broken Wayland pipes,
establishes an output failure and later teardown, but not why display authority
was lost; use the logind/getty timeline to distinguish VT switches, multiple
sessions or a driver failure. Seat-disable messages can also be cleanup after
the fatal commit, so their order alone does not prove they triggered the fault.

**Interpretation:** a long gap before the first kernel message is not a Shell
problem. A long/failed udev-settle unit that holds getty identifies a system-unit
wait to investigate. A handoff-to-PAM gap and a PAM-to-ready gap are different
stages. An existing ready marker followed by a black screen is a later
display/session failure, not an unmet startup gate. Do not remove a dependency,
disable splash, increase a timeout or replace a GPU backend as a claimed root
cause fix without the corresponding interval and actual logs.

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
A Python builder preserves file modes, guest owners, links and supported xattrs
in the Debian SquashFS root. The historical Alpine/explicit legacy path streams
the export into a full `newc` initramfs instead.
Container-specific runtime
mounts, resolver data and machine IDs are excluded.

The builder refuses existing output directories. It records the source
revision/dirty flag, hashes of the live overlay and builder inputs, the runtime
image identity, exact guest APK versions and the ISO SHA-256. A host whose Git
metadata cannot be read inside WSL may explicitly supply `POLLY_SOURCE_REVISION`
and `POLLY_SOURCE_DIRTY=0` or `1`; neither value is inferred as clean.

The USB artifact is a regular image file containing a GPT and one FAT32 EFI
System Partition. It boots through `EFI/BOOT/BOOTX64.EFI`, with its own kernel
and bootstrap plus the separate SquashFS root for current Debian builds.
Construction uses no loop devices, mounts or physical disk writes.
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
`verify-live-runtime.py` independently streams the actual ISO SquashFS root
(or the exact legacy initramfs schema) and
checks every packaged runtime/overlay file's bytes, mode and owner, the origin
receipt, and unexpected Polly files, including cursor assets outside
`usr/share/pollyui`. Preserve separate runtime-freeze and media-producer revisions:
a producer-only integrity fix does not change the frozen runtime identity.
These checks do not establish boot, complete VM or physical-hardware acceptance.

### Windows publication and the stable Hyper-V ISO path

After building a **new frozen runtime**, assembling media with the existing
Debian builder, and running `verify-live-runtime.py`, publish that verified output
on the Windows host:

```powershell
node desktop\tools\publish-live-iso.mjs C:\path\to\verified-media
```

The host entry defaults to **`D:\temp\PollyOS`**. It rechecks the bundle's
`SHA256SUMS`, `live-manifest.json`, `candidate-origin.json` and actual ISO bytes,
then copies the verified files into a new versioned subdirectory identified by
runtime revision, media-producer revision and ISO hash. Existing releases, VHDX
files and root-level receipts/checksums are not overwritten. `--destination`
overrides only this host publication root; the cross-platform builders retain
their explicit output-directory arguments. This command is the final publication
step, not a replacement for compilation, image assembly or payload verification.

Only after the copied bundle verifies does the entry create a temporary **hard
link** on the destination volume and atomically replace
`D:\temp\PollyOS\PollyOS.iso`. It never writes through the old alias or mutates
an older release's inode. Its JSON output records both paths, source identities,
size, SHA-256 and matching file identities/link counts. There is no copy or
symbolic-link fallback. A Windows/Hyper-V sharing violation fails explicitly,
retains the new version and leaves the old alias in place; the tool does not
stop, eject, reconfigure or restart any VM. An already-open virtual optical
handle can still reference the previous inode until Hyper-V reopens it.

Publication integrity does not qualify Hyper-V boot, default splash transitions
or physical hardware. Host publication tests use only disposable regular files:
`node --test desktop\tests\publish-live-iso.mjs`. Only Node.js standard-library
modules are used; Windows Python and additional packages are not required.

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
