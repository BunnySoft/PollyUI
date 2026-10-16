# Files: ordinary-user browser and shared file API

Launch the standalone native application with:

```sh
pollyui --desktop --app-id org.pollyui.files desktop/apps/files/main.mjs
pollyui --desktop --app-id org.pollyui.files desktop/apps/files/main.mjs /absolute/local/folder
```

`--desktop` supplies the existing application/MIME and theme client APIs; this
window neither creates a Shell surface nor acquires trusted Shell management
authority. The installed `polly-files` launcher resolves the installed data
directory, uses its absolute entry path and runs from that root for JS imports.
`sysrt/sdk/js/files.mjs` exposes native libc calls by their OS symbol names,
with explicit arguments and unchanged `{value, errno, systemError}` results.
`sysrt/bindings/files.mjs` supplies signatures and Linux LP64 layouts.
Profiles cover Linux x86_64 glibc and musl; architecture, pointer/long widths
and symbols are checked before use. Unsupported symbols/ABIs
fail explicitly. Musl enumeration uses its real `getdents` symbol and int result,
not glibc's `getdents64`/ssize declaration.
There is no C filesystem provider or QuickJS filesystem projection. Basic SysRT
calls have no text-size, file-size, enumeration-count or UID restriction and
do not depend on localStorage. `desktop/shared/file-system.mjs` owns the Files
UI's bounded text/snapshot, SHA256 observation and ordinary-user policies.
`desktop/launcher/services.mjs` assembles this service as `desktop.fileSystem`
before the application entry. The generic GUI prelude
hook knows nothing about filesystem or desktop services.
Shared modules resolve from the runtime's installed data directory before
application-local files, including when a managed bundle owns the working directory.
Ordinary Linux apps without `--desktop` receive only this SDK object, not spawn,
application catalog, window-management or appearance management APIs.
Greeter, lock and input-method roles receive neither the FFI module nor this SDK
prelude. SHA256 uses existing OpenSSL EVP through FFI. All descriptors and
temporary buffers are released within the synchronous operation.
Install the production `desktop/apps/files` modules, excluding `tests`, and the existing shared
`desktop/shell/{applications,bundles,documents}.mjs`, shared bundle schema,
`desktop/client/theme.mjs` and theme-schema dependencies using the normal module
layout. Do not expose trusted-shell globals to this ordinary application.

## Visible operations

