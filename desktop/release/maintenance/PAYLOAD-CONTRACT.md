# Internal system payload contract (T07.1)

`payload.py` implements **v1, development-unsigned** evidence for a writable
single SYSTEM and its matching classified package state. It is not an updater,
installer, backup archive, signature verifier or recovery implementation.
The separate T08.2 `signature.py` envelope below authenticates only an explicitly
trusted **test identity**, without changing this payload's trust or qualification.
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

## T08.2 test identity envelope (not a production trust root)

`signature.py` uses the existing external **OpenSSL Ed25519** implementation
(`pkey` and `pkeyutl -rawin`, qualified with OpenSSL 3.5.7). Python's standard
library handles framing, SHA256, JSON and base64; no Python crypto dependency,
custom cryptography, GLib/GIO runtime or algorithm negotiation is introduced.
An unavailable/unsupported/failed/timed-out backend refuses the operation.
The executable must come from the caller's trusted local environment, not a
payload-supplied path or hook. This is an offline development/test tool.

The envelope has exactly these fields:

| Key | v1 value |
| --- | --- |
| `schemaVersion` | integer `1`, not boolean |
| `kind` | `"polly-system-payload-test-signature"` |
| `algorithm` | `"Ed25519"` |
| `trustContext` | `"test-only"` |
| `payload` | complete unchanged validated T07.1 schema1 object, including `"trust":"development-unsigned"` |
| `payloadBytes` | exact byte length of `payload.encode(payload).encode("ascii")` |
| `payloadSha256` | lowercase SHA256 of those exact canonical bytes |
| `publicKeySha256` | lowercase SHA256 of the exact 44-byte trusted public-key DER |
| `signature` | canonical RFC 4648 base64 of the 64-byte Ed25519 signature (88 ASCII characters, ending `==`) |

Canonical payload bytes use the existing encoder: sorted object keys, compact
`,`/`:` separators, ASCII JSON escaping, unchanged array order and **one trailing
LF**. The digest here equals T07.1 preflight's `contractSha256`, not its internal
tree-inventory checksum and not the hash of the original input's whitespace.
Noncanonical input whitespace/key order may decode to the same identity; no
body/material fields are omitted or silently normalized to another schema.

The exact signed message is the ASCII domain prefix
`PollyOS payload test signature v1\n`, followed by canonical JSON of **all
envelope fields except `signature`**, followed by one LF. The same sorted keys,
compact separators and ASCII escaping apply. Ed25519 signs this full message
directly, not a homegrown digest-only signature or Ed25519ph. Envelope version,
kind, algorithm, trust context, key fingerprint, body length/digest and complete
payload (version, architecture, SYSTEM/Dpkg/Apt identities, capacity and
compatibility included) are bound. Correcting a tampered body's public digest
and length does not repair its signature.

Public keys are **exact RFC 8410 Ed25519 SubjectPublicKeyInfo DER**, 44 bytes:
hex prefix `302a300506032b6570032100` followed by the 32 public-key bytes.
Test private keys are exact unencrypted PKCS#8 DER, 48 bytes:
hex prefix `302e020100300506032b657004220420` followed by the 32 seed bytes.
Algorithm parameters are absent. PEM, raw keys, encrypted/extended PKCS#8,
other algorithms and trailing material are rejected, not guessed. No public
key is accepted from the envelope; the verifier requires an independently
supplied trusted test public-key file and checks both its fingerprint and the
cryptographic signature. Keys are snapshotted into private temporary files
before invoking OpenSSL, then removed. The module does not generate keys.
Tests generate ephemeral keys only inside their disposable private fixtures;
no private key, production identity or user secret is checked into source.

### API and command boundaries

- `validate(envelope)`, `encode(envelope)`, `decode(text)` validate/round-trip
  structure only. They **do not verify** the signature.
