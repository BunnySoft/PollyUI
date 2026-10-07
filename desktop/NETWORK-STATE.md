# T17.1 bounded iwd state boundary

This is a **clean-stop checkpoint**, not immediate durable connection saving,
full T17.1 acceptance, T17.2 reconnect, enterprise/AP support or disk encryption.
The shared layout remains schema 1. Existing single-system images intentionally
mount `/var/lib/iwd` on tmpfs; that remains iwd's sole writable working tree.
Only supported `.open` and `.psk` profile bytes cross the checkpoint boundary.
No whole `/var`, `/var/lib` or `/etc` sharing is added.

## Authority and compatibility

`SystemData/Network` already exists in the storage contract with UID/GID 0:0 and
mode 0700. The optional network overlay adds a private schema-1 `state.json`
(0600) pointing to a `Snapshot<32 lowercase hex>` directory (0700). Its exact
fields are `schemaVersion`, `persistentUuid`, `generation`, `profiles`; `profiles`
maps iwd filenames to SHA256. Profile files are UID/GID 0:0, 0600, regular,
single-link, bounded to 64 KiB, UTF-8 without NUL. The index is at most 128 KiB,
256 profiles. The snapshot must contain exactly the indexed files on the same
filesystem. Missing/changed files, digest mismatch, unsupported schema, duplicate
JSON fields, wrong UUID, symlinks, hardlinks, owner/group/mode drift and writable
ancestors refuse loading or saving. Filenames follow iwd's ASCII/hex naming
convention; filenames/SSID and content never appear in helper output.

`Storage.check()` remains the required volume/mapping/readiness authority:
ext4, expected UUIDs, writable nodev/nosuid persistent volume and every required
mapping must pass first. `/SystemData/Network` must identify the very same inode
as the classified persistent source, not a rootfs fallback directory. Space
qualification retains 1 MiB and 264 available inodes in addition to measured
profile bytes and index budget; actual write/fsync failures still fail explicitly.
Unknown/unsupported old snapshots are not repaired, upgraded or replaced.

A legitimate fresh empty network has a validated empty snapshot and UUID-bound
index. It is **not** a missing `state.json` or an empty mount directory. The
root-only `initialize_empty(network, persistent_uuid, storage, accounts,
assembly_root, *, image_root)` library API requires a trusted assembly boundary and a completely
empty Network directory; it never imports profiles, repairs, overwrites or
initializes during service startup. It does not accept a credential input.
The explicit image root supplies its final installed profile, passwd identities
and locked root/polly shadow records, with the shadow GID resolved from that
image's group file; existing account parsers are reused. It never reads host
passwd/shadow/profile or creates/changes a password.

**Parent integration still required:** select `release/network/Containerfile`
as the single-system storage overlay and explicitly call that initializer from
fresh `build-storage-image.py` assembly before payload capture. Central image
builder/CMake/check-storage/plan files are deliberately not modified by this
bounded change. An older image with no snapshot fails closed if the overlay is
installed; it is not a supported implicit migration. Do not install the overlay
on the legacy shared-home installation or a Live image.

The one fresh-builder call is **after `legacy.configure_accounts` and storage
manifest creation, before boot/usr relocation and payload capture**, using
imported modules:

```python
network.initialize_empty(
    persistent / "SystemData/Network", identifiers["PERSISTENT"],
    storage, accounts, assembly_root=stage, image_root=root)
```

`stage` must be the trusted root-owned common assembly ancestor containing the
new root and persistent trees, not `/tmp` itself. `storage` is the existing
`release/storage/storage.py` module, `accounts` the existing
`release/install/accounts.py` module, `network` the new `release/network/state.py`.
Copy the new helper to `/usr/lib/polly-network/state.py` (root:root 0755), the
drop-in to `/etc/systemd/system/iwd.service.d/polly-state.conf` (0644); retain
existing `/usr/lib/polly-storage/{storage,layout}.py`,
`/usr/sbin/polly-accounts` and `/usr/lib/polly-account-profile-check`.
Normalize installed scripts/unit files to LF as in the supplied Containerfile;
a Windows CRLF shebang is not a runnable Linux hook.
The optional Containerfile demonstrates these copies only; it has **not**
entered the default installed artifact/build chain.

