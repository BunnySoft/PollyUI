# Ordinary application open/save chooser

`desktop/client/file-dialog.mjs` provides an in-parent PollyUI modal, using the
single shared `desktop.fileSystem` ordinary-user backend and
`desktop/apps/files/logic/model.mjs`. It does not implement filesystem access, use a Shell
surface, launch files, or provide a third-party Portal. A missing/old native API
produces a visible error with Cancel available; it never returns a demo path.

## Consumer invocation

Run from the repository root with a desktop-enabled Linux runtime:

```sh
pollyui --desktop desktop/examples/file-dialog.mjs /absolute/private/directory
# Optional desktop color subscription:
pollyui --desktop desktop/examples/file-dialog.mjs /absolute/private/directory --theme
# Read one literal local document, such as a launcher's --file %f argument:
pollyui --desktop desktop/examples/file-dialog.mjs --file '/absolute/private/document with spaces.txt'
```

The example actually reads the selected file. Its separate single-line text
field supplies at most 4096 UTF-8 bytes for saving. Save-new uses native
`writeText`; confirmed replacement uses native `replaceText`. Only after the
write and matching native readback does it display "Saved and read back".
An error after writing says the write completed but readback failed, rather than
claiming nothing was written. This example is not a full document editor.

The entry accepts one positional initial directory and optional `--theme` as
before. `--file LOCALPATH` explicitly names one absolute local file; spaces,
quotes and Unicode remain one literal argv value. A bare file path is still
treated as the legacy directory argument, so document launchers must supply
`--file %f`, not an unmarked `%f` or a `file://` URI. Unknown flags, duplicate
file options, missing file values and multiple positional directories reject.
This entry does not register MIME associations or change user defaults.

`createFileTextApp({ initialFile: localPath })` starts a real named-file read
after creating its ordinary window. Its public `openPath(localPath)` performs
the same operation on an already-started app. Both call native `observeText`,
validate the strong text observation, and call `readText` with its canonical
path and exact strong identity. They display only the matching actual text,
report missing/stale/incompatible reads explicitly, and do not open a chooser
as a substitute for consuming the document. Busy/generation/close guards are
shared with ordinary Open; a closed app cannot dispatch a late read or repaint
a late success/failure. No initial read writes anything or populates the
separate bounded text-to-write field with a full document.
Named-file loading follows the shared `observeText` regular-file policy:
bounded readable UTF-8 text up to 1 MiB without NUL, with no automatic final
symbolic-link traversal. Unsupported files produce visible backend errors.

For another ordinary PollyUI application:

```js
import { showFileDialog } from './desktop/client/file-dialog.mjs';
import { requireFileSystem } from './desktop/apps/files/logic/model.mjs';

const files = requireFileSystem(desktop);
const picker = showFileDialog({
  parent: window, files,
  settings: {
    mode: 'open',
    initialDirectory: '/home/polly/Documents',
    filters: [
      { label: 'Text', extensions: ['txt', 'md'] },
      { label: 'All files', extensions: [] },
    ],
  },
});
const choice = await picker.result;
if (choice.status === 'selected') {
  // The chooser selected a path; this native call actually reads its content.
  const document = files.readText(choice.path, choice.identity);
  console.log(document.text);
}
```

Use the same `showFileDialog` with `mode: 'save'`, `suggestedName: 'note.txt'`,
and optionally `defaultExtension: 'txt'`. It returns checked selection intent,
**not a write or a guarantee that a later operation can still succeed**:

| Result | Fields |
| --- | --- |
| Open selection | `status: 'selected'`, `mode: 'open'`, canonical `path`, opaque `identity`, original explicitly chosen `selectedPath` |
| New save target | `status: 'selected'`, `mode: 'save'`, `path`, `parentPath`, `parentIdentity`, `name`, `expectedIdentity: null`, `overwrite: false` |
| Confirmed existing target | Same save fields, `expectedIdentity` from fresh bounded native SHA256 text observation, `overwrite: true` |
| Cancel / disposal / parent close | `status: 'cancelled'`, `reason`; no selected path |

After receiving a save result, the consumer must use its observations:

```js
const written = choice.overwrite
  ? files.replaceText(choice.path, text, choice.expectedIdentity, choice.parentIdentity)
  : files.writeText(choice.parentPath, choice.name, text, choice.parentIdentity);
// No unconditional write, and no automatic replacement retry on ESTALE.
const readback = files.readText(written.path, written.identity);
```

The actual example catches replacement `ESTALE`, reopens the real chooser with
a visible changed-file notice, and requires choosing the target and explicitly
confirming the fresh observation again. It does not automatically retry a write.
Other consumers must similarly surface backend errors and obtain renewed consent.
No result is an OS permission grant, sandbox token, open FD, or durable write
receipt. Normal permissions and final native revalidation remain authoritative.
The native ABI uses exact argument counts: `locations()`,
`listDirectory(path, expectedDirectoryIdentityOrNull)`, `stat(path, followLinks)`,
`observeText(path)`, `readText(path, expectedIdentity)`, and the four-argument
`writeText` / `replaceText` calls above. Initial, typed and Refresh navigation
pass an explicit `null`, not an omitted second argument. Explicitly activated
folders pass their freshly observed directory identity. Injected tests enforce
these counts; JavaScript default-argument behavior is not the native contract.

