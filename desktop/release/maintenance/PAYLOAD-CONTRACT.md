# Internal system payload contract (T07.1)

`payload.py` implements **v1, development-unsigned** evidence for a writable
single SYSTEM and its matching classified package state. It is not an updater,
installer, backup archive, signature verifier or recovery implementation.
Only Debian 13/trixie, Debian architecture `amd64`, storage layout v1 and
`major.minor.patch[-alpha.number]` payload versions are qualified. The existing
image manifest's `x86_64` architecture spelling is unchanged.

## Inputs and exact wire shape

The two inputs are independent, offline Linux ordinary directory trees:

- SYSTEM contains the complete root baseline, physical `System/Resources`
  (all of `/usr`, including other distribution directories), `System/Boot`,
  empty `/usr` and `/boot` compatibility directories, version-related `/etc`,
  and a valid `etc/polly-storage.json`.
- PERSISTENT supplies **only** `SystemData/Library/Dpkg` and
  `SystemData/Library/Apt` to the proof. Accounts, credentials, applications and
  users are not scanned, copied, overwritten or restored.

The JSON object has exactly these keys:

| Key | v1 value |
| --- | --- |
| `schemaVersion` | integer `1` (not boolean) |
| `kind` | `"polly-system-payload"` |
| `version` | bounded canonical version, no leading-zero components |
| `distribution` | exactly `{"id":"debian","version":"13","codename":"trixie"}` |
| `architecture` | `"amd64"` |
| `storageSchemaVersion` | integer `1` |
| `trust` | `"development-unsigned"` |
| `materials` | ordered `system`, `dpkg`, `apt` records |
| `packageProof` | qualified package records and independent file identities |
| `capacity` | ordered SYSTEM, PERSISTENT package-group measurements |
| `compatibility` | ordered accounts, applications, services, users declarations |

Each material is exactly
`{id,role,path,inventorySha256,nodes,contentBytes,measuredBytes}`. The paths are
fixed: SYSTEM `.`, PERSISTENT `SystemData/Library/Dpkg`, and PERSISTENT
`SystemData/Library/Apt`. They are not arbitrary write targets.

Each capacity is exactly
`{role,payloadBytes,overheadBytes,reserveBytes,minimumBytes}`.
`payloadBytes` equals that role's material measurements; `minimumBytes` equals
payload plus overhead plus reserve. Overhead and reserve each require at least
16 MiB. Measurements count 4096 bytes per directory, regular logical bytes once
per internal hardlink group, and symlink byte length plus 4096. This is a
planning estimate that also counts every inspected xattr's name/value bytes.
It is a
conservative logical-tree planning input, **not measured ext4 used/free blocks**.
The builder retains its existing full-partition measurements and overhead
formula; actual filesystem assembly/space checks remain the builder's job.
PERSISTENT capacity here covers the matched package group, not all users/apps.
A future target consumer must supply allocatable bytes **after accounting for
retained unrelated state**, not blindly use the partition's total capacity.

Each compatibility record is exactly `{id,policy,acceptsSchemas}`:

| ID | Fixed preservation policy |
| --- | --- |
| `accounts` | `retain-latest` |
| `applications` | `independent-application-transaction` |
| `services` | `retain-compatible-or-reject` |
| `users` | `preserve-unless-explicit-data-migration` |

Schemas are ordered unique integers 1..1000000. An empty array explicitly means
**no existing schema has qualified compatibility**, not unrestricted support.
The preflight caller must supply all four current schema keys; `null` explicitly
asserts that domain is absent. Callers must establish that assertion themselves.
This declaration does not infer data compatibility from a package version or
inspect private state. New storage-image assembly declares accounts `[3]` and
the other domains `[]`, and checks a fresh target with all current schemas absent.
It does not qualify reuse of an existing installation's data.

## What the package proof qualifies

`packageProof` has exactly
`{qualification,inventory,status,packagesSha256,records,installedRecords,
runtimePaths,runtimeFileChecksums,diversions}`. The qualification string is
`status-tuples+usr-boot-lists-md5sums-diversions+full-tree-sha256-v1`.
Inventory/status records each have `{path,bytes,sha256}` and fixed paths:
`System/Resources/share/polly-installed-packages.tsv` and
`SystemData/Library/Dpkg/status`.

The exact three-column TSV name/version/homepage set must equal all parsed dpkg
status records. Native `amd64` and architecture-independent `all` records are
allowed; at least one native record is required. `Multi-Arch: same` uses
`name:architecture` consistently in TSV and `info` filenames. Installed records
and explicit residual `deinstall/purge ok config-files` records are qualified.
Unfinished/reinstreq/foreign/duplicate/ambiguous records are rejected.

