# Required storage failure guards

`release/storage/storage.py` keeps layout schema 1 and its fixed SYSTEM,
PERSISTENT and EFI identities/mappings. `check` is read-only: absent/wrong
mounts, read-only SYSTEM or `/usr`, missing `nodev`/`nosuid`, unsafe paths and
missing/mismatched readiness refuse use rather than initialize a second tree,
remount, reset authentication or repair a filesystem. `prepare` requires both
real and effective UID 0. Its existing explicit early `/usr` read-only to
writable bind preparation is unchanged.

The manifest and runtime readiness use the same storage-local descriptor
reader, with the existing root-owned ancestor policy, no-follow/nonblocking
open, one regular-file link and before/open/after metadata snapshots. The
manifest is at most 65,536 bytes, UTF-8, and rejects duplicate fields (including
nested fields), non-finite constants, malformed/deep JSON and noncanonical
schema/types/paths. Readiness is exactly the canonical contract SHA256 plus
newline (65 bytes); whitespace in a valid manifest does not change that hash.
These are snapshots per invocation, not a filesystem lock or a promise against
a privileged process changing mounts/state after the check.

The required Dpkg `status` must be a trusted, regular, single-link nonempty
record. Inspection reads only its first byte and checks the descriptor snapshot,
so valid package databases larger than the manifest bound are accepted. This
does not reimplement package parsing, the maintenance payload inventory,
account initialization, authentication or Network's private snapshot parser.
Those consumers retain their own semantic validation.

Publication syscall failures propagate to the existing
`POLLY_STORAGE_FAILED` stderr/syslog path and nonzero CLI status; there is no
`POLLY_STORAGE_READY` on failure. After an atomic rename, directory-fsync
failure can leave the complete new record visible but still reports failure,
not rollback or durable success. No global zero-free-block/inode login gate
or arbitrary capacity reserve is added: actual ENOSPC at publication is
reported, while read-only inspection is not claimed to reserve future writes.
Full storage must retain login, read-only diagnosis and cleanup access when the
existing authorities remain readable; each persistent writer applies its own
operation-specific needs and explicit ENOSPC/I/O refusal.

## Focused reproduction

Use an already-cached SDK/container image, source mounted read-only and
`--network=none`. No package install, image build, VM or host disk inspection is
needed. `tests/storage-failures.py` requires real root in a container and fails
instead of skipping when that prerequisite is absent. It covers exact read
bounds, ambiguous JSON, final-file/link/owner/mode changes, FIFO/symlink/open
races, snapshot changes, readiness, syscall errno propagation and exact
stderr/syslog/exit shape.

`tests/storage-fault-fixture.py /workspace --report /evidence/faults.json`
also requires root plus `/run/.containerenv`, with `CAP_SYS_ADMIN` and the mount
syscalls allowed. It first makes propagation private, then creates only
disposable bounded tmpfs mounts below its own temporary root (including its
own `/run`). It exercises every required missing mapping, wrong synthetic
UUIDs, classified directory modes, missing volumes, read-only/missing/
forbidden flags, wrong-source binds, foreign source filesystems, Dpkg status,
runtime readiness, real EROFS and actual ENOSPC on its 64KiB runtime. Checks
must issue only `findmnt`, leave empty destinations empty and preserve the
synthetic package/account authorities. A real UID/GID 1000 subprocess must
pass `Storage.check` and refuse privileged preparation.
Positive checks also run with actual zero available blocks on the SYSTEM,
PERSISTENT and runtime tmpfs, and actual zero available PERSISTENT inodes.
Those conditions must not turn a readable authority into a global login or
cleanup refusal; the ENOSPC publication operation still fails explicitly.

Tmpfs has no ext4 UUID. The fixture explicitly substitutes only the synthetic
UUID/type returned for its private volume devices; production
`validate_volume`, exact mount lookup, real options, permissions and inode
identity still run. The JSON report includes ordered unique fault rows with
timings, source hashes, canonical fingerprint and the actual ordinary UID
result. Existing `storage-mount-fixture.py` and `network-state-fixture.py`
seed a minimal real `status` record and continue exercising actual
`Storage.check`; production validation is not weakened for those fixtures.

Run existing `storage-layout`, `storage-mappings`, `installed-accounts`,
`account-profiles`, Network36 and factory12 consumers alongside the new tests.
CTest registers `desktop-storage-failures` with `python3 -I -B`, no repository
argument, a 30-second timeout, source working directory and the `root-container`
label. The source-only `check-storage.py` runner invokes the same suite as an
explicit root-container selector, outside its ordinary generic unit list.
Its AST checks include the production storage guard, fault suite and private
namespace fixture. `storage-fault-fixture.py` is not registered as a default
host/CTest test: its `CAP_SYS_ADMIN` namespace run still requires a separately
scoped root container. Registration is not mount, native runtime, image or
boot acceptance. Preserve failed runs and immutable image/source/command
provenance with the reports.

This bounded matrix is **not** complete T03.6 acceptance: real ext4 corruption,
storage exhaustion during package/account transactions, interrupted boot,
new-media cold boot, power loss and real-device behavior remain separate proof.