## Owner writes, parser and atomicity

iwd remains the credential parser/owner. The helper validates private metadata,
file identity, bounds, naming and digest, **not** ELL key/value or password
semantics. It copies UTF-8 bytes without ConfigParser normalization, credential
extraction, application preferences, default passwords or a second policy daemon.
Malformed semantic configuration remains an iwd error, not a claim of validated
authentication. iwd may legitimately prompt an agent for a missing PSK.

The stopped service's `.known_network.freq` is classified private volatile
cache (regular 0600, bounded); an empty root-private `hotspot` directory created
by iwd is allowed but not persisted. Populated hotspot state, `.8021x`, EAP TLS
cache, unknown files or abandoned temporary writes **refuse the checkpoint**,
retain the old snapshot and working tree and block automatic restart. They are
never silently discarded or described as saved. Live's existing iwd semantics
are not narrowed by this installed-only overlay.

The helper reuses account `atomic()` and `state_lock()` rather than inventing a
second write protocol. Saving writes a new unique private directory, fsyncs each
file and directory plus its parent, then atomically replaces and fsyncs the
private index. The old snapshot stays intact; old/unreferenced generations are
retained for explicit recovery, not automatically deleted. Capacity exhaustion
eventually refuses saving rather than pruning secrets without a policy.
The index rename is the visibility commit point; success is reported only after
its directory fsync and read-back qualification. A post-rename fsync failure is
an **uncertain commit**, not rolled back or reported successful.

## Service lifecycle and failure visibility

The installed-only drop-in retains the distro iwd binary, D-Bus service,
capability restrictions, main configuration and resolver backend. It explicitly
uses root:root and 0077, clears systemd `StateDirectory=` automatic creation,
sets `STATE_DIRECTORY=/var/lib/iwd`, and grants only its classified working,
write path in addition to the existing resolver paths. The daemon's strict
namespace does not gain write access to the persistent snapshots.
No state-directory environment variable supplied by an application is trusted.

`Requires/After=polly-storage.service` orders startup and inversely orders
shutdown; persistent local filesystems must remain mounted through iwd's stop
checkpoint. Both hooks independently recheck the full storage authority.
`ExecStartPre=+... state.py load` requires a stopped main process, the existing
trusted account-profile checker and valid installed snapshot before copying
profiles to the tmpfs. A root-only lease in
`/run/polly-network-state/lease.json` binds UUID, generation and systemd's
`INVOCATION_ID`. An unrelated nonempty working tree is not imported/overwritten.
Multi-file loading is gated, not globally atomic: an interrupted partial load
cannot start iwd; it fails on retry rather than using a partial/empty fallback.

`ExecStopPost=+... state.py save` requires `MainPID=0`, `SERVICE_RESULT=success`
and the matching lease. The main process must be gone before inspection: iwd and
the helper are never simultaneous credential writers. Concurrent hooks fail the
bounded account lock. A failed start, unclean exit, lost mount, changed authority,
unsafe profile, EROFS, ENOSPC or checkpoint I/O error produces nonzero exit, journal/console
`POLLY_NETWORK_STATE_FAILED` and a redacted journal error record. systemd records hook
failure; this is not a successful checkpoint even if the earlier connection
succeeded. The lease remains on checkpoint failure and `RuntimeDirectoryPreserve=yes`
keeps it through service restarts. Explicit root recovery is required; no root
command or arbitrary path API is exposed to a UI. Runtime state disappears at
reboot, so unsaved working changes can be lost, but the last valid snapshot is
not reinitialized.

Guard release is a separate, terminal **RAM-only** operation. Before creating a
lock or writing any handoff, the helper requires an actual `/run` tmpfs mount and
checks that the private runtime is on that same device with an effective tmpfs
mount. Installed mounts must be rw,nodev,nosuid; Live requires rw, preserving
the existing memory-only Live init's `/run` flags. Disk-backed runtime, a missing
`/run` mount, a read-only view or a bind from the persistent volume refuse; a
same-`/run` RAM bind is not rejected merely for being a bind.