## Inputs, interaction and lifetime

`settings` accepts only `mode`, `initialDirectory`, `suggestedName`,
`defaultExtension`, and `filters`; unknown options throw. Mode defaults to
`open`. Initial directory defaults to the backend's actual HOME. Directory
paths and filenames use shared validation: absolute local paths up to 4095
UTF-8 bytes, one-component filenames up to 255 bytes, no NUL, empty/dot/parent
path components. Spaces, Unicode and quotes remain literal names, never shell
commands. Extension strings omit the dot and contain 1-16 ASCII letters/digits.
There are 1-8 labeled filters, with at most 16 extensions each. An empty
extension list means all files. Matching ignores case. Save adds the default
extension only to a nonempty name containing no dot; a mismatching suffix is
reported instead of silently changed.

Home, Up, breadcrumbs, editable Location + Enter, Refresh, explicit file
selection, extension filters, and Save's filename field use actual directory
observations. The UI pages 64 rows at a time from the backend's 1024-entry bound.
`complete: false` is visibly disclosed; a partial list does not pretend to contain
all entries. There is no implicit default selection or multi-select in this
first single-document interface. Folder selection plus Open navigates; it
does not return a folder as a document. A `.app` directory is likewise navigation,
not generic execution or an implicit document launch.

Marked symbolic links require explicit selection and validation of both link
and canonical target. Open returns a readable regular target's canonical path;
the consumer's identity-checked read remains necessary. Save does not replace
final links, directories or special files. Legitimate ancestor paths/mounts are
resolved by the shared backend, not rejected by a second chooser policy.
The chooser does not infer MIME types or modify default applications; existing
document/MIME/Open/FD/timeout contracts are unchanged.

Buttons support Enter/Space, Location and filename support Enter, Tab/Shift+Tab
stay within the modal, and Escape cancels. Existing-file questions default focus
to **Keep existing file**, display the exact path, opaque observation and content
replacement consequence, and never use Enter as implicit overwrite consent.
Changes to either file or parent observation require a fresh question and
another explicit confirmation. Stale callbacks and late Promise completions
cannot complete an edited selection, cancelled dialog or closed parent.
During directory acquisition, filter and filename edits are disabled and their
controller actions cannot invalidate the pending load. Location remains
available to explicitly start a replacement navigation once home metadata is
known. Edits during selected-target validation deliberately invalidate that
validation and return to ready; they do not strand the directory acquisition.

One chooser may own a parent at a time. Its `dispose()` cancels and removes the
modal; parent `onclose` is chained/restored without taking Shell capabilities.
On cancellation/selection it releases theme subscriptions and restores the
previous live focus node. Consumers should still dispose their app on close and
not replace its close handler while a modal is active. `optInTheme: true` only
subscribes to bounded component color cues; theme failures are visible.
Picker cancellation prevents dispatching a write. Closing an app after it
already dispatched a native write cannot retract that operation; the example
does not claim that close rolls back an already committed file.

Filesystem errors are displayed and logged. The controller accepts synchronous
or Promise-returning shared calls, has visible loading/checking phases and
generation invalidation, but **the current native backend calls are synchronous**:
this frontend does not convert a slow OS/FUSE operation into background I/O.
It does not claim a cancellable worker service or unbounded-directory performance.
Native text use is limited to 1 MiB valid UTF-8 without NUL; selecting a binary
file does not imply that `readText` can decode it.

Conditional replacement belongs to the backend's cooperating local ordinary-user
model. It stages and checks the latest observations, rejects detected changes
without publishing replacement, and retains the residual check-to-rename race
with uncooperative concurrent writers. It is **not an atomic filename CAS against
malicious same-UID or privileged changes**. No root password, disk/format API,
network mount setup, administrator policy or Portal broker is added here.
Browse/Open/directory observations remain metadata-only. Existing text-save
preparation requires `textObservation: 'sha256-v1'` and native `observeText(path)`.
Its entry has an opaque strong `.identity` and the original `.metadataIdentity`;
the shared `textObservation` validator checks the bounded receipt. The chooser
observes this identity again at explicit confirmation, and the consumer passes
it unchanged to native `replaceText`. The backend rechecks the digest, rejecting
metadata-identical changed content, not just detecting a new inode or timestamp.
Metadata-only replacement tokens and missing strong-observation APIs are
refused, never fallback inputs. Readable regular UTF-8 text up to 1 MiB without
NUL is the explicit existing-file replacement scope; directories/listings are
not hashed wholesale. All hashing stays in the one native backend; frontend
code neither invents file receipts nor implements content hashing.

## Focused verification and evidence boundary

