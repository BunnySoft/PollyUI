# Files: ordinary-user browser and shared file API

Launch the standalone native application with:

```sh
pollyui --desktop --app-id org.pollyui.files desktop/files/main.mjs
pollyui --desktop --app-id org.pollyui.files desktop/files/main.mjs /absolute/local/folder
```

`--desktop` supplies the existing application/MIME and theme client APIs; this
window neither creates a Shell surface nor acquires trusted Shell management
authority. The installed launcher must use its installed absolute entry path.
Central integration adds `src/desktop/files.c` to the Linux engine sources and
calls `pu_files_install(ctx, desktop_api)` in `pu_applications_install`, outside
the `PU_LAYER_SHELL` block. Link the existing `PkgConfig::BUNDLE_CRYPTO`
dependency for OpenSSL EVP SHA256. No pump, background service or shutdown hook is needed.
Install the whole `desktop/files` module directory and its existing shared
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

Rows show real name, type, bytes, modification time, permission mode, UID and
actual effective-UID read/write accessibility. Empty and permission-denied
states differ. New folder asks for a single name and creates mode 0700.
Rename shows the exact selected path and requires explicit confirmation;
it only changes a name within that directory and never replaces a destination.
Selection and directory observation identities travel with the operation.
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

`desktop.fileSystem` has `version:1`, `implementation:'posix-ordinary-v1'`,
`maxEntries:1024`, `maxTextBytes:1048576`, `overwrite:true`,
`textObservation:'sha256-v1'`. The shared
`desktop/files/model.mjs` supplies `requireFileSystem`, `pathValue`,
`childPath`, `parentPath`, `fileEntry`, `textObservation`, `directorySnapshot` and `fileError`.
Missing, older or incompatible engines fail explicitly; there is no stub
catalog or Node filesystem backend.

All native calls are **synchronous** and either return a value or throw an
Error with `code`, `message` and `operation`. EACCES/EPERM/ENOENT/EEXIST/ESTALE/
EINVAL/EFBIG/ELOOP/ENOTDIR/ENAMETOOLONG/EILSEQ/ENOSPC/EROFS/ENOMEM are
distinguished; other OS failures use EIO. Argument type/NUL/size violations
throw TypeError/RangeError. All paths are absolute UTF-8, max 4095 bytes,
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
Individual-entry inspection failure or a changed directory aborts the snapshot
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
NUL-containing, special, linked or oversized input fails explicitly.
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

This is a cooperating local-filesystem observation model, **not atomic inode
compare-and-swap**: an unrelated process can change a path between the final
check and rename. General stat/directory identities can still alias at
filesystem timestamp resolution; strong text observations additionally compare
current content SHA256 and do not have that metadata-only weakness.
Neither rename nor MIME launch promises protection from a continuously racing
external writer. There is no exchange/rollback trick or privileged broker.
Content fsync is not a claim of directory-entry durability across power loss.
An error after publication may mean the operation already happened; refresh
and inspect instead of automatically retrying.

Ordinary Linux permissions are enforced by the OS, not reimplemented ACLs.
Counts and bytes are bounded, but libc/local/FUSE I/O can block the UI; awaiting
the result does not move it into the background or establish a hard deadline.
No copy/move/trash/search/network mount/XDG portal or arbitrary binary I/O is
implemented. There is no real host HOME enumeration in agent fixtures.

## Focused evidence and integration fixture

```sh
node --test desktop/files/tests.mjs
sh desktop/tests/files-native.sh
```

The first uses explicit injected observations to check UI/controller actions;
it is not native filesystem or pixel evidence. The second compiles only a
small C core harness and QuickJS binding harness from the current source and
executes real ordinary UID/GID 1000 operations in private `/tmp` fixtures.
Run in the pinned offline SDK with source read-only, not against a user's HOME.
The harness links existing `-lcrypto`. The in-place edit case samples at most
64 real writes for an observed identical-metadata alias, records full native
fields, rejects the old strong token and reads back a newly confirmed write.
It does not forge ctime or edit a user's files.
Fixture shell input must use LF line endings. The script prints actual source
and harness SHA256 hashes. It never builds the engine, image or VM.

`desktop/tests/files-window-client.mjs` is the ordinary-window entry for the
parent's freshly rebuilt engine/real pointer driver. It requires the native
v1 capability, emits named real control bounds, and only uses an explicit
private fixture HOME. The parent controls actual pointer/wheel/key/WM-close
events using its shared driver; no second compositor/input protocol is added.
Native pixel/input acceptance remains separate from the source-only harnesses.