Home, Documents, Downloads and Desktop are conventional paths under the
process's explicit `HOME`; nonexistent paths fail visibly and are not created.
The sidebar, breadcrumbs, Up, Back, Forward and Refresh navigate real directory
snapshots. There is no preselected entry. Single-click selects; double-click or
Enter opens. The command bar and right-click/Shift+F10 menu operate on that exact
selection. Arrow keys, Home and End move through the visible sorted/filtered rows;
PageUp/PageDown from the list or a row move the single selection by one visible
viewport of 42px rows, clamped to the first/last match. Inputs, modal/context menus
and Ctrl/Alt/Meta-modified Page keys retain their own behavior.
F2 focuses the inline rename field, Enter explicitly confirms, and Escape cancels
and restores row focus. F5 refreshes, Alt+Left/Right navigate history, Alt+Up goes
to the parent, and Ctrl+L/Alt+D opens an editable absolute address.
Ctrl+F focuses **Filter this folder** (not a recursive filesystem search),
Ctrl+Shift+N opens the existing New folder confirmation, and Alt+Enter opens
the selected item's Properties without opening the file. These commands leave
an active modal input or composition alone; creating still requires confirmation.
The first ready snapshot receives list focus, so these keys work before a
pointer click. Deferred reveal/focus work cannot steal a later input click.
Retired address/name inputs are explicitly detached, including when their
reconciler slot is reused for breadcrumbs or ordinary row contents.
The original modern layout has a Places sidebar, navigation/address bar,
command bar, Name/Modified/Type/Size columns and continuous native wheel scrolling
through the bounded snapshot. The right-edge scrollbar drags the actual list
offset with native mouse capture, pages one viewport on a track press, and
supports arrows, Page Up/Down, Home and End when focused. Its proportional thumb
has a 28px minimum and clamps at both ends; short/empty lists hide the rail.
The 10px overlay occupies existing trailing padding, without subtracting width
from the file rows or metadata columns, including 640/680px windows. Wheel,
keyboard row revelation, filtering and layout changes keep the thumb synchronized.
Its surfaces come from the one desktop scrollbar adapter's `overlay` variant;
Classic/Luna/Aqua end-arrow regions use the same generic 42px step as the keyboard.
The `full` variant remains available for consumers with a reserved wider gutter.
Retheming keeps the same track/thumb and capture owner. Hover, held, drag, focus,
disabled and start/end states reuse passive theme primitives; the existing
100ms layout update does not redraw unchanged scrollbar states. No row/column
width or selection-ink policy is changed to accommodate the rail.
Column headers toggle ascending/descending order;
folders remain first. **Filter this folder** matches loaded names only, never
starts a full-disk search or reads file contents. Filtering hides an unmatched
selection rather than leaving invisible commands actionable. A directory containing
more than 1024 entries is explicitly **partial**, never presented as complete.
The bounded file-list viewport uses the engine's explicit `flexGrow` and
`flexBasis` properties, not unsupported CSS `flex` shorthand. Rows overflow
inside that viewport; status and partial/error notices remain within the window.
Selected or hovered rows consume the existing optional `colors.selectionText`
for name/metadata and explicitly marked original monochrome icon strokes, using
the shared selection-ink state painter. Leaving an unselected row restores each
part's original text/muted/directory color. Missing tokens keep the former
per-part fallback; inline rename inputs and bitmap art are not recolored. This
changes no row/column geometry, selection generation or filesystem action.
Places, empty-state text and Properties use the same theme typography as the
file list; property-panel spacing also follows the existing layout tokens.
Properties names, full paths and symbolic-link targets use the existing
read-only raw-text viewports, including wheel and Left/Right/Home/End access.
**Copy path** in Properties or the selected-item context menu, and Ctrl+Shift+C
outside an input/composition, copy that exact selected path as plain clipboard
text. This is not file copying or a file-transfer clipboard format; plain Ctrl+C
remains input text copying. The action requires the existing GUI text clipboard
capability, otherwise it is visibly unavailable and disabled. Clipboard errors
stay explicit without closing Properties or discarding the ready folder/selection.
Successful context copy dismisses the menu through the existing row-focus path;
retired generations and selected identities cannot copy a replacement item.

Filter, address and inline name fields use the same SDK text input, not a second
editor. Captured dragging continues outside the field/window and release records
the final position. Shift+Left/Right/Home/End and Shift-click extend the current
anchor; an unmodified arrow collapses a selection to its corresponding edge.
Long text scrolls horizontally to keep the caret visible, and pointer hit testing
uses the actual viewport rectangle even inside a vertically scrolled list.
Inputs show themed focus borders and select a native text cursor on hover/drag.
Blur, native cancellation, capture loss and detach terminate dragging without
publishing a cancelled primary selection or applying late motion/release.
List gestures are also retired on UI-generation changes and window close.
This adds no file operations, multi-selection, rubber-band selection or outgoing
drag/drop.

Files dialog, context-menu and breadcrumb surfaces share the passive
`desktop/shared/ui/panel-appearance.mjs` policy. Shape, spacing, border and
body/surface colors come from the current theme, not preset IDs. Classic uses
the existing bevel alone at the outside edge while preserving the border's
content inset; inline rename remains an unframed, non-modal row edit.
Content-sized Files modals and context menus use `panel-viewport.mjs` so their
passive outer frames remain fixed while only inner content scrolls. Intrinsic
height is preserved below the consumer's existing `maxHeight`; a short panel
does not fill that maximum or collapse to padding. Breadcrumbs use the same
mechanism on its horizontal axis, including first/last focus reveal through the
existing horizontal scroll primitive. The original bounded two-frame focus
settlement is shared, not a separate Files focus engine. Retheming does
not replace input roots or change confirmation generations, permissions or
filesystem operations.
Read-only modal source/target paths expose their unchanged full text in bounded
horizontal viewports. Wheel and focused Left/Right/Home/End scroll those details,
with a theme focus border, rather than adding spaces or claiming every renderer
automatically wraps a long path token.

