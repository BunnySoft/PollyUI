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
`sysrt/sdk/js/files.mjs` implements filesystem semantics over the declarative
libc/libcrypto signatures and Linux LP64 layouts in `sysrt/bindings/files.mjs`.
Profiles cover glibc LP64 and packaged musl x86_64; unsupported symbols/ABIs
fail explicitly. Musl enumeration uses its real `getdents` symbol and int result,
not glibc's `getdents64`/ssize declaration.
There is no C filesystem provider or QuickJS filesystem projection. Applications
may import `fileSystem` directly; `desktop/launcher/services.mjs` also assembles
it as `desktop.fileSystem` before the application entry. The generic GUI prelude
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
snapshots. There is no preselected entry. Select a row, then Open selected, or
double-click it. Arrow keys select entries; Enter opens, F2 begins rename,
F5 refreshes, Alt+Left/Right navigate history and Escape dismisses confirmation.
Lists have 64-row pages with native wheel scrolling. A directory containing
more than 1024 entries is explicitly **partial**, never presented as complete.
The bounded file-list viewport uses the engine's explicit `flexGrow` and
`flexBasis` properties, not unsupported CSS `flex` shorthand. Rows overflow
inside that viewport; the page controls stay below it within the window.

Rows show real name, type, bytes, modification time, permission mode, UID and
actual effective-UID read/write accessibility. Empty and permission-denied
states differ. New folder offers the editable default `New folder` and creates mode 0700.
Rename shows the exact selected path and requires explicit confirmation;
it only changes a name within that directory and never replaces a destination.
Selection and directory observation identities travel with the operation.
UI epochs also advance when selecting a row or opening/cancelling a dialog:
distinct hard-link names with equal inode metadata do not share actionable
retained callbacks, and a retired confirmation cannot confirm a new dialog.
Refresh, navigation, close and stale callbacks cannot operate on a different
selected entry. Reopening uses a new app/controller instance.

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

`desktop.fileSystem` has `version:1`, `implementation:'linux-ffi-v1'`,
`maxEntries:1024`, `maxTextBytes:1048576`, `overwrite:true`,
`textObservation:'sha256-v1'`. The shared
`desktop/apps/files/logic/model.mjs` supplies `requireFileSystem`, `pathValue`,
`childPath`, `parentPath`, `fileEntry`, `textObservation`, `directorySnapshot` and `fileError`.
Missing, older or incompatible engines fail explicitly; there is no stub
catalog or Node filesystem backend.

All native calls are **synchronous** and either return a value or throw an
Error with `code`, `message` and `operation`. EACCES/EPERM/ENOENT/EEXIST/ESTALE/
EINVAL/EFBIG/ELOOP/ENOTDIR/ENAMETOOLONG/EILSEQ/ENOSPC/EROFS/ENOMEM are
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
No copy/move/trash/search/network mount/XDG portal or arbitrary binary I/O is
implemented. There is no real host HOME enumeration in agent fixtures.

## Focused evidence and integration fixture

```sh
node --test desktop/apps/files/tests/files.mjs
cmake -S sysrt -B build/sysrt -G Ninja
cmake --build build/sysrt
ctest --test-dir build/sysrt --output-on-failure -R '^sysrt-files$'
```

The Node suite injects observations to check UI/controller actions, not native
filesystem or pixel behavior. `sysrt-files` executes the production JS SDK and
real OS calls in three independent QuickJS VMs. C test oracles measure the
actual header layout/constants; they do not implement production filesystem
semantics. The fixture checks boundaries, strong hashes, collisions, symbolic
links, hard-link replacement, permissions, staged-file cleanup and descriptor
lifetime. One test-only enumeration hook retires an explicitly owned directory
after opening its real FD; ENOENT/ESTALE must not become empty success.
UID0 checks verify refusal; ordinary runs exercise only private `/tmp` data,
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
title `Files`. `[6,6]` is neutral root padding under every inline confirmation.
Only Enter/Escape/Tab/Shift+Tab and the Files-specific Backspace key are needed.
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
The drive captures six named PNGs there using the current live app window's
native `capture(path)` API: Home, scrolled list, created folder, rename edit,
renamed folder and before WM close. It records stage/state/path/bytes only after
that API succeeds and the real file exists. No captures occur after closing.
The supervisor verifies exact private paths and actual file sizes; the parent
must independently validate PNG headers/hashes and inspect stage contents.
These are presented app-buffer artifacts, not a compositor/host screenshot,
physical-GPU proof or a source-only claim that captures have already passed.
Capturing in the pre-staged child directory avoids modifying the browser's
root directory identity while creation/rename confirmations are pending.