- `signing_bytes(envelope) -> bytes` exposes the exact domain-separated message.
- `sign(payload, test_private_key, *, trust_context) -> envelope`.
  The required context must equal `"test-only"`.
- `verify(envelope, trusted_test_public_key, *, trust_context, expected_version,
  distribution, architecture) -> evidence`. Every keyword is required; context
  must equal `"test-only"`, distribution must match the existing Debian 13 object,
  and architecture must match `amd64`. No default trust or unsigned bypass exists.

Linux CLI examples (files are explicit test fixtures, not production keys):

```sh
python3 -I -B desktop/release/maintenance/signature.py sign-test system-payload.json \
  --test-private-key ephemeral-test-private.der --trust-context test-only
python3 -I -B desktop/release/maintenance/signature.py verify-test test-envelope.json \
  --trusted-test-public-key ephemeral-test-public.der --trust-context test-only \
  --expected-version 0.1.0-alpha.1 --distribution debian13 --architecture amd64
```

Signing emits only the canonical envelope plus LF to stdout. Verification emits
only canonical JSON evidence plus LF with exactly:
`{schemaVersion,kind,algorithm,trustContext,publicKeySha256,contractSha256,
contractBytes,version,architecture,payloadTrust,signatureVerified,materialVerified,
preflightRequired,productionTrusted,writeAuthorized,readOnly,authenticated,
bootVerified}`. Kind is `polly-system-payload-test-verification`;
`signatureVerified`, `preflightRequired`, `readOnly` are `true`;
`materialVerified`, `productionTrusted`, `writeAuthorized`, `authenticated`,
`bootVerified` are `false`; `payloadTrust` stays `development-unsigned`.
Failures emit stderr and nonzero status, with no successful evidence or fallback.

Source payload JSON is capped at 1 MiB; envelope JSON at 1 MiB + 4096 bytes
(UTF-8 source bytes, including whitespace); canonical payload/envelope encoding
must also fit their respective limits. Keys have the exact lengths above.
CLI accepts at most 32 arguments of at most 4096 UTF-8 bytes each, disables
option abbreviation and accepts only fixed commands/options. Inputs must be
regular Linux files with real ancestors: symlinks, `..` traversal, directories
and special nodes fail through the existing no-follow bounded reader. Caller
paths never become OpenSSL arguments: only owned temporary snapshots do.
OpenSSL runs as an argument vector without a shell, with closed stdin and a
10-second timeout per operation. Duplicate fields, booleans in integer slots,
non-finite/malformed/deep JSON, unsupported versions/architectures, bad digest/
length, noncanonical base64 and incorrect keys/signatures all refuse.

### What verification does not establish

**A valid test signature is not production trust, actual material correctness,
an authenticated Debian package origin, ABI/conffile qualification, bootability
or write permission.** `sign` validates the declarative shape; it does not capture
or qualify the source. Use T07.1 `capture` on independently qualified offline
trees first. After `verify`, the consumer must still run the unchanged
`payload.preflight` on that exact envelope's `payload`, actual offline SYSTEM/
PERSISTENT trees, available capacity and independently established current data
schemas. Check `contractSha256` equality between the two evidence records.
Verification never flips the old preflight's `authenticated:false` flag.
Preflight still refuses mismatched material, package state, capacity and schemas.

This unit includes no updater, replacement, apt execution, rollback/recovery,
root deployment, key enrollment/rotation/revocation/publishing or real device
operation. Production identity/promotion policy remains separately authorized
work. Old installed/image manifests and builder outputs retain their exact
interpretation and are not silently signed or treated as trusted.

Run `python3 -I -B desktop/tests/system-payload-signature.py` on Linux with
OpenSSL available. Synthetic tests measure exact body/source bounds and output
shapes, deterministic signatures/canonical framing, independent OpenSSL
interoperation, repaired-digest/body tampering, wrong keys/signatures, strict
parsing/CLI refusal and separate actual-material preflight rejection. Central
runner/source-check registration remains the integration owner's task.