The ordinary parent-owned `desktop/client/file-dialog.mjs` chooser uses this
dialog surface only with `optInTheme: true`, through its existing subscription.
Without opt-in it retains its explicit neutral palette, radius 6, padding 14,
gap 10 and 800-by-640 maximum panel, with no decoration layer or subscription.
Opt-in path/error details use the same existing horizontal scroll primitive;
ordinary message words still wrap, while an unbroken token remains fully reachable.
This is application-panel consistency, not original-OS screenshot matching.

Rows show name, type, file size and a local-calendar modification date. Properties
retains the full name/path, exact timestamp, permission mode, UID/GID, link target
and actual effective-UID read/write accessibility. Long row labels are clipped,
not replaced with an invented shortened path; Properties exposes the full value.
Empty, no filter matches, loading and permission-denied
states differ. New folder offers the editable default `New folder` and creates mode 0700.
Rename shows the exact selected path and requires explicit confirmation;
it only changes a name within that directory and never replaces a destination.
Selection and directory observation identities travel with the operation.
UI epochs also advance when selecting a row or opening/cancelling a dialog:
distinct hard-link names with equal inode metadata do not share actionable
retained callbacks, and a retired confirmation cannot confirm a new dialog.
Refresh, navigation, close and stale callbacks cannot operate on a different
selected entry. Reopening uses a new app/controller instance.

**Cut / Paste** moves one owned, non-set-ID regular file, including binary files.
Use the command bar/context menu or Ctrl+X and Ctrl+V outside text fields.
The cut observation is local to this Files window, not a system clipboard
format; navigation retains it and closing discards it without moving anything.
Paste shows the exact source and destination directory, permits editing the
destination name and requires **Move file** confirmation. Cancel dismisses that
review without a filesystem action; **Cancel cut** also clears the retained intent.
There is no implicit copy or cross-filesystem copy/delete fallback.
The real JS service uses `renameat2(RENAME_NOREPLACE)`: an existing file, hard link
or symlink destination is never overwritten. Both directory observations and
the selected source identity must still match. A changed source/parent requires
a fresh Cut after review; Files never silently updates the old intent. EXDEV,
permission, read-only, stale and collision errors are visible and clear the cut
intent, with no replay. A post-move observation/close failure reports
`committed:true` and asks the user to refresh/inspect. This changes only the
selected pathname, not its hard-link aliases, and claims no power-loss durability.
Folders, symbolic links, special files and managed package contents are excluded.
An older runtime without `moveFile:true` and `move()` leaves these controls unavailable.

Symbolic links are labelled with their literal target and target type/error.
Open asks explicitly before following a link. The link and target observations
are checked again; browsing then uses the actual resolved directory path.
Linux's normal symlink traversal bound (40) applies; dangling links and loops
are visible errors. Renaming a user-owned link changes the link, not its target.
Read/save consumers must consciously resolve a selected link with `stat(true)`
and use its canonical target observation; writes never follow a final link.

Regular files use the existing `createApplicationLauncher`:
`documentApplications`, `openDocuments`, literal Exec argv or standard D-Bus
Open. Open With lists only discovered handlers. An unknown association or
unavailable utility/handler is an explicit error, with no arbitrary command
or shell fallback. A `.app` suffix is not executable authority: only an exact
path from the validated existing managed-application registry is presented and
launched as a managed application. Such packages cannot be renamed in Files.

## Stable shared contract

`desktop.fileSystem` has `version:1`, `implementation:'desktop-files-v1'`,
`maxEntries:1024`, `maxTextBytes:1048576`, `overwrite:true`,
`textObservation:'sha256-v1'`, plus the optional `moveFile:true` capability. The shared
`desktop/apps/files/logic/model.mjs` supplies `requireFileSystem`, `pathValue`,
`childPath`, `parentPath`, `fileEntry`, `textObservation`, `directorySnapshot` and `fileError`.
Missing, older or incompatible engines fail explicitly; there is no stub
catalog or Node filesystem backend.

