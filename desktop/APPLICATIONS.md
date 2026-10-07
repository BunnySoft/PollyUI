# Managed applications and independent AppData

`polly-app` manages **local, per-user application bundles** on Linux. A bundle is
a directory with `manifest.json`, program files, private libraries and resources.
The same files may be distributed as tar, tar.gz or zip with the manifest at the
archive root. Installing copies/extracts into a managed store; it never executes
package installation scripts. Launching an installed application is a separate
operation that executes its declared entry.

The canonical schema and launch/data rules are shared with PollyShell in
`shared/app-bundle.mjs`. The CLI embeds that exact module at build time and
evaluates it in a small QuickJS context with no filesystem, process or import
capabilities. It does not load validation code from the package. Native code
provides bounded filesystem/archive operations using libarchive and SHA-256.
No Node, Python, root service or GLib/GIO loop is required by the manager.

## Package and data layout

```text
Notes.app/
  manifest.json
  main.mjs
  resources/
    icon.png
```

```json
{
  "schemaVersion": 1,
  "id": "org.example.notes",
  "name": "Notes",
  "version": "1.0.0",
  "target": {"os": "linux", "architecture": "x86_64", "libc": "glibc"},
  "launch": {"kind": "pollyui", "entry": "main.mjs", "arguments": []},
  "data": {"layout": "pollyui", "schema": 1},
  "icon": "resources/icon.png"
}
```

`native` entries use `data.layout=xdg` and must have executable permission in the
source directory/archive. They may use system libraries available on the target
or private libraries with application-controlled relative loader paths; the
manager does not invent an arbitrary `LD_LIBRARY_PATH`. A matching libc/CPU
declaration is necessary, **not proof that every runtime dependency is present**.
Unsupported ABI targets, missing entries and failed exec return errors.
The package must include resources and licenses appropriate for redistribution.
This is not a general `.deb` conversion tool.

The store defaults to `$XDG_DATA_HOME/polly-apps`, or
`~/.local/share/polly-apps`, separately from application data:

```text
polly-apps/
  lock
  apps/<app-id>.json         active version and previous-version reference
  retired/<app-id>.json      explicitly removed registration, when present
  objects/<content-digest>/  retained code and resources for one complete version
```

Application config/data/cache/state remain in distinct
`XDG_*/pollyui/<app-id>` namespaces. PollyUI receives `--app-id`; XDG-compliant
native apps receive per-app XDG roots without changing `HOME`. User documents
are not part of the code store. Version, name and install location never enter
the data ID. The first installation refuses reserved Shell/IME IDs, an ID
already registered/retired, or pre-existing unregistered data; automatic adoption
of unknown data is deliberately not implemented.

## Commands

Run as the ordinary user, **not through sudo**. Sources must be absolute paths.

```sh
polly-app install /home/polly/Downloads/Notes.app
polly-app install /home/polly/Downloads/Notes.tar.gz
polly-app list
polly-app run org.example.notes
```

Successful installation prints the application ID and installed content digest.
`list` returns validated JSON registry records. No directory is created merely
by listing a nonexistent store.

After installing, use **Refresh** in PollyShell's Apps menu. Managed packages
appear alongside existing `.desktop` entries, with separate `bundle:` catalog
IDs. The current launcher is still a text list; icon metadata is carried but
this change does not claim an app-icon grid or file-manager `.app` presentation.
The selected digest travels to `polly-app run`, so a stale menu cannot silently
launch a newly replaced version. The regular application exec helper preserves
exit reporting and public Wayland/session bus inheritance. The manager strips
private Wayland/activation identity and marks unrelated descriptors close-on-exec
before starting the application.

## Explicit update and rollback

```sh
polly-app replace /home/polly/Downloads/Notes-v2.zip CURRENT_CONTENT_SHA256
polly-app rollback org.example.notes CURRENT_CONTENT_SHA256
```

Replacement is an explicit local trust decision, not an automatic publisher
update. An already installed ID cannot be overwritten by `install`. Replace and
rollback must name the observed current digest; concurrent or stale selections
fail. Updates with a changed app ID are not replacements.

Every directory/file name, executable flag and byte contributes to the installed
content digest. Entries are sorted and directory boundaries are encoded, so
container format and tar/zip ordering do not define identity. Modification of
installed content prevents execution. **This digest detects content changes; it
is not a signature, publisher identity or application-sandbox guarantee.**

