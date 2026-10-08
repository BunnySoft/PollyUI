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

## Confirmed P0 target, not the current implementation

The [storage design](../docs/POLLYOS-STORAGE-DESIGN.md) now takes priority:
shared code in `/Apps/Packages/<PackageHash>`, global registration/policy in
`/SystemData/Apps`, and separate HOME/XDG data per stable UID.
The current per-user CLI below has **not** been migrated. Global install,
replace and uninstall need a restricted backend that verifies the real caller;
running this existing manager through sudo is not the implementation.
apt retains its own package authority and program tree.

Migration must resolve conflicting old users' active versions before switching,
preserve stable app IDs and source data, and validate two-user isolation.
Global removal is not personal launcher hiding; GC must consider cross-user
references and resource users. Launcher policy alone is not execution isolation.
Tasks, decisions and status live only in
the [execution ledger](../docs/POLLYOS-BACKLOG.md#16-完整执行清单与依赖), M04/M15.
The commands and evidence below remain scoped to the current private store.

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

## Bounded desktop-entry D-Bus activation

PollyShell supports **launch without documents** for an entry with
`DBusActivatable=true` and no `Exec`. The desktop-file ID (including recursive
XDG directory-to-dash mapping) must end in `.desktop`. Removing that suffix must
give an ASCII, non-unique D-Bus bus name: at least two nonempty dot-separated
elements, each starting with a letter, underscore or dash and containing only
letters, digits, underscores or dashes. The bus name is at most 255 bytes (263
bytes including `.desktop`); NUL, Unicode, slashes, empty elements and
digit-leading elements are rejected. The object path prefixes `/`, changes
dots to slashes and dashes to underscores, for example:

```text
org.example.Foo-Viewer.desktop
  destination: org.example.Foo-Viewer
  object path: /org/example/Foo_Viewer
  interface:   org.freedesktop.Application
  member:      Activate
  signature:   a{sv} (empty platform data)
```

Neither interface/member nor command/platform data are caller-selectable.
`desktop.activateApplication(id)` returns a Promise resolving **only after an
empty method-return** to:

```js
{ kind: 'dbus', id: 'org.example.Foo-Viewer.desktop',
  busName: 'org.example.Foo-Viewer', objectPath: '/org/example/Foo_Viewer',
  acknowledged: true }
```

This is acknowledgement of the request, **not a PID, window or readiness
guarantee**. Bus auto-start is enabled; an application need not already own the
name, but must provide its standard session D-Bus `.service` registration.
`desktop.canActivateApplication()` reports only whether the existing private
bus address/socket qualifies for an attempt. It does not query service
availability, name ownership or readiness. The launcher additionally validates
the desktop ID and rediscovers the entry before each attempt; deletion,
hidden/invalid higher-priority masks, visibility and `TryExec` still apply.

Activation reuses `pu_session_bus_connect` and its unchanged trust guard:
`POLLY_SESSION_BUS_ADDRESS` must exactly match `DBUS_SESSION_BUS_ADDRESS`;
`XDG_RUNTIME_DIR` must be an absolute, UID-owned 0700 directory; the sole Unix
address must name that directory's UID-owned `/bus` socket. It never selects the
system bus, an inherited/default host bus or libdbus autolaunch. This is the
existing same-UID session boundary, not an adversarial application sandbox.
The private activation connection closes when the pending set becomes empty.

There are at most eight pending requests, each with a 3000 ms method-reply
deadline after sending, a 16 KiB incoming-message bound, 64 KiB received queue,
no accepted or exported FDs, and at most 64 dispatches per pump. Initial local connection
authentication/registration uses the existing session-bus helper; the method
deadline does not claim to bound that helper's synchronous connection setup.
Queue/ID/trust/send failures throw synchronously. Remote errors reject with
their D-Bus error name in `error.code`; timeout, disconnect, invalid reply,
dispatch failure and shutdown cancellation reject explicitly and are logged.
The absolute method deadline takes priority over completed/reply state. If a
blocked UI pump resumes after the deadline, even an empty method-return is
rejected as timeout/indeterminate: no receipt timestamp proves it arrived in
time. A delayed method-return cannot turn an expired request into success.
Timeout/disconnect/cancellation can mean delivery already occurred. There is
**no automatic retry, Exec fallback or fabricated positive PID**. Shutdown
cancels pending calls, releases Promise references and closes only this
connection; it does not terminate applications activated by the bus.

Ordinary `Exec`, `TryExec`, localized metadata, terminal prefixes, managed
bundles and direct child/exit lifecycles keep their existing paths. An entry
that has `Exec` continues to use it even with `DBusActivatable=true`; malformed
`DBusActivatable` boolean values are rejected rather than silently ignored.
For D-Bus-only entries the service controls its own working directory/terminal;
the launcher does not fabricate a terminal command. The separate local-document
contract below adds standard `Open` without changing launch-only `Activate`.
`ActivateAction`, startup tokens and generic D-Bus/privilege APIs remain outside
both contracts.

Shell `launchApplication` still returns a PID synchronously for Exec. For this
activation path it returns a Promise resolving to the acknowledgement (or
`null` after a visibly reported launch failure). A queued request leaves its
menu open. Success closes only the originating menu instance; late rejection
is logged but cannot repaint a replacement menu or a stopped Shell. A
launch-only scope token is invalidated at stop, so a menu-less request from a
previous Shell generation cannot clear or overwrite errors after restart.

### Focused fixtures and evidence boundary

```sh
node --test desktop/tests/application-activation.mjs \
  desktop/tests/menu-host.mjs desktop/tests/xp-startup-compatibility.mjs
sh desktop/tests/application-activation-check.sh /absolute/evidence
node desktop/tests/application-activation-fixture.mjs \
  /absolute/rebuilt/pollyui /absolute/evidence/application-activation-service /absolute/evidence
```

The scoped check compiles only `applications.c` (including a layer-shell syntax
check) and the synthetic libdbus service fixture, then runs pure Node regressions
and a fixture-infrastructure probe. **The `--probe` run is not product-native
verification.** The final command requires a genuinely rebuilt desktop-enabled
PollyUI; it rejects old binaries without the API, rather than substituting a
stub. It starts an isolated `dbus-daemon` with only synthetic service files,
verifies real service auto-start and the exact invocation, blocked/invalid/error
replies, failed service startup, missing/wrong service, queue/timeout/pump,
an actual service reply after 3000 ms while the native pump is deliberately
blocked (delivery is confirmed before blocking),
oversized and actual FD-bearing reply rejection, disconnect, native shutdown, strict host-bus rejection and
entry deletion/masking rediscovery. Runtime sockets live on a Linux temporary
filesystem; logs/configs/results are copied to the evidence directory even on
failure. It never scans host applications or contacts a real host service.
The menu host tests use controlled Promises to verify instance/stop scoping;
they do not stand in for rebuilt QuickJS/native completion and cancellation.

The activation connection keeps a one-FD live receive budget because libdbus
backpressure at zero also prevents ordinary FD-free replies from being read.
The per-message transport setting remains zero, with explicit descriptor-presence
validation on completion: actual FD-bearing replies reject rather than becoming
acknowledgements, regardless of transport-specific limit handling. This does not extend the
3000 ms absolute deadline, permit descriptor inputs or enable retries.

CTest registers `desktop-application-activation-unit` for the pure Node suite
and `desktop-application-activation-native` for the actual product fixture.
The synthetic service target, `polly-application-activation-service`, links only
the existing session-bus helper and libdbus, with strict C warnings; it adds no
GLib dependency. The native test receives absolute target paths for the rebuilt
PollyUI and service, keeps isolated evidence under the private build directory,
and has a 120-second timeout. It runs the product mode, never `--probe`.
Native acceptance requires an ordinary-user run of these newly built targets;
registration or standalone infrastructure probes do not establish that result.
The source-only storage runner remains Python-only.

## Local document MIME and default applications

`createApplicationLauncher(desktop)` now exposes two **Linux desktop** methods:

```js
launcher.documentApplications('/absolute/local/document.txt');
// { mimeType: 'text/plain', defaultApplication: 'editor.desktop',
//   applications: [{ id, name, path, mimeTypes, documentField, dbusOpen }, ...] }

launcher.openDocuments(['/absolute/local/document.txt', 'file:///absolute/other.txt']);
launcher.openDocuments(['/absolute/local/document.txt'], 'editor.desktop');
// Exec: actual child PID, with the existing onExit lifecycle.
// D-Bus-only: Promise resolving after the actual empty Open method-return.
```

This reuses the existing `applicationFiles`/desktop-entry parser and launch
helper. There is no second application registry, shell command interpolation,
GLib/GIO/GObject dependency or privileged file opener. A handler must advertise
the concrete `MimeType` **and** have exactly one `%f`, `%F`, `%u` or `%U` field
in `Exec`, or be a valid D-Bus-only application with document `Open` available.
An app that merely launches, or a managed bundle whose existing manifest has
no document capability, is not silently treated as a document handler. A
selected handler must qualify for **every** document; differing defaults require
an explicit common handler, not partial launch or guessing from the first file.

`desktop.documentMimeType(path)` opens a readable regular file as the current
user and invokes fixed `/usr/bin/file --brief --mime-type --dereference -- /proc/self/fd/3`.
The validated open descriptor is retained only in that child. All unrelated
descriptors are closed; stdin is `/dev/null`, output/error are captured together,
and the environment contains only a fixed `PATH` and `LC_ALL=C`. The `file`
utility and its distribution-provided magic database must be present in the
delivered runtime. The immutable SDK already has both; SDK availability alone
does not prove a release has them. No extension-only fallback, guessed type or
success-shaped tool error is returned. Missing tool, nonregular/unreadable file,
nonzero exit, invalid MIME output, output above 256 bytes and a 1500 ms
post-spawn processing deadline are explicit errors. Classification is synchronous
and bounded per file, not an asynchronous content-service API. This is the
distribution's `file` content classification, not a new shared-mime-info magic,
alias, subclass or glob implementation; the returned concrete type is matched
exactly against desktop entries and mimeapps keys.

`desktop.mimeAssociationFiles()` reads standard XDG sources in this order:
`$XDG_CONFIG_HOME` (or `~/.config`), each `$XDG_CONFIG_DIRS` (or `/etc/xdg`),
`$XDG_DATA_HOME/applications` (or `~/.local/share/applications`), then each
`$XDG_DATA_DIRS/applications` (or `/usr/local/share` and `/usr/share`). Within
each directory, `polly-mimeapps.list` precedes `mimeapps.list`; Polly's
desktop-specific file contributes **defaults only**, as required by the MIME
apps specification. Generic files contribute ordered Default Applications,
Added Associations and Removed Associations. Higher-priority additions survive
lower removals; removals prevent lower additions and declared associations.
Default candidates must still be installed, associated, advertise the type and
handle document parameters. Missing/invalid/masked/unavailable candidates are
not launched; remaining defaults, then associated handlers, are considered
in priority order. Missing association files are empty directory markers, not
errors or fabricated default selections. Other read failures and malformed
NUL/UTF-8/duplicate groups/keys/lists are explicit errors, not ignored settings.
No settings are written and no real user defaults are changed.

`Hidden` and invalid higher-priority desktop files continue to mask lower copies,
including recursive desktop IDs; `TryExec`, executable availability and Polly
visibility rules still apply. `NoDisplay` excludes an app from the Apps menu but
does **not** exclude an otherwise valid document handler. The catalog, MIME
types, defaults, removals, terminal and capability are rediscovered for every
document query/open. As with ordinary pathname-based desktop launching, this
does not lock documents or application metadata against subsequent concurrent
changes by their owner.

Documents are only absolute Linux paths or encoded, authority-free `file:///`
URIs. Remote schemes, host authorities, double-slash paths, query/fragment
components, malformed escapes/UTF-8, relative paths, lone surrogates and NUL
(including `%00`) are rejected. Unicode, spaces, quotes, percent signs and
command-looking path bytes remain literal data. Paths are limited to 4095 UTF-8
bytes; a request has 1–32 documents and at most 8192 combined URI bytes including
terminators. `%f`/`%u` accept one document (multi-document requests refuse rather
than discard files), `%F`/`%U` produce one argument per document, and `%u`/`%U`
encode local paths as file URIs. `%i`, `%c`, `%k`, `%%`, whole-argument quoting
and no-document placeholder removal preserve the existing semantics; expansion
never reparses the resulting document/name/icon as command text. A document
cannot select the executable. Document Exec argv is bounded to 256 arguments
and 64 KiB including any configured terminal prefix. `Path`, `Terminal`, ordinary
exit reporting and bundle digest launch selection retain their existing paths.
Unsupported platforms or missing native MIME/Open capabilities explicitly
refuse the applicable operation rather than reporting an unsupported success.

For D-Bus-only handlers, `desktop.openApplicationDocuments(id, localFileUris)`
uses the same validated desktop ID/object path and qualified **private session**
connection as activation:

```text
interface: org.freedesktop.Application
member:    Open
signature: asa{sv} (bounded local file URI array, empty platform data)
```

It returns the actual Promise, with success shaped as the existing
`{ kind: 'dbus', id, busName, objectPath, acknowledged: true }` plus
`method: 'Open'`. This is acknowledgement, not PID/window/readiness or proof the
app displayed a document. Inputs must also identify currently readable regular
files at the native boundary. Activate and Open share the eight-request queue,
post-send absolute 3000 ms expiry-first deadline, incoming size/dispatch bounds,
live-FD receive budget **one**, per-message FD budget **zero**, and explicit
FD-bearing reply rejection. The common helper's synchronous connection setup
is still outside that post-send deadline. Interface/member/platform data are
not caller-selectable. All timeout/disconnect/invalid-reply/shutdown outcomes
retain explicit indeterminate errors and **no retry, Activate substitution,
Exec fallback or replay**. Entries with `Exec` still take their original Exec
path even when `DBusActivatable=true`.

### Document fixtures and integration boundary

```sh
sh desktop/tests/document-association-check.sh /absolute/scoped-evidence
node desktop/tests/document-association-fixture.mjs \
  /absolute/rebuilt/pollyui /absolute/rebuilt/document-association-service \
  /absolute/rebuilt/document-association-process /absolute/native-evidence
```

The scoped runner checks only strict C objects (including layer-shell syntax),
pure Node document/activation/menu/XP regressions, fixture syntax and synthetic
helper compilation. It does **not** build or validate the product-native API.
The product fixture accepts no `--probe`, old API-less binary or replacement
stub. It creates only ordinary temporary documents, private XDG application
and mimeapps directories, isolated service registrations and a private daemon;
it neither scans host applications nor reads/writes real user defaults/docs.
It measures actual application argv/URI/cwd/environment/FD isolation and child
exit, actual standard Open auto-start/signature/URI/empty platform-data,
ACK/error/invalid/actual FD/oversized reply rejection, shared queue/timer,
blocked-pump expiry-first, changed metadata/default rediscovery, malformed
settings, host-bus refusal, shutdown and disconnect without replay. Linux
temporary runtime directories and all logs/configs/results (including failures)
are retained as byte-copied evidence.

The parent integration must add `src/desktop/documents.c` alongside
`applications.c`, register this Node suite and actual product fixture, and build
the two dedicated fixture targets with the existing session-bus helper/libdbus.
It must ensure `file` plus its magic database in runtime packaging and rerun
the existing desktop-applications, activation, menu, XP and bundle fixtures
against the newly built fixed source. Child scoped checks and committed fixtures
are not full T20.1 native acceptance or release/image/real-media verification.

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