All native calls are **synchronous** and either return a value or throw an
Error with `code`, `message` and `operation`. EACCES/EPERM/ENOENT/EEXIST/ESTALE/
EINVAL/EFBIG/ELOOP/ENOTDIR/ENAMETOOLONG/EILSEQ/ENOSPC/EROFS/ENOMEM/EXDEV are
distinguished; unlisted OS errors retain their number as `ERR_OS_<errno>`.
Invalid paths and text fail explicitly with EINVAL/EILSEQ/EFBIG; wrong argument
types/counts throw TypeError. All paths are absolute UTF-8, max 4095 bytes,
without empty, `.` or `..` components. New names are one component of
1-255 UTF-8 bytes. Path text never undergoes shell or URI reinterpretation.

```js
const fs = requireFileSystem(desktop);
fs.locations(); // {home, documents, downloads, desktop}; no enumeration
fs.listDirectory(path, null); // initial navigation
fs.listDirectory(path, observedDirectoryIdentity); // chosen folder
fs.stat(path, false); // final symlink stays a marked symlink
fs.stat(path, true); // consciously follow final link, canonical target entry
fs.readText(path, observedIdentity); // entry metadata + text
const replacement = textObservation(fs.observeText(path)); // explicit overwrite question
fs.createDirectory(parent, name, observedParentIdentity);
fs.rename(path, newName, observedIdentity, observedParentIdentity);
// Optional moveFile:true capability, independent of text size/encoding:
fs.move(path, destinationParent, newName, observedIdentity,
  observedSourceParentIdentity, observedDestinationParentIdentity);
fs.writeText(parent, name, text, observedParentIdentity); // NEW ONLY
fs.replaceText(path, text, replacement.identity, observedParentIdentity);
```

`listDirectory` returns `{version:1,path,identity,entries,complete}`. Path is
derived from the opened directory FD, not guessed from a string. Entries have
`name,path,type,identity,bytes,mtimeMs,permissions,uid,gid,readable,writable,
linkTarget,targetType,targetIdentity,targetError`. Type is directory/file/
symlink/other. A root stat entry has `name:'/'`. Identity is an opaque string
of dev/inode/mode/size/mtime/ctime with nanoseconds; consumers compare exact
equality. Directory read/write accessibility includes search (`X_OK`).
Individual-entry inspection failure or an observably changed directory aborts the snapshot
instead of omitting entries silently. Invalid UTF-8 names fail with EILSEQ.

Reads require an exact observed regular file, up to 1 MiB, valid UTF-8 without
NUL. Metadata is checked before and after reading. `readText` also accepts a
strong identity from `observeText` and verifies metadata and SHA256 before
returning that same strong identity. Metadata-only reads retain their original
observation semantics, not a promise of identical contents. New text writes stage a
mode-0600 same-directory private file, fsync contents, then atomically publish
with `linkat` no-clobber. Existing destinations, including links, always produce
EEXIST. The temporary file is removed; no scripts or elevated helper run.

`replaceText` is separate and **must only be called after the user's explicit
confirmation of the exact observed existing regular file**. First call
`observeText(path)`: it returns the ordinary entry fields, `metadataIdentity`
containing the original stat identity, and **`identity` containing a strong
`sha256:<full-stat-identity>:<64-hex-digest>` token**, at most 255 characters.
Only this explicit text operation reads and hashes up to 1 MiB; directory
listing and ordinary stat do not hash file contents. Unreadable, non-UTF-8,
NUL-containing, special, final-symbolic-link or oversized input fails explicitly.
Native code rejects
root/set-ID processes, non-owned/special/set-ID files and final symbolic links.
It checks real read/write permission using an untruncated `O_RDWR|O_NOFOLLOW` open,
stages and fsyncs text, preserves the ordinary rwx mode, and checks the exact
target metadata **and actual text digest** again immediately before atomic
same-directory rename. Metadata-only overwrite tokens produce EINVAL, never
a silent downgrade. This detects a same-size in-place content change even when
the filesystem reports identical mtime/ctime nanoseconds.
Missing, replaced or changed targets produce ESTALE. Consumers must refresh
both parent and target observations and obtain a new explicit confirmation;
they must not retry the old intent automatically.

