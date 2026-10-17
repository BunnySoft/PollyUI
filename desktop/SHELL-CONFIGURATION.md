# Shell configuration v4

Shell is the sole writer of `application.configDir/shell-preferences.json`.
Independent Settings requests changes through the existing authenticated IPC;
it never receives a configuration handle. Linux Shell composition passes
`--no-legacy-storage`; ordinary applications, protected roles, headless tests
and Windows retain their existing localStorage composition by default.

The JSON object has exactly `version: 4`, `theme: { id, filesEnabled }`,
`audio`, `display`, `workspace`, `shortcuts`, `desktop`, and `launchers`. A null theme ID selects the
packaged default; `filesEnabled` defaults to true. Null preference sections
mean no saved profile. Non-null audio/display/workspace sections retain their
existing v1 domain schemas and validation limits; shortcuts store only
action/modifiers/key, not labels or live handles. Unknown fields/versions and
invalid values fail explicitly. All updates validate the complete next object.
Snapshots are deeply frozen and published only after file publication.

The shortcut catalog has ten actions. The original seven retain their IDs and
numeric order; `tile-left`, `tile-right`, and `restore-floating` append defaults
Super+Left, Super+Right, and Super+Down. Null shortcuts use native defaults;
non-null v4 shortcuts must contain every action exactly once. Independent
Settings consumes this same catalog for recording, disabling and resetting.
The private `polly_shortcuts_v1` interface is strictly paired at version 2;
old clients/servers fail explicitly instead of applying a partial catalog.

`desktop` is `{ version: 1, shortcuts: [...] }`, initially empty. Each of at most
128 shortcuts is `{ id, name, output: { name, make, model, serialNumber }, x, y }`.
The ID is the catalog desktop-entry or `bundle:` ID, never a command; `name` is
only a bounded display snapshot for unavailable entries. Names are refreshed
from the catalog, and launching rechecks availability. IDs are unique globally;
coordinates are nonnegative integer logical output pixels, at most 32768.
Unknown fields and malformed output identities fail rather than dropping pins.

`launchers` is `{ version: 1, applications: [catalogId, ...] }`, initially empty.
It is an independent ordered list of at most 32 unique bounded catalog IDs, not
commands, runtime app IDs, PIDs or live window handles. Unknown applications remain
pinned and visibly unavailable until removed or registered again. Removing a
taskbar/Dock pin never removes a desktop shortcut, and shortcut changes do not
modify launcher pins. IDs are opaque references of at most 255 UTF-16 code units;
valid Unicode and spaces are retained exactly, while control characters, lone
surrogates and slash/backslash path components are rejected. They are never
interpreted as executable names, paths or URLs. Explicit `applications` and
`windows-launchers` task modes display them. In `applications` mode, running groups
merge with a pin only through the existing unique exact/explicit catalog identity
association; ambiguous associations retain separate running tasks. XP selects
`windows-launchers`: compact Quick Launch items always launch independently,
followed by unchanged individual Window.id tasks. Missing/`windows` mode remains
unchanged. All modes share this saved pin order; no new preference version or
separate Quick Launch store is introduced.

Existing v1/v2/v3 JSON is validated, upgraded once by the same atomic writer, and
preserves every original domain. It does not reread legacy localStorage.
An upgrade write failure is explicit, retains the uncommitted original file, and
does not create a success-shaped in-memory configuration. A post-rename
durability failure retains the published v4 file and reports uncertain durability.
The seven legacy shortcut bindings, including disabled/custom bindings, remain
unchanged. Only the three new defaults are added. If a new default collides with
an old binding, that new action is explicitly Disabled and the Shell reports
all such conflicts once after successful migration publication; Settings can
reassign it. Migration never changes an existing user chord to make room.
The desktop/launcher domains remain version 1. Older binaries do not read v4; downgrading the Shell requires a separate,
explicit configuration compatibility decision. Before returning to an older
binary, restore an original backup or otherwise provide a configuration that
that binary understands; there is no automatic downgrade or backup framework.
An unknown schema is never replaced with empty defaults. With an empty launcher
list, taskbar/Dock slots retain their previous running-task behavior.

Layouts match output-management connector/make/model/serial tuples. SDL display
IDs are not output-management head IDs: the Shell associates them by the
advertised name/description, using logical placement to disambiguate duplicates.
Ambiguous or unavailable identities cannot save placement. An empty serial
uses the available connector tuple, not a fabricated hardware identity; connector
renames or hardware identity changes are treated as disconnected layouts.
Pins for disconnected displays appear temporarily on the first surviving
output without changing their saved home. A completed move or sort explicitly
saves the new output and logical positions. Work-area/DPI reflow never silently
deletes pins or overwrites their saved large-display layout.

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

## Read-only decoration bootstrap

The independent Linux decorator does not own an application preference store
or call `openShellConfiguration()`. It does not create Shell or decorator
configuration/data/cache directories, a writer lock, migration output, or a
second preference file. In a compositor that has never committed a theme, it
may read the existing Shell namespace's JSON with the same private-file checks
and complete validator. Only when JSON is absent may it read and decode the
existing legacy file; this does not write the migration. It respects
`theme.filesEnabled` and reuses the shared bounded user-theme reader, validator
and JS geometry encoder.

The WM, not a daemon-local flag, controls this one-shot bootstrap authority.
A valid Shell prepare invalidates any staged bootstrap and takes priority.
Both bootstrap prepare and commit check the current WM generation and absence
of a Shell transaction. Shell cancellation/disconnection can reopen eligibility
only while no theme has ever committed. Any successful theme commit permanently
consumes bootstrap permission for that WM session, including renderer restarts.
The Shell may always publish a later valid theme using its normal transaction.

Missing preferences select the packaged default. Corrupt, unsafe or unreadable
data produces an explicit diagnostic and may use the packaged default only
while bootstrap is still authorized; the file is never repaired or overwritten.
If even the packaged recovery theme is unavailable, initialization fails.
Once the WM holds a valid theme, the renderer uses its request documents rather
than rereading preferences or replacing it with a fallback when the Shell exits.
This is separate from the Shell's strict write/migration failure policy above.
