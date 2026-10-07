# Debian minbase migration

This is the Debian 13 trixie amd64 migration path. The accepted Alpine alpha.4
source and artifact hashes are preserved in `baseline.json`. Debian is a
separate candidate: on 2026-10-07 the user confirmed alpha.5-r2 boots and runs on
physical hardware. This basic boot/runtime result does not establish full
per-device equivalence; the Alpine fallback and its evidence remain preserved.
The current alpha.5-r2 artifact inventory, architecture and handoff are in the
[PollyOS technical overview](../../../docs/POLLYOS.md).
The [storage design](../../../docs/POLLYOS-STORAGE-DESIGN.md) is now the P0
implementation priority. The layout contract and early `/usr` initramfs mapping
are implemented; the complete single-system image, shared Apps and independent
recovery are **not yet validated**.
Tasks/status live in the [execution ledger](../../../docs/POLLYOS-BACKLOG.md#16-完整执行清单与依赖).

## Fast storage development checks

Run the cached SDK's syntax, five targeted unit suites and strict passwd-proxy
compilation without building a container/image, configuring CMake or starting QEMU:

```powershell
.\desktop\tools\check-storage.ps1
.\desktop\tools\check-storage.ps1 -Mode mounts
.\desktop\tools\check-storage.ps1 -Mode initramfs
```

The equivalent Linux entry is `sh desktop/tools/check-storage.sh [fast|mounts|initramfs]`.
`fast` is the default (about 1.5 seconds inside the cached SDK in this environment).
`mounts` adds actual bind/permission/failure fixtures in a disposable mount namespace;
it needs only the cached storage base and no disk image or VM. `initramfs` checks the
already-packed hook, tools and ordering; a stale cached hook is rejected, not silently
treated as matching current source. None of these modes automatically builds an image,
pulls dependencies, writes host block devices or enables network access.

Use fast checks for each edit and mounts for mapping/identity changes. Actual
image/cold-boot acceptance is still required for boot/partition/kernel changes and
stage handoff, but not after each small edit. Fast checks are not boot evidence.

## Storage overlay and current candidate

The separate `Containerfile.storage` extends the installed base without changing
the historical D1 recipe. Its `local-bottom` hook binds `/System/Resources` before
main-system init. GNU tools use distinct initramfs names because Debian's existing
klibc commands are not interchangeable with their full-featured counterparts.
Mapping errors halt and remain blocked if halt returns; they never open a shell.
The future single-system boot menu must also use `panic=0` for earlier root failures.

The bounded early-mapping fixture needs only an isolated disposable container's
mount capability; it does not launch systemd or write any host block device:

```sh
podman build --network=none -t localhost/polly-debian-storage-base \
    -f desktop/release/debian/Containerfile.storage desktop
podman run --rm --network=none --cap-add=SYS_ADMIN --security-opt seccomp=unconfined \
    -v "$PWD:/workspace:ro" localhost/polly-debian-storage-base \
    sh -c 'python3 -I -B /workspace/desktop/tests/storage-early-usr.py /workspace --initramfs /boot/initrd.img-*'
```

This checks actual binds, fail-closed cases and the packed initramfs's executables
in a chroot with no main-system `/usr` tools. It is not a cold-boot or apt result.

The storage overlay also installs `polly-storage.service` as required by sysinit,
and a root-owned `/usr/sbin/polly-storage prepare|check` backend. It consumes the
versioned manifest, requires the system/persistent/EFI mounts, binds each declared
state/HOME path, remounts the early `/usr` writable and retains the EFI child under
the recursive `/boot` alias. Missing state is never initialized automatically.
APT's update and package pre-invoke hooks recheck readiness; direct dpkg maintenance
and actual package transactions remain separate work.

`desktop-storage-mappings` covers UUID/type/flag and rejection rules. The bounded
`desktop/tests/storage-mount-fixture.py /workspace` command can run in the same
isolated mount-capable container above to exercise actual mappings and writes.
That fixture uses tmpfs; it does not establish ext4 UUID boot or account migration.
The unconfigured container must refuse `polly-storage check` until the image
assembler supplies the manifest and required state; the D1 recipe remains unchanged.

The overlay's account controller accepts schema v3 with `persistentUuid`, while
historical D1 keeps schema v2 with `homeUuid`. New-layout markers never fall back
to D1 if storage readiness is missing. The rebuilt setuid passwd proxy checks the
required storage before entering its private password namespace, still retaining
the real caller UID. An unconfigured ordinary-user invocation is refused.
These adapters and the D1 real PAM/passwd/su regression are checked; new-layout
setup/login/password persistence still require the separately assembled VM image.

`sh desktop/tools/build-storage.sh OUTPUT_DIRECTORY` assembles a separate ordinary
single-system candidate from cached inputs, using measured payload and explicit
reserves. It never changes D1 artifacts. The current prototype's Recovery partition
is **reserved but not bootable**, clearly marked in the manifest and omitted from
the boot menu; independent authenticated recovery remains M10. The first candidate
reached real early `/usr` and systemd but failed required-storage preparation, so
normal setup/login has not yet passed and it is not a usable-system handoff.
Reusing that candidate with matching cached kernel/initrd and console journaling
identified a `/var/tmp` compatibility-directory mode of `1755` instead of `1777`
due to the builder's umask. Explicit chmod and restrictive-umask regression tests
fix the assembly code; the existing r1 image remains unchanged and failed.
The optional smoke harness `--diagnostic-inputs` directory (`vmlinuz`, combined
`initrd`) bypasses firmware only for diagnosis and records `uefiBoot=false`;
it must not be used as UEFI acceptance evidence.

## Minimal root filesystem

From the repository root on Linux:

```sh
podman build --cap-add SYS_ADMIN --target minbase \
    -t localhost/polly-debian-minbase \
    -f desktop/release/debian/Containerfile desktop
podman run --rm --network=none -v "$PWD:/workspace:ro" \
    localhost/polly-debian-minbase sh /workspace/desktop/tests/debian-minbase.sh
```

The slim image is only a bootstrap tool environment. The actual root filesystem
is independently generated by `debootstrap --variant=minbase`, copied into a
scratch stage, and updated from signed `trixie`, `trixie-updates` and
`trixie-security` repositories. Installed package versions are retained in
`/usr/share/polly-minbase-packages.txt`.

Only the bootstrap build needs `SYS_ADMIN` for temporary device/proc mounts
inside its container namespace. This was exercised with rootless Podman;
no privileged container, host init/service invocation or host configuration
change was needed. SDK builds and runtime checks do not require that capability.
`policy-rc.d` prevents package installation from starting services in the build
container. The minbase check rejects desktop task packages and development tools.

## Native SDK and runtime checks

```sh
sh desktop/tools/build-debian-sdk.sh
podman volume create polly-debian-build
podman run --rm --network=none -v "$PWD:/workspace" \
    -v polly-debian-build:/build localhost/polly-debian-sdk \
    sh desktop/tools/check-debian-runtime.sh /build/normal
podman run --rm --network=none -v "$PWD:/workspace" \
    -v polly-debian-build:/build localhost/polly-debian-sdk \
    sh desktop/tools/check-debian-runtime.sh /build/asan --sanitize
```

Generated build files should live on a native Linux filesystem. Debian Ninja's
IPO probe repeatedly returned `EIO` on the Windows-backed checkout; a dedicated
Podman volume fixes this without disabling compiler checks. Source stays mounted
at `/workspace`, and independent normal/sanitized build directories share no
generated objects. None of these checks need bootstrap mount capabilities.

The SDK rebuilds the existing pinned Skia, SDL and static toolkit-free HarfBuzz
for glibc. `sources.json` pins wlroots 0.19.3 and wlr-protocols; stable Debian's
wlroots 0.18 is not a compatible substitute. Source archives are verified before
building. Debian's libinput links libwacom and therefore GLib/GObject: a private
build of the matching Debian source disables optional libwacom model metadata,
without replacing the system library or its quirks data. Its scope and source
version are recorded in `libinput.json`; advanced tablet qualification is not
implied. The runtime uses origin-relative private libraries, not SDK paths.

Only selected Mesa and PipeWire packages come from `trixie-backports`.
Mesa 26 provides the intended recent NVIDIA NVK/Zink path. PipeWire 1.4 did not
acknowledge virtual endpoint volume changes in the equivalent fixture; the
1.6 backport passes those controls. This is not a claim that every PipeWire 1.4
device is unsupported. Runtime packages and their installed dependency closure
are pinned to the actual versions resolved in the SDK.

`librime-data` lists optional schemas whose packages are not installed in a
minimal system. `rime-default.custom.yaml` explicitly selects the intended
`luna_pinyin_simp` schema rather than ignoring deployment errors or installing
unrelated dictionaries. The upstream `default.yaml` is not overwritten.

## Runtime bundle and Live candidate

```sh
podman run --rm --network=none -v "$PWD:/workspace" \
    -v polly-debian-build:/build localhost/polly-debian-sdk \
    node desktop/tools/package-linux.mjs /build/normal dist/polly-debian-runtime \
    /opt/pollyui-sdl /opt/pollyui-harfbuzz
podman run --rm --network=none -v "$PWD:/workspace" localhost/polly-debian-sdk \
    node desktop/tests/package-manifest.mjs dist/polly-debian-runtime
podman build -t localhost/polly-debian-runtime \
    -f dist/polly-debian-runtime/Containerfile dist/polly-debian-runtime
sh desktop/tools/build-live.sh --debian dist/polly-debian-live
```

On a Windows worktree whose Git metadata is not readable inside containers,
provide `POLLY_SOURCE_REVISION` and `POLLY_SOURCE_DIRTY=0|1` from the host,
including forwarding those variables with `podman run -e`. Do not claim a dirty
candidate is a clean-source release. Existing output directories are refused.

The Debian Live recipe uses systemd/udev/logind and Linux-PAM, ordinary-user
temporary auto-login, iwd, wired-only dhcpcd/openresolv, and our private PipeWire
policy. A Live-only D-Bus policy keeps power capabilities/actions denied; no
polkit or privilege proxy is added. No password locking, suspend, disk installer
or persistence is enabled. Package scripts cannot start services in containers;
systemd itself only runs when the completed image boots in a guest.
Automatic APT update/upgrade and filesystem-trim units are masked in this
development Live image. DNS state lives under `/run/polly-network` with narrowly
scoped write access for iwd/dhcpcd, not a writable system root exception.
Downloaded `.deb` files and APT binary caches are removed from the runtime/Live
payload. The payload check rejects accidentally retained installation caches.

The shared builder packages one installed kernel and Intel microcode, retains
the exact Debian package inventory, and generates separately named
`*-debian13-x86_64-uefi-live.iso` and `*-debian13-x86_64-uefi-usb.img` files.
Payload permissions, PAM/script line endings and essential services are checked
before export. Image assembly uses a native temporary filesystem, then publishes
completed artifacts to the destination so Windows mount I/O does not stall ISO
creation. No physical disk, host service or firmware setting is changed.

## Installed-development virtual disk (D1)

This section describes the **existing A/B builder**, retained as historical
evidence and a migration source. It is not the new single-system/recovery
layout; its commands still generate D1-format candidates.

This separate path creates a **new regular disk-image file**, not an installer
that selects or writes a physical device. It reuses a checked Debian Live base
and its corrected Mesa runtime, adds ext4 checking tools, and uses Debian's
normal disk-root initramfs rather than unpacking the whole system into RAM.
The Live ISO/USB builder and existing alpha.5-r2 artifacts remain unchanged.

The initial, user-approved GPT layout is:

| Partition | Default size | Responsibility |
|---|---|---|
| EFI | 256 MiB FAT32 | Unsigned removable-media UEFI entry and embedded boot menu |
| A | 3072 MiB ext4 | First complete system, including its kernel/initramfs, `/etc` and `/var/lib/dpkg` |
| B | 3072 MiB ext4 | Independent complete system and matching package database |
| DATA | 2048 MiB ext4 | Required `/home`: settings, managed application code/registration, AppData and documents |

Filesystem UUIDs, not enumeration order, select the system root and user volume.
`/home` is required before tty1 login; the session checks its UUID again and
refuses to start the desktop on a missing or mismatched volume. Both initial
system slots contain the **same version**. Selecting them is not an implemented
system update, version rollback or data-schema migration.
`/run`, `/tmp` and iwd's `/var/lib/iwd` profiles remain volatile. The rest of
`/var` belongs to its system slot, not shared AppData. No other disks or swap
are configured. Automatic APT updates and the deferred desktop power/lock
policies remain unchanged. The added ext4 tools' unattended e2scrub timer/reap
units are masked; they are not a new disk-maintenance service.

Run these commands **inside Linux/WSL**, from the repository root:

```sh
POLLY_LIVE_IMAGE=localhost/polly-debian-live-base \
    sh desktop/tools/build-installed.sh dist/polly-installed-d1
```

The wrapper checks the supplied Live base before deriving an installed image.
Use a Live base assembled from the intended runtime; an image tag alone does
not prove that it contains the current source. Windows worktrees must provide
the real `POLLY_SOURCE_REVISION` and `POLLY_SOURCE_DIRTY=0|1`, as for Live builds.
Dependencies are installed only in build containers. Assembly uses `mkfs.ext4 -d`,
regular partition files and byte offsets: no loop devices, host mounts, physical
disk access or host-account changes. Existing output directories are refused.

Outputs are the approximately 8.25 GiB `.img`, `installed-manifest.json`,
`SHA256SUMS` and the embedded `grub.cfg`. The manifest records filesystem UUIDs,
partition boundaries, kernel-package inventory, source dirty state, base-image
identity, export hash and recipe/overlay fingerprints. This is integrity and
provenance metadata, not a signed or bit-reproducible release.

For disposable **test-only** images:

```sh
sh desktop/tools/build-installed.sh dist/polly-installed-d1-test --verification-fixture
podman run --rm --network=none --device /dev/kvm \
    -v "$PWD:/workspace" -w /workspace localhost/polly-debian-live-tools \
    python3 -u -B desktop/tests/persistent-boot.py \
    dist/polly-installed-d1-test build/persistent-d1-test
```

Omit `--device /dev/kvm` when unavailable; the fixture can use TCG. It keeps the
original image read-only and creates one disposable qcow2 overlay. Four cold
boots select **A, A, B, A**, checking an actual PollyUI settings namespace,
managed-app installation/registration and localStorage, a user document,
ordinary-user PAM/logind and the native DRM desktop. The fixture enables a
guest-only clean shutdown helper only in explicitly built verification images
and only with `polly.verify-persistence=1`. Regular images do not include that
helper or test application. Evidence directories cannot be overwritten.
No network, shared guest folder, physical disk/GPU or host audio is attached.
Pass `--smoke` with a **regular**, non-fixture image to check ordinary-user
native desktop startup without installing or running the persistence helper.
This check stops its disposable VM rather than claiming a clean guest shutdown
or a persistence run.

Previously generated D1 artifacts retain unprotected automatic login, no
encryption, no update installer and no production signing trust. **Do not write
it to physical media without a separately selected destination and explicit
authorization.** VM persistence is not physical-device or power-loss acceptance.
Administrator initialization is also incomplete: the default `polly` and `root`
passwords are locked, so `su -` currently cannot authenticate. The required next
setup step is local interactive `polly` and independent root-password provisioning,
password login with an administrator-controlled automatic-login option, and an
everyday su entry;
see [console account setup](../../SESSION.md#installed-console-setup-login-and-everyday-su).
The [complete task ledger](../../../docs/POLLYOS-BACKLOG.md) records the confirmed
installed-system defaults, subtasks and acceptance boundaries. These future
requirements do not change existing D1 artifacts or passwordless Live policy.

## Installed console accounts (development follow-up)

The current builder adds local console setup, real PAM password login,
everyday `su -`, and standard `passwd` persistence for the fixed `polly`/root
accounts. The root-managed account database is shared on the required DATA
filesystem; only shadow lookup uses Debian `libnss-extrausers`, not shared
system `/etc` or `/var`. Python is an explicit installed account-controller
dependency. The compatibility password binary is built with the pinned
`POLLY_SDK_IMAGE` (default `localhost/polly-debian-sdk-mesa:polly1`).
Its restricted setuid/namespace contract is described in
[session foundation](../../SESSION.md#installed-console-setup-login-and-everyday-su).

Inside Linux/WSL, create a **new** output directory as before:

```sh
sh desktop/tools/build-installed.sh dist/polly-installed-accounts
```

On first boot, set `polly` and root passwords locally. TTY1 then requires the
`polly` password; the graphical desktop still runs as UID 1000. In a terminal:

```sh
su -
passwd
passwd polly
polly-accounts autologin on
polly-accounts autologin off
exit
```

The two autologin commands are alternatives. Changes apply on the next boot;
logout does not automatically log back in. Image templates contain no usable
passwords, including no locked personal password hashes. Schema-v1 development
prototypes are superseded, not silently migrated or reset.

Verification images additionally include an explicit guest-only account
fixture. It generates temporary passwords in memory, exercises real setup,
ordinary-user password changes and correct/wrong/old root-password su, then
checks password-record retention across A/A/B/A. No fixture passwords are
embedded in the image or written to serial logs. Regular `--smoke` verification
instead provisions the normal first-boot console interactively and enters the
required password before checking native desktop readiness. It still stops
the VM rather than claiming a clean shutdown or persistence acceptance.

The verified schema-v2 follow-up is retained separately from the old D1 and
schema-v1 prototypes:

| Candidate directory | Evidence | Scope |
| --- | --- | --- |
| `dist/pollydesktop-installed-accounts-r2` | `build/persistent-accounts-smoke-r2/result.json` | Normal first-boot setup and required password before UID-1000 native desktop; VM stopped, not clean-shutdown acceptance |
| `dist/pollydesktop-installed-accounts-verification-r2` | `build/persistent-accounts-boot-r2/result.json` | A/A/B/A, real account authentication and retained password records/policy, settings, app registration/AppData and document; each boot cleanly powers down |

Both raw images remain unchanged by verification. Their SHA-256 values are,
respectively, `0913e570ff4416e7131d91c7601bac98504c079ab9a5362d71dffb8cfd029053`
and `a5ca4b1ad5d0c42170fdbba7d914f650d3668aeeb25fcf75f42b513fbe37b44e`.
Build-input fingerprints match the packaged source. These are uncommitted
development builds, not a published or signed release.
The three registered installed-image/accounts/session CTests pass, including
seven account-state unit cases. Additional disposable-container checks reject
out-of-scope PAM changes and unsupported namespace/aging overrides without
altering either shadow database, deny locked-root su, and confirm `su -` root
login environment plus return to UID/GID 1000.

Do not use `dist/pollydesktop-installed-accounts` as the normal candidate:
that superseded schema-v1 prototype failed the required-password check because
the inherited Live getty override won. Its failure evidence is retained.
The schema-v1 verification prototype's earlier cold-boot pass does not establish
acceptance of the hardened schema-v2 follow-up.

These are console-stage development candidates. Graphical setup/login,
administrator settings UI, integrated screen locking/TTY protection, actual
system-version migration, encryption, Wi-Fi persistence, power authorization
and production signatures remain incomplete. Ordinary image boot must not be
presented as evidence for those features; real-device installation still needs
a selected target and explicit write authorization.

## Offline release verification and comparison

The packager includes `build-inputs.json` with the source revision/dirty state,
targeted build settings, recipe hashes and pinned Skia/SDL/HarfBuzz source/diff
fingerprints. These are packaging-time observations, not proof that an existing
SDK cache was built with identical recipe files. They do not bundle every source
archive or guarantee future upstream availability.

```sh
node desktop/tests/package-manifest.mjs dist/polly-debian-runtime
node desktop/tools/release-report.mjs dist/polly-debian-runtime
node desktop/tools/release-report.mjs dist/new-debian-live --compare dist/previous-debian-live
```

The report streams artifact hashes and validates source provenance, media
sizes/checksums, runtime payload bytes, pinned package inventory and SBOM coverage.
`package-manifest.mjs` also invokes the tar inventory check, which verifies
ownership, modes, unique safe file paths and actual per-file archive hashes
without extracting anything. Comparisons list package additions/removals/version
changes, payload size differences, and build-input changes when both packages
contain that metadata. Old accepted artifacts without the new metadata remain
readable; their missing historical build fingerprints are not fabricated.

This command is offline/read-only except for a caller-requested output redirect.
It does not refresh APT, install updates, access a network, publish artifacts or
turn an integrity pass into physical/sanitizer acceptance. Cross-distribution
package names are not proof of equivalent functionality, and a version change
is not automatically an upgrade or security fix.

For explicit upstream version discovery, run:

```sh
sh desktop/tools/check-debian-updates.sh dist/polly-debian-runtime > build/debian-update-report.json
```

This wrapper starts a disposable SDK container, mounts the repository read-only
and refreshes signed APT metadata there. Repository refresh failures stop the
report rather than silently using stale lists. The source allowlist is limited
to official Debian `trixie`, updates/security and explicit backports in `main`
or `non-free-firmware`. `apt-cache` source records are checked but not offered as
binary upgrades. Stable packages are never automatically moved to backports;
existing `~bpo13` pins are compared only within that selected channel.

The JSON identifies newer candidate versions, packages not found in the approved
channel and exact pinned versions no longer listed. It does not download package
payloads, solve a proposed transaction, claim security fixes, perform upgrades or
create recurring jobs. Persisted old sources remain necessary for reproducible
rebuilds; registry version listings alone do not satisfy that requirement.

## Retained binary inputs and offline reconstruction

To explicitly retain the exact Debian **binary** dependencies of a verified
runtime package, invoke the tool in a disposable SDK container:

```sh
podman run --rm -v "$PWD:/workspace" -w /workspace localhost/polly-debian-sdk \
    sh -ec 'apt-get update -qq -o APT::Update::Error-Mode=any;
      python3 -B desktop/tools/retain-debian-packages.py \
      dist/polly-debian-runtime dist/polly-debian-binary-inputs'
sh desktop/tools/test-offline-debian.sh dist/polly-debian-runtime dist/polly-debian-binary-inputs
```

The retention command reads pinned versions from the verified runtime artifact,
resolves exact indexed sizes/SHA-256 values, downloads packages without installing
them, and verifies every byte before publishing a new input-pack directory.
Missing versions or conflicting indexed payloads fail instead of silently choosing
a newer package. Inputs are bounded to 4096 packages, 512 MiB per package and
4 GiB total. Existing output directories are never overwritten.

The offline reconstruction command first verifies runtime and retained-package
inventories and requires identical pin lists. It then starts a separate
`--network=none` minbase container, installs only the supplied local DEBs,
extracts the validated runtime, and checks ordinary-user startup and repeated
managed-app data access. Package service startup remains blocked by `policy-rc.d`.
It mounts neither the full source tree nor an SDK into the reconstructed runtime
and changes no host account, filesystem or service.

The retained set does **not** include a complete bootstrap/SDK, kernel/Live-only
packages, or all Debian/custom upstream source archives. It is not a source
redistribution compliance claim, signature or guarantee of bit-identical image
reconstruction. Existing source fingerprints, publisher verification and
license/source-retention work remain distinct responsibilities. The binary input
cache is not copied into the Live image.

Custom upstream source inputs can also be retained without network access:

```sh
podman run --rm --network=none -v "$PWD:/workspace" -w /workspace localhost/polly-debian-sdk \
    python3 -B desktop/tools/retain-build-sources.py dist/polly-custom-source-inputs
python3 -B desktop/tools/retain-build-sources.py dist/polly-custom-source-inputs --verify
```

This records pristine tracked Skia/SDL/HarfBuzz trees at their exact revisions,
the SDL patch, pinned wlroots/wlr-protocols release archives, and the Debian
libinput/Mesa source descriptors with their checksum-verified original/packaging
archives and the local Mesa correction.
Recipe files and all retained source artifacts have per-file SHA-256 records.
Before retention, SDL's actual tracked modifications must exactly match the
declared patch; unrelated edits are rejected. No source archive is executed or
extracted during retention or verification.

New source packs also contain Git bundles and the original shallow boundaries.
Plain Git archives still do not carry Git metadata, and a shallow bundle alone
does not carry its missing-history boundary: cloning one without that boundary
fails `git fsck`. Restoration preserves the actual boundary, checks every object,
checks out the recorded revision, and requires a clean tree. It neither fabricates
commits nor claims to retain complete upstream history.

Restore in a disposable, network-disabled build container to a **new** directory:

```sh
podman run --rm --network=none -v "$PWD:/workspace:ro" -w /workspace \
    localhost/polly-debian-sdk sh -ec '
      python3 -B desktop/tools/restore-build-sources.py dist/polly-custom-source-inputs /tmp/polly-sources
      sh /tmp/polly-sources/desktop/tools/build-sdl-linux.sh /tmp/polly-sources/pollyui-sdl /tmp/polly-sdl
      sh /tmp/polly-sources/desktop/tools/build-harfbuzz-linux.sh /tmp/polly-sources/pollyui-harfbuzz /tmp/polly-text'
```

Restoration verifies the retained inventory before use, cross-checks the saved
recipe pins, extracts wlroots/wlr-protocols and the Debian libinput/Mesa sources, and
reconstructs the original relative recipe/patch paths. SDL remains pristine until
its existing build recipe applies the retained patch. Git configuration/hooks and
SDK build outputs are not imported. Failed restoration removes only its own
temporary staging directory; existing destination directories are not replaced.
Older packs without bundles are rejected by restoration, but remain valid for
source-archive verification. Existing six-component Git-bundle packs remain
restorable; their inventories do not claim to contain the newer Mesa source input.

The libinput descriptor/archive checksums are verified, but maintainer signature
authentication is a separate guarantee. `dpkg-source` retains its normal signature
checks and warnings; a missing acceptable maintainer key is reported, not hidden
or described as a successfully authenticated signature.

This restores custom source inputs, **not a complete offline SDK**. Compilers and
system build dependencies still come from the explicitly selected SDK, and the
existing wlroots/libinput SDK recipes still contain acquisition/install steps.
The project's own source remains separately versioned in Git, and redistribution
obligations for all distro packages are not covered by this custom-source set.

## Current acceptance limits

### Mesa lifetime correction

The SDK rebuilds the exact Debian Mesa `26.1.6-1~bpo13+1` source as
`26.1.6-1~bpo13+1+polly1`. `mesa.json` pins the original descriptor/archive
hashes; `build-mesa.py` applies `desktop/patches/mesa-lifetime.patch` and uses
Debian's unchanged driver selection and package rules. This is a locally rebuilt
package set, **not a new official Debian binary or a Mesa version upgrade**.
The only additional explicitly selected backported build dependency is
`directx-headers-dev`, required by that exact source's Debian control file.
Build tools and development dependencies stay in the SDK.

The correction registers CPU-topology storage cleanup at initialization and
releases the executable mapping/allocator when its last block is freed. The
heap stays alive while another allocation is in use; failed heap initialization
and failed allocation into an empty heap also release their resources. No
sanitizer suppressions, loader `NODELETE` flags or forced rendering fallback
are used. `sdl-gl-lifecycle` draws and checks actual GLES pixels with two live
contexts, destroys one while continuing to use the other, and repeats complete
SDL initialization/shutdown ten times. On glibc it also rejects anonymous
executable mappings left behind after shutdown, since LeakSanitizer alone
does not account for the 10 MiB executable `mmap` pool.

The SDK preserves the rebuilt DEBs, their byte/control identities, original
source hashes and patch hash under `/opt/pollyui-local-debs/mesa`. Packaging
rejects stale SDKs or a mixture of corrected and uncorrected Mesa versions.
Runtime artifacts contain only the rebuilt DEBs required by their exact
dependency closure. The runtime recipe verifies and installs the explicitly
listed local files, alongside signed-index Debian dependencies, then removes
the installation cache. Live construction inherits that runtime.

Release reports and retained binary input packs identify these as local
rebuilds rather than pretending their hashes came from Debian's package index.
Custom source retention includes the original Mesa source and correction.
The `+polly1` binary versions are not expected to appear in the official APT
candidate list; future upstream versions still require checking whether this
correction is present before replacing them. No publisher key or automatic
update/promotion is introduced.

The original Debian candidate's raw graphical LeakSanitizer failures remain in
the historical evidence. Matching official Debian debug information mapped them
to `get_cpu_topology` in `src/util/u_cpu_detect.c` and `u_mmInit` in `src/util/u_mm.c`.
Changing renderer or adding an SDL EGL-thread cleanup did not fix them; that SDL
experiment was removed.

With the local Mesa correction, the original raster/GLES cases and the repeated
GL/mapping regression pass ASan/UBSan without suppressions, changed sanitizer exit
codes or `continue-on-error`. The complete Debian Mesa build's 113 upstream tests
also pass. This is software evidence, not target-GPU qualification.

The expanded Debian sanitizer run also exposed an empty SPA property dictionary:
the audio adapter now avoids calling the upstream lookup loop for zero items.
The standalone stream fixture explicitly releases its process-wide libdbus
caches after PipeWire teardown, using the supported `dbus_shutdown` API. It does
not disable D-Bus/RT modules or suppress allocations. Actual routing and saved
audio preferences pass in raster/GLES sanitizer runs on Debian and Alpine.
The corrected candidate completes all 71 Debian ASan/UBSan tests with
`UBSAN_OPTIONS=print_stacktrace=1:halt_on_error=1`, plus the shared core suite and
real PAM fixture. The normal 71-test run passed before the final audio guards;
the changed normal audio cases and core suite were then rerun successfully.

The Debian candidate boots both read-only USB and optical media under OVMF/KVM:
ordinary PAM/logind session, real guest DRM, Rime Chinese input, clipboard
copy/paste and keyboard workspace switching passed. Removing approximately
528 MiB of APT installation caches allowed the revised USB image to pass the
same acceptance with a **4 GiB** guest. A previous cache-heavy 4 GiB trial
reported an initramfs unpack write error and remains explicitly a failed result.

The earlier Debian alpha.4-r1 cache-free candidate measured approximately
644 MiB (ISO) and 694 MiB (USB). The current corrected alpha.5-r2 measures
646.4 MiB and 697.0 MiB respectively, versus the accepted Alpine baseline's
688/738 MiB. Installed payload sizes and compressed image sizes are different
measurements. This does not establish a performance win or physical-hardware
equivalence; firmware coverage and package splits differ.

For local boot verification, use the distro-specific tool image:

```sh
podman run --rm --network=none --device /dev/kvm --user 1000:1000 \
    -v "$PWD:/workspace" -w /workspace localhost/polly-debian-live-tools \
    python3 desktop/tests/live-boot.py \
    dist/pollydesktop-0.1.0-alpha.5-debian13-r2-live/pollydesktop-0.1.0-alpha.5-debian13-x86_64-uefi-usb.img \
    build/debian-usb-new-evidence --usb
```

Use a new evidence directory per run.
Omit `--device /dev/kvm` to use TCG without changing host permissions.

The user confirmed physical boot/basic operation of Debian alpha.5-r2 on
2026-10-07 at 14:07 (UTC+08:00). Per-GPU/renderer, network, audio and endurance
results were not separately reported and must not be inferred. Software
qualification uses the corrected Mesa package set and matching candidate results.
This Debian feedback is separate from the earlier Alpine report. Keep exact
candidate revisions, package inventories and known failures with results.
See the [maintenance policy](../../../docs/desktop-base-maintenance.md) for
promotion, data and rollback limits.