Every installed package must have a regular `info/<identity>.list`. All listed
`/usr` and `/boot` nodes must exist in the complete snapshot. Guest symlink
ancestors are resolved only against inventoried guest nodes, never host absolute
paths. Final symlink nodes preserve link semantics rather than dereferencing
host paths. Every regular file in this scope must have a matching
`info/<identity>.md5sums` checksum. Malformed, duplicate or unlisted checksums
are rejected. Dpkg's three-line `diversions` records are explicitly qualified;
local `:` diversions and diversions owned by another installed package direct
the original owner's checksum to the diverted path. Unknown owners, duplicates
and diversion chains are refused.

This checks more than a name-list hash: the entire runtime baseline and both
complete database trees have independent SHA256 identities, with package tuple,
runtime-presence and legacy dpkg checksum cross-checks. It does **not** prove
vendor provenance, cryptographic origin authentication, conffile equality,
unowned overlay vendor identity, dependency/ABI compatibility, bootability,
mounted-volume correctness or absence of active writers. Dpkg's MD5 is only a
legacy consistency cross-check, not a security primitive. Every kernel has a
nonempty matching initramfs, microcode and module directory; actual boot and
kernel ABI validation remain separate.

## Tree semantics, bounds and refusal

The canonical inventory includes directory/file/symlink kind, permissions
(including special mode bits), UID/GID, nanosecond mtime, every readable xattr's
name/size/SHA256 (including ACLs/capabilities), file SHA256/MD5/length, exact
symlink target, and canonical internal hardlink group identities. No copy is
performed; sparse extents, allocation layout, atime/ctime and physical inode
numbers are not logical restore metadata promised by this format.

Special nodes, linked roots/ancestors, nested devices, unsupported `st_flags`,
external regular hardlinks and hardlinked symlinks are refused. Xattr failures
are errors, not empty metadata. Sources must be independently offline/quiescent;
no-follow reads, metadata-change checks and a second complete inventory reject
detected movement, but are not transaction locks or a snapshot mechanism.

Limits: 1 MiB contract JSON, 64 MiB individual database/inventory metadata reads,
250000 nodes/records/qualified runtime paths, 64 GiB per material, 128 directory
levels, 256 xattrs per node, 1 MiB per xattr, 256 accepted schemas per domain,
and 128 GiB allocatable capacity per role. Exact keys, types, order and
arithmetic are validated. Duplicate JSON fields and non-finite numbers fail.
Unknown future schemas/architecture/distribution/proof variants require a new
explicit implementation; old assembly manifests are never silently reclassified.

## API, CLI and builder integration

- `capture(system, persistent, *, version, overhead_bytes, reserve_bytes,
  accepts_schemas) -> contract`: read-only capture of an independently qualified
  candidate; caller supplies exact SYSTEM/PERSISTENT amounts and all data IDs.
- `validate(object) -> independent copy`, `encode(object) -> canonical ASCII
  JSON plus newline`, `decode(text) -> validated independent copy`.
- `preflight(contract, system, persistent, *, expected_version, distribution,
  architecture, available_bytes, current_schemas) -> deterministic evidence`.
  All supplied material is rechecked; any mismatch or missing proof is an error.

The read-only CLI takes positional contract, SYSTEM tree and PERSISTENT tree,
and requires `--expected-version`, `--distribution debian13`,
`--architecture amd64`, `--available-system-bytes`,
`--available-persistent-bytes`, and `--current-schemas` (JSON file). It emits
only JSON evidence on success; refusal goes to stderr with nonzero exit status.
Evidence identifies the canonical contract SHA256, records/checksum counts,
available capacity, supplied schemas, and `readOnly:true`, `authenticated:false`,
`bootVerified:false`. It grants no write authority.

`build-storage-image.py` calls `qualify_payload` on its completed ordinary trees
before filesystem assembly. It publishes a separate **`system-payload.json`**
sidecar and includes its digest in `SHA256SUMS`; `installed-manifest.json` stays
schema v1 with its old package-list interpretation. The payload module is added
to `buildInputs`. The sidecar describes the input trees, **not an inspection of
the final ext4 image**. Consumers must not use a sidecar to skip final image
verification or treat legacy manifests without the sidecar as qualified proof.

Central integration is intentionally left to the owner: register
`desktop/tests/system-payload.py` in the fast runner and/or a CTest Python test;
include `desktop/release/maintenance/payload.py` in source syntax checks.
Run `python3 -I -B desktop/tests/system-payload.py` on Linux. No SDK rebuild,
network, image build, mounts, block writes or VM are required.