Hard links are not rejected by ordinary stat/read or the text observer.
Atomic replacement changes only the explicitly selected pathname: another
hard-link name continues to reference the original inode and contents.
This is ordinary single-path atomic-save semantics, not an in-place update of
every alias. A dedicated disposable-fixture case checks that behavior.
Replacement preserves ordinary rwx bits, not custom ACLs, xattrs or every
metadata field; it publishes a new inode rather than editing the old inode.

This is a cooperating local-filesystem observation model, **not atomic inode
compare-and-swap**: an unrelated process can change a path between the final
check and rename. General stat/directory identities can still alias at
filesystem timestamp resolution; strong text observations additionally compare
current content SHA256 and do not have that metadata-only weakness.
Neither rename nor MIME launch promises protection from a continuously racing
external writer. There is no exchange/rollback trick or privileged broker.
Content fsync is not a claim of directory-entry durability across power loss.
Errors after confirmed publication include `committed:true`, including descriptor
cleanup or final-observation failures. Refresh and inspect instead of automatically
retrying; the text consumer never treats such an ESTALE as permission to resubmit.

Ordinary Linux permissions are enforced by the OS, not reimplemented ACLs.
Counts and bytes are bounded, but libc/local/FUSE I/O can block the UI; awaiting
the result does not move it into the background or establish a hard deadline.
The Files app does not expose copy, recursive/folder moves, delete/trash, global search,
network mounts, XDG portals
or binary editing. That is not a restriction on native SysRT binary I/O.
There is no real host HOME enumeration in agent fixtures.

## Focused evidence and integration fixture

`gui-textinput` and `gui-scrollbar` exercise the SDK using the explicitly
headless capture adapter; these are not native-input claims. Independent
`desktop-files-text`, `desktop-files-text-lifecycle` and `desktop-files-scrollbar`
flows each keep an independent 60-second CTest budget and use actual ordinary
UID/GID1000 Wayland input through the shared native driver, including same-batch
plain clicks, held outside-window dragging, keyboard selection/scrolling,
focus-loss cancellation, production control detach and WM close during capture.
The text flow edits via native clipboard shortcuts (no IME is running in that
fixture); committed text/preedit are covered by the existing SDK tests.
Each focused flow retains three actual app-buffer PNGs and raw input/close
receipts, source/runtime/driver hashes and private synthetic HOME. `--small`
uses 680px and interaction-only `--narrow` uses 640px; the old browser/details
journeys, business assertions and supervisor deadlines remain unchanged.

```sh
node --test desktop/apps/files/tests/files.mjs
cmake -S sysrt -B build/sysrt -G Ninja
cmake --build build/sysrt
ctest --test-dir build/sysrt --output-on-failure -R '^sysrt-files$'
```

The Node suite injects observations to check UI/controller actions, not native
filesystem or pixel behavior. `sysrt-files` executes both the native-mapping SDK
and desktop service with real OS calls in three independent QuickJS VMs.
C test oracles measure the
actual header layout/constants; they do not implement production filesystem
semantics. Native tests read/write binary files over 16 MiB, use exact offsets
beyond 4 GiB, enumerate over 1024 entries and exercise seek/truncate/delete
without imposing application quotas. Desktop tests check UI policy boundaries,
strong hashes, collisions, symbolic links, hard-link replacement, permissions, staged-file cleanup and descriptor
lifetime. One test-only enumeration hook retires an explicitly owned directory
after opening its real FD; ENOENT/ESTALE must not become empty success.
UID0 checks verify native calls still follow OS permissions while the desktop
service refuses them. Ordinary runs exercise only private `/tmp` data,
never a user's HOME. Use the pinned offline SDK and read-only source mount.

`desktop/tests/files-window-client.mjs` is the ordinary-window entry for the
parent's freshly rebuilt engine/real pointer driver. It requires the native
v1 capability, emits named real control bounds, and only uses an explicit
private fixture HOME. The parent controls actual pointer/wheel/key/WM-close
events using its shared driver; no second compositor/input protocol is added.
Native pixel/input acceptance remains separate from the source-only harnesses.