The installed `polly-file-text` launcher resolves the installed data root and
starts the ordinary FS-only application without `--desktop`. Its visible Apps
entry has no document arguments. A separate `NoDisplay=true` document entry uses
the absolute `/usr/bin/polly-file-text --file %f` command; document discovery
includes that hidden handler while the Apps catalog omits it. Product
data-directory defaults cover only `text/plain` and `text/markdown`; existing
user XDG defaults retain precedence. Installation never rewrites user MIME
preferences. These source assets still need actual installed-launcher/native
content-display acceptance; injected startup tests are not that proof.

```sh
node --test desktop/tests/file-dialog.mjs
# Narrow literal-file entry/consumer delta:
node --test desktop/tests/file-text-open.mjs
node --check desktop/tests/file-dialog-native.mjs
node --check desktop/tests/file-dialog-native-fixture.mjs
node --check desktop/tests/file-dialog-window.mjs
node --check desktop/tests/file-dialog-window-shell.mjs
node --check desktop/tests/file-dialog-mutation.mjs
```

The Node suite injects private in-memory filesystem observations and a bounded
DOM/window mock. It runs the real reconciler and text-input code, covering
navigation, keyboard/pointer handlers, Unicode names, disabled actions, cancel,
modal focus/lifecycle, list bounds, changed observations, consumer read/write
invocations, replacement `ESTALE` reconsent and honest failed readback. It is
**not product native filesystem or compositor input evidence**.

Inside an already-running **private test Wayland session**, with newly compiled
desktop-enabled PollyUI and Node, as ordinary Linux UID1000:

```sh
PU_RENDERER=raster node desktop/tests/file-dialog-native-fixture.mjs \
  /absolute/newly-built/pollyui /absolute/private/evidence
```

This runner creates only a named private Linux temporary fixture, rejects
UID0/old binaries/JS filesystem stubs, and retains logs, fixture paths, a runtime
hash receipt and seven actual window PNGs. Its ordinary app performs real native
listing, selection/cancellation, selected-content read, new text write/readback,
cancelled existing-file confirmation, an external native replacement followed
by required fresh confirmation, actual replacement/readback and parent close.
An additional private eight-byte document is changed in place by the Node
fixture producer. It preserves the inode and size, does not forge timestamps,
records full before/after metadata, and requires renewed strong observation
and a second explicit confirmation before the consumer replaces it.
The runner independently verifies both final files and every PNG. It uses
programmatic controller actions: **real compositor pointer/key delivery still
requires the parent's ordinary-window injector**, not the Node handler mocks.
No full build, image rebuild, real user document, shared native volume or
physical GPU qualification is part of this child fixture.

The source-owned ordinary-window input selector uses the Settings workstream's
single `runtime-client.c` fixture extension; it does not introduce another
compositor or a production input protocol. After the parent builds that exact
combined source, under the private fixture's ordinary UID1000 environment:

```sh
pollyui-layer-client-test /absolute/newly-built/pollyui \
  /absolute/repo/desktop/tests/file-dialog-window-shell.mjs file-dialog file-dialog
```

The Shell supervisor starts the same private Node runner with `--window-input`.
It supplies a private HOME, 96 fixture rows, a separate public app with
`org.pollyui.file-dialog-window` / `PollyUI.FileText`, and eight actual app-buffer
PNGs. Public control windows use
`FileDialogFixture.<sequence>.click x y`, `.wheel x y deltaY`,
`.key enter|escape|tab|shift-tab`, or `.close`.
The app waits for each real marker `onclose` ACK, inspects current DOM/state,
checks native Tab/Shift+Tab focus, and verifies real content after native
pointer selection, Enter/Escape, new save and fresh replacement confirmation.
The C owner qualifies the same public client, hides markers, safely focuses
the approved non-action point `(10, 10)`, fresh-lookups the owner and executes
one business action; it does not double-click a confirmation button.
The Node runner checks positive product log markers, no failure marker, both
final files, all PNGs and the native-written input receipt before exiting zero.
Only then does the supervisor send the existing trusted `fixture-success`.
Actual keyboard/compositor acceptance is **pending** until this new selector
runs; neither source registration nor old layer-input evidence substitutes.
`in-place.json` records actual dev/inode/mode/size/mtime-ns/ctime-ns and whether
those fields truly matched; `FILE_DIALOG_NATIVE_METADATA_MATCH` additionally
reports the actual native metadata-token comparison. A GUI handshake normally
crosses a timestamp tick, so this fixture does not fabricate all-field equality.
The filesystem owner's separate ordinary native/QuickJS regression owns the
precise same-metadata alias proof; injected UI observations establish only the
receipt-comparison/reconsent behavior, not OS-level detection.

Parent integration must register the focused Node selector/native fixture,
package the client modules plus the single owner's `desktop/apps/files/logic/model.mjs`
and backend, and choose an application entry for the example. Those central
build/package/Shell files are deliberately not changed by this workstream.
Native acceptance remains pending until that exact combined source is rebuilt
and its ordinary-user filesystem/window/input flows run successfully.