Saving first completes the durable snapshot/index fsyncs, read-back qualification,
result construction **and lock-context close**, while the lease still guards
restart. Only then does `run()` unlink the lease as its last checkpoint action.
It performs no runtime fsync, revalidation or descriptor close after that unlink:
the runtime is proven volatile, so persisting the deletion is neither needed
nor a condition of success. Unlink failure keeps the lease and returns nonzero/
not-confirmed. A lock-close or earlier failure also keeps the lease, even if
the new snapshot has already durably committed. Such a retained guard does not
mean the persistent commit was rolled back; explicit recovery must inspect it.
No best-effort guard restoration or silent cleanup failure is used.

The gap between closing the lock and the terminal unlink stays guarded: another
load cannot create a new lease while the old one exists; a duplicate save sees
the old lease generation disagree with the newly published index and refuses.
The service manager serializes legitimate hooks. Receipt/stdout delivery happens
after the checkpoint and is not transactionally coupled to it; interruption or
output transport loss after terminal release cannot undo the already confirmed
commit. The helper never labels such a receipt loss `checkpoint:not-confirmed`.
This does not establish PID1 delivery, crash or cold-boot acceptance.

The `+` prefix is intentional: these **fixed root-only hooks** skip the
iwd main process's configured filesystem namespace/capability restrictions. Otherwise
`ProtectSystem=strict` changes the observed `/usr`/package/state mappings to
read-only and the unchanged `Storage.check()` correctly refuses its required-rw
contract. This is not a blanket sudo/polkit grant or an arbitrary executable/path
API; the helper permits only the two fixed operations. It inspects mount state,
never mounts, formats, calls a network command or changes host network settings.
The main daemon retains the distro sandbox.

Exact systemd **v257.13** source review: `exec-invoke.c` lines 4769 and 4922 gate
`needs_sandboxing` and `needs_setuid` on `EXEC_COMMAND_FULLY_PRIVILEGED`; mount
setup receives that sandbox flag at line 5104. The `NoNewPrivileges` prctl at
line 5463 is inside the `needs_sandboxing` block beginning at line 5396, so `+`
also skips systemd's NNP enforcement. The helper therefore explicitly sets
process-local `PR_SET_NO_NEW_PRIVS` before loading the fixed helper modules or
launching the fixed non-setuid guard/query tools. Unit-wide cgroup restrictions
(including DevicePolicy) and resource limits are **not** removed by `+`.
Mandatory directory handling may still require a separate namespace; `+` does
not mean “all unit settings disappear” or prove an identical PID1 namespace.
The expected host tmpfs view, MainPID and actual stop ordering still need the
single init/cold-boot lane.

Before importing privileged modules, the CLI checks its fixed installation
path, root-owned nonwritable program ancestors, regular single-link modes of
itself, storage/layout/accounts helpers and the fixed query/iwd binaries. It
then reuses the storage trust checks for the profile guard and iwd configuration
file, which must be 0:0 0644, regular/single-link/bounded UTF-8. It does not
reinterpret administrator-owned iwd settings. Bytecode cache writes are disabled.

Success stdout is one JSON object:

```json
{"checkpoint":"loaded","mode":"installed","operation":"load","persistent":true,"profileCount":0,"schemaVersion":1}
```

Saving uses `checkpoint:"committed"`; Live library hooks use
`persistent:false, checkpoint:"not-applicable"` without reading Network state.
Failure stderr contains a prefixed JSON object with `status:"refused"`,
`checkpoint:"not-confirmed"` and a bounded error code (no-space, read-only,
missing-state, permission, unsafe-link or state-or-service-invalid); stdout is
empty. UUIDs, generations, profile names, passwords and exception text are not
exported. No credentials enter an ISO, AppData or reports.