The manager stages and syncs a complete code object before atomically replacing
the active registry file. It records the previous version for rollback. Identical
replacements are no-ops and do not discard rollback history. Sync errors after
registry replacement explicitly report that state may already have changed;
inspect `list` rather than blindly replaying an operation.
An identical replacement still verifies the existing content object; it cannot
declare changed installed bytes healthy merely because the supplied archive has
the previously registered digest.

Automatic data migrations are not supported: the first updater **rejects a
change of `data.schema` or layout**, leaving the active registration and AppData
untouched. Authors must keep this declaration accurate. Application code itself
can modify its data once executed; path separation cannot prove backward
compatibility or prevent a dishonest app from changing a database.

## Remove, restore and interrupted work

```sh
polly-app remove org.example.notes CURRENT_CONTENT_SHA256
polly-app restore org.example.notes RETIRED_CONTENT_SHA256
polly-app recover
```

`remove` atomically retires the registration: it disappears from Apps after
refresh and can no longer be started through the manager. **It retains AppData,
the reserved identity and the code-version cache.** `restore` requires the
retired digest and rechecks that version's content. This is reversible logical
removal, not a claim of complete disk-space reclamation.

Old code is intentionally retained even after replacement/removal. Native apps
can have detached descendants; deleting an old resource tree while one of them
still uses it would break the version-lifetime contract. Safe version-cache
reclamation and explicit user-data deletion remain later work, not hidden
side effects of these commands.

`recover` holds the store lock and removes only owned `.stage-<random-id>`
records/directories left by interrupted writes. It does not remove registered
versions, retained objects or user data. Failures after publishing code but before
registration can leave an unreferenced code object; it remains a cache item,
not an active app. Ordinary errors attempt to remove their own staging directory
and report cleanup failures. No app is executed to repair the store.

## Bounds and trust limits

- At most 256 active applications, 4096 package members, 32 directory levels,
  256 MiB per file and 512 MiB total extracted data; archive input is at most
  512 MiB. Copy/read loops check a 60-second processing budget.
- The shared schema bounds manifest/arguments/identifiers. Icons must be regular
  files at most 4 MiB; image decoding remains the renderer's responsibility.
- Traversal and parent creation use directory FDs and no-follow opens. Source
  and archive symlinks, hardlinks, devices/FIFOs, set-ID files, encryption,
  invalid paths, duplicate file entries and truncated payloads are rejected.
  Archives use only the supported tar/zip formats and gzip filter.
- The store and data leaves are user-owned private directories. Program objects
  are installed without write bits, with no archive-provided ownership or special
  permissions. The owner's ability to chmod or modify their own files still
  exists: this is not an adversarial same-UID sandbox or authenticated mount.
- A nonblocking advisory lock excludes cooperating registry operations. An
  occupied/corrupt store is an explicit error, not an empty success-shaped catalog.
- Install paths never select block devices, change system packages, start a root
  service, upload content or execute package hooks.

## Evidence and remaining work

Fixtures execute the real unprivileged CLI on temporary Linux directories,
including directory/tar/zip installs, stale replacements, schema mismatch,
rollback, remove/restore, tampering, concurrent locking, oversized/malformed
archives, dangerous links, and interrupted writes. They preserve actual PollyUI
localStorage through version changes and verify native argv/XDG/FD boundaries.
Native Shell pointer tests launch an installed public PollyUI process, plus a
copy of the distro's `foot` Wayland terminal using that distro's runtime libraries.
This is a representative compatibility test, not a claim that all Linux apps
are self-contained or respect XDG.
The third-party fixture also reads a real `foot.ini` from its managed XDG config
directory, changes the bundle revision and relaunches it, verifying its config
and prior data remain untouched through replacement and rollback. This tests
repackaging/version selection of the installed distro binary, not compatibility
between arbitrary upstream foot releases or database schema migrations.

The management UI, explicit source/publisher associations beyond local replacement
approval, richer native adapters, data adoption/migration, safe code-cache GC,
and separately confirmed data erasure are not implemented. Neither cross-reboot
persistence nor full USB installation follows from these temporary-filesystem
tests. The current Debian candidate separately passes the graphical memory gate
with its corrected Mesa packages; managed filesystem tests alone never waive
graphics or hardware acceptance. See the [current PollyOS handoff](../docs/POLLYOS.md).
