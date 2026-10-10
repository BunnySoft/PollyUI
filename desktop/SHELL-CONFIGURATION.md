# Shell configuration v1

Shell is the sole writer of `application.configDir/shell-preferences.json`.
Independent Settings requests changes through the existing authenticated IPC;
it never receives a configuration handle. Linux Shell composition passes
`--no-legacy-storage`; ordinary applications, protected roles, headless tests
and Windows retain their existing localStorage composition by default.

The JSON object has exactly `version: 1`, `theme: { id, filesEnabled }`,
`audio`, `display`, `workspace`, and `shortcuts`. A null theme ID selects the
packaged default; `filesEnabled` defaults to true. Null preference sections
mean no saved profile. Non-null audio/display/workspace sections retain their
existing v1 domain schemas and validation limits; shortcuts store only
action/modifiers/key, not labels or live handles. Unknown fields/versions and
invalid values fail explicitly. All updates validate the complete next object.
Snapshots are deeply frozen and published only after file publication.

Only when the JSON file is absent, Shell reads its own
`application.dataDir/localstorage.dat` once, strictly parses PUST1 byte lengths
and UTF-8, validates every recognized preference, and publishes one JSON file.
Unknown keys remain only in the original file. The original is never renamed,
deleted or updated. An absent legacy file creates defaults; invalid legacy data
blocks migration without creating JSON. Once JSON exists, legacy data is never
read, including at launcher startup. No working-directory or other-app data
is scanned. Invalid JSON does not fall back or overwrite the original.

Persistence uses native FileSystem/FFI, component-by-component NOFOLLOW directory
opens, a user-owned private final directory, private regular single-link files,
and a lifetime nonblocking flock writer lock. Lock descriptors close on exit;
the persistent lock file is not a stale-file ownership marker. A second writer
fails rather than losing updates. This is cooperative single-writer protection,
not a same-UID security sandbox or atomic compare-and-swap against unrelated
external editors.

Writes use an exclusive random same-directory temporary file, complete
short-write/EINTR loops, file fsync, atomic rename, and directory fsync.
Initial creation uses RENAME_NOREPLACE. Pre-publication failures preserve the
previous object and remove the staging file. After rename, a directory-sync
error has `committed: true`: the new file and in-memory state stay published,
durability is uncertain, and the UI reports the failure without replay or
native/theme rollback. Theme ID and file-enabled state publish together;
pre-publication save failure restores the previous native appearance.
This is not a distributed transaction across native UI and disk. Retained
closed handles reject use. FileSystem itself has no application capacity quota.

This alpha loop targets Linux x86_64 glibc/musl Shell only, not a configuration
registry, other applications' migration, or cross-platform configuration.