The helper requires both real UID and effective UID 0; it is neither setuid nor
a generic backend command. `INVOCATION_ID`/service result establish lifecycle
consistency, not caller authentication. A future privileged UI backend must
authenticate the actual local peer independently; a self-reported identity,
clipboard, blanket sudo/polkit policy or generic root paths is not acceptable.
Existing iwd D-Bus policy and shell owner verification are not broadened here.

## Existing network backend and provenance

Inspected fixed source `8ce0b6d22fe9d5095f136f4f497850e20c1edd34`:
`system/iwd-main.conf` enables iwd network configuration and
`NameResolvingService=resolvconf`; `release/live/dhcpcd.conf` restricts dhcpcd
to `eth*`/`en*`; `release/debian/resolvconf.conf`, `network-runtime.conf` and
`network-tmpfiles.conf` keep DNS in `/run/polly-network`/`/run/resolvconf`.
This change does not alter wired DHCP, DNS, public final-Live account presets or
installed independent first-setup credentials. Missing/corrupt/template/recovery
account modes never fall back to Live. Live root must be memory-backed if the
library hooks are used; normal developer Live packaging remains unchanged.

Read-only cached storage image `e78a9b14ae98` contained iwd **3.8-2**, systemd
**257.13-1~deb13u1**, dhcpcd **1:10.1.0-11+deb13u4**, openresolv **3.13.2-3**.
Its actual iwd unit runs `/usr/libexec/iwd`, default root, `ProtectSystem=strict`,
`ConfigurationDirectory=iwd`, `StateDirectory=iwd`, mode 0700. Relevant upstream:

- [iwd(8), STATE_DIRECTORY](https://manpages.debian.org/trixie/iwd/iwd.8.en.html)
- [iwd.network(5), naming and ELL format](https://manpages.debian.org/trixie/iwd/iwd.network.5.en.html)
- [systemd.service(5), privileged `+` command prefix and stop hooks](https://manpages.debian.org/trixie/systemd/systemd.service.5.en.html)
- [systemd v257.13 exec-invoke.c](https://github.com/systemd/systemd/blob/v257.13/src/core/exec-invoke.c):
  reviewed upstream content SHA256
  `73282e9a403a327cb5a3e58c8b92ff1f3870feed91a0fb73e14b94e964ef6603`
- [systemd v257.13 service command-prefix contract](https://github.com/systemd/systemd/blob/v257.13/man/systemd.service.xml#L1431)
- [iwd 3.8 storage.c](https://git.kernel.org/pub/scm/network/wireless/iwd.git/tree/src/storage.c?h=3.8):
  `storage_create_dirs`, `storage_network_ssid_from_path`, `write_file`,
  `storage_network_sync`, known-frequency and EAP cache handling.

iwd's native write creates a 0600 temporary file and renames it, but does **not**
fsync file/directory; some profile sync call sites do not propagate write failure
to the D-Bus caller. Thus connection success is not this checkpoint's success.
This interface deliberately does not claim immediate durability or safe
power-cut/cold-boot/hardware behavior. Service/unit compatibility must be
requalified on backend upgrades.

## Bounded verification

`tests/network-state.py` runs root metadata, fresh/missing distinction, profile
guard wiring, byte-preserving stop/start/forget, version/UUID/digest/link/owner/
mode, capacity, atomic failure/uncertainty, service lease/lock and redaction tests
in a disposable container. Unit tests mock mount authority and service queries;
they are not volume or systemd execution evidence.
`tests/network-state-fixture.py` uses actual private namespace tmpfs/binds and
the actual required-mount checker, substituting only synthetic filesystem
identities; no ext4 image/disk is written. It validates fixed service-unit
composition and a synthetic stopped-owner handoff, not a physical iwd
connection or a real init boot. No real SSID/password/key discovery is used.
The follow-up regression also covers the old post-unlink runtime fsync EIO,
terminal release ordering, unlink and lock-close failures retaining a guard,
and `/run` RAM qualification. The private fixture now mounts its own `/run`
tmpfs and rejects a foreign persistent-volume runtime bind; host `/run` is
never changed.