The optional `--drive` mode uses the Settings-owned test input driver, not JS
event dispatch: public same-client `FilesFixture.<seq>.click`, `wheel`, `key`
and `close` markers target only app ID `org.pollyui.files-window-fixture`,
title `Files`. Ordinary marker windows briefly take WM focus; the driver restores
it with a real pointer click on neutral padding. For an open context menu, the
app reports its actual laid-out padding point so restoration does not dismiss
the menu. F2/Enter/Escape/Backspace and modifier keycodes travel through the real
compositor/SDL input path, not product action callbacks.
The fixture creates the default folder, clicks the actual rename input's right
end and presses real Backspace to rename `New folder` to `New folde`; it checks
real input focus and the real resulting directory. Public markers await driver
ACK and never call product action callbacks. The actual close handler writes a
new-only private receipt; failure cleanup is not accepted as a WM-close result.

`files-window-shell.mjs` is the trusted fixture supervisor, invoked by the
shared driver as `DRIVER UI ABSOLUTE/files-window-shell.mjs files-window initial`.
It spawns the separate ordinary process, requires normal exit and the actual
action/close receipt, then emits the existing trusted `fixture-success` marker.
The registered `files-window.py` coordinator runs as actual UID1000 and creates
only a fresh private HOME, synthetic rows and a user MIME association. It checks
the separate helper's literal argv, cwd, ordinary UID and real document contents;
it does not inspect the host's HOME or applications. Source checks of this
coordinator are not proof that its new-engine run passed.
The parent must independently check the real MIME helper argv/output receipt;
the public client claims successful native MIME dispatch, not that an external
application rendered or consumed a document. Source syntax checks do not prove
the optional drive mode or new engine pixels/input.

Stage an ordinary-user `HOME/evidence` directory before starting the fixture.
The default `files-window.py` command runs two independent, self-contained flows,
each with a fresh private HOME, application, native supervisor, MIME consumer and
WM-close receipt. The browser flow captures Home, empty directory, scrolled list,
created folder, context menu, inline rename, renamed folder and before WM close.
The details flow captures long-name Properties, no matches and filtered rows.
Both flows verify the filter/address/keyboard selection and actual MIME dispatch.
Each retains the original 120-second native supervisor and 150-second wrapper
deadlines. The outer single-flow limit is 180 seconds; the default CTest envelope
is 360 seconds for both independent flows, rather than forcing every visual stage
and repeatedly initialized marker window into one 120-second session.

Native Ctrl+V pastes a synthetic filter through
the private Wayland clipboard (the isolated fixture has no input-method process);
this certifies keyboard paste/filter behavior, not IME character entry.
`files-window.py --small` repeats the real app at 680x540. Normal requested height
may be clamped by the compositor; PNG dimensions are compared to the actual
laid-out window, not an assumed 760px buffer. It records stage/state/path/bytes only after
that API succeeds and the real file exists. No captures occur after closing.
The supervisor verifies exact private paths and actual file sizes; the parent
must independently validate PNG headers/hashes and inspect stage contents.
These are presented app-buffer artifacts, not a compositor/host screenshot,
physical-GPU proof or a source-only claim that captures have already passed.
Capturing in the pre-staged child directory avoids modifying the browser's
root directory identity while creation/rename confirmations are pending.

`--flow browser` or `--flow details` selects a single independent flow for a
targeted regression; the default runs **both**, with no silent skip.
`aggregate.json` is written only after both current runs pass: required action
receipts, normal close, exact stage sets, PNG hashes, each flow's separate MIME
consumer result and fresh HOME must agree. Runtime, input-driver and source
hashes must match across flows. Each flow retains `inputs.json`, `native.log`,
`captures.json`, its close receipt and actual elapsed time. The eleven images
are attributed to their own flow, never assembled from historical failed runs.
`files-window-manifest.py` tests aggregation rejection using synthetic bytes;
it does not certify native input or rendering.
