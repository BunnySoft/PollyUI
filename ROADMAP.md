# PollyUI — Feature Matrix & Roadmap

One view of what's built and what's planned. For the architecture, see
[DESIGN.md](./DESIGN.md); §10 there has the prose version of this.

**Status legend**

| | Meaning |
|---|---|
| ✅ | Implemented (committed, with a demo and/or headless test) |
| 🟡 | Partial — works, but a subset of the full feature |
| 🛠 | Planned |
| ⏸ | Deferred (deliberately not doing now) |

Platform column: **Win** = Windows. Windows and macOS hosts are available;
Linux has an experimental SDL3 EGL/GLES/raster path with Fontconfig fonts and a native
Alpine/musl build, libcurl HTTP and XDG app data. Native Rime and complex Linux
text are implemented; detailed GPU qualification, advanced IME/text extensions
and the macOS HTTP backend remain separate.
See README and `desktop/README.md` for current platform boundaries.

**Latest user-reported physical acceptance:** Debian 13 trixie amd64 alpha.8,
frozen runtime `a357a7d`, ISO SHA-256
`07e1fe3292275a577ff20d9d44d62d4d5981c4d6b312d1cc828ad8d14eeeadb4`.
On 2026-10-11 the user reported that actual testing passed. Per-device, feature
and endurance measurements were not specified. This feedback does not turn the
recorded baseline-only VM checks into complete automation acceptance or resolve
the retained native-mouse/Alpha.7 failures. Alpha.6's earlier complete VM and
user-reported physical acceptance remain separate historical evidence.
Keep the Alpine fallback and do
not turn all future features into current release gates.
See [base selection and maintenance](./docs/desktop-base-maintenance.md).

## New-architecture Alpha delivery gate

The current goal is a **Debian 13 x86_64 UEFI Live test Alpha**, not an
installer or a complete migration of every native desktop service.
`0.1.0-alpha.6` freezes the integrated runtime/configuration and packaging
preflight changes for a fresh build and VM testing. Existing alpha.5-r2 images and their evidence
remain historical; they do not contain or qualify the new SysRT/Settings work.

| Gate | Required outcome | Current state |
|---|---|---|
| Runtime freeze | Integrated SysRT, JS files/theme resources, independent Appearance/About Settings and Shell JSON preferences; explicit known limits | Clean `c9b1fcd706ccf4770209d7648c2606c7d5d46d4e`; idle/document rendering fixes integrated |
| Runtime package | Rebuild/install that revision, verify SDK/generated ABI/app resources, runtime dependencies and checksums from a relocated package | Fresh Release package, frozen-source checks, 157 payload files and 240 exact dependency pins passed |
| Virtual machine | Real UEFI guest boot, ordinary-user desktop, input/windows/Files, independent Settings and configuration behavior; preserve failures and logs | Complete normal OVMF/KVM run passed: Chinese input, clipboard, workspaces, Files/JSON and independent Settings select/reload/user theme/restore/About/close/reopen |
| Physical-test ISO | Produce/check the release ISO for the same revision; boot-test the actual media and record its SHA-256 before handoff | Published unchanged optical ISO in `dist\pollydesktop-0.1.0-alpha.6-debian13-c9b1fcd-physical-test\`; all 15 artifact checksums verified. ISO SHA-256 `9f34b85523bbfcb3ec8d4ed022fa1c21da380ada6cb7ed10a8b90722dcf2753b`; no hardware-pass claim |
| Physical acceptance | User tests the delivered Alpha on the target machine and reports results | User reported physical-machine testing passed on 2026-10-11; detailed per-device/function/endurance coverage was not supplied, so no broader qualification is inferred |

Use the existing QEMU/OVMF lane; temporary VM boot media is a test candidate,
not physical-release approval. Only one heavy media/VM lane runs against the
frozen revision. Do not overwrite historical artifacts or silently use cached
old runtime binaries. Live runs from RAM: no installation, automatic disk
mounting or internal-disk writes. Other Settings pages, broad SDK coverage,
installed-system storage/recovery and exhaustive hardware matrices are not
added to this Alpha's scope.

The successful VM used 4 GiB RAM, two vCPUs, virtio-vga and no NIC, host audio,
shared host directory or extra writable disk. QMP quit is not guest power-off
acceptance. The RAM-only fixture's ttyS0 login attempted a second seatless desktop
and failed before returning to its CLI; that raw error remains recorded separately
from the stable main seat0 desktop. Neither serial-login GUI behavior nor physical
GPU/network/audio was qualified by that VM run. The later user-reported physical
test pass does not supply a detailed device matrix. Earlier failed candidates and diagnostics remain
preserved; the successful run uses harness `e32ecd6` with no skipped normal gates.

For PollyOS, use the [technical overview](./docs/POLLYOS.md) and the
**[historical deferred-work ledger](./docs/POLLYOS-BACKLOG.md)**. The ledger maps
the original 45 desktop milestones, theme/release review and second-stage A–G
to explicit remaining subitems, decisions and subsequently completed work.
This file also contains broader PollyUI framework work, which is not automatically
a PollyOS release requirement.

## Alpha.8 rabbit cursor candidate

The user requested a committed/pushed rabbit cursor release and a new ISO.
The selected delivery mode permits an explicitly unqualified candidate; it does
not turn the previous Alpha.7 failures into acceptance or authorize overwriting
old images. `desktop/VERSION` freezes `0.1.0-alpha.8` in this revision.

| Gate | Required outcome | State |
|---|---|---|
| Source and remote | Integrated rabbit cursor, clean Alpha.8 version freeze, push and verify remote identity | Frozen/pushed `a357a7dce3b1da11c5881ab354912c6e18159a9a`, version `0.1.0-alpha.8`; rabbit implementation `36b7e4b` included |
| Runtime and assets | Fresh clean-source build; installed rabbit/precision cursor hashes, runtime dependencies and actual Alpha.8 build identity | Actual private clean Git Release build, compiled version/full revision/false dirty, frozen package and 12 core native checks passed; 240 pins compared anew; all 75 Xcursor files and two theme indexes verified. Extra first-build native-mouse check failed, unresolved and not rerun |
| ISO candidate | New Debian 13 x86_64 UEFI RAM-only image, actual payload checks and unchanged-copy checksum | Published `dist\pollydesktop-0.1.0-alpha.8-debian13-a357a7d-candidate\`; 707868672 bytes, SHA-256 `07e1fe3292275a577ff20d9d44d62d4d5981c4d6b312d1cc828ad8d14eeeadb4`; actual ISO verified 246 runtime/overlay files plus origin, including cursors. Separate producer `d2a41b59f7ee0ac77529dc10e426923b00015018` |
| Acceptance label | Record actual boot checks and any failures; prominently identify missing complete VM/hardware qualification | One ordinary optical OVMF/KVM boot/IME/clipboard/workspace baseline passed; complete VM and physical qualification remain false. Candidate warning/status, first native-mouse failure, export failures and missing first private HOME are explicit; no full Settings/Files matrix rerun |
| Physical feedback | User exercises the delivered candidate on their machine | User reported actual testing passed on 2026-10-11. Scope/hardware details were not supplied; retain original candidate receipts and failed automation evidence unchanged |

The earlier user-requested WSLg preview exited independently; do not restart it
or confuse it with the new media. Preserve its archive and all previous ISO bytes.
No materials, file-operation expansion or cursor upload/editor is included.

## Native GUI contract workstreams

The user selected native window ownership, application popup/modal relations
and size constraints as the next implementation on 2026-10-11. Work uses
isolated child sessions: non-conflicting changes may run in parallel; work
sharing Host/Bridge files first performs read-only research and waits for the
active increment to be integrated before writing those files.

| Workstream | Current assignment | Boundary |
|---|---|---|
| Native windows | Integrated `89da564` from coherent child commit `d6f8696`: owned windows, native menu/tooltip popups, owner-local modality, logical size constraints and actual state notifications | Normal owner closure requests descendants leaf-first; a veto/Promise preserves waiting owners, without restoring closed siblings or automatic retry. Explicit quit retains forced semantics with leaf-first native teardown |
| Outgoing native drag | Integrated `2ef182f` from coherent child commit `c2cb1b0`: common GUI C/JS contract and first Wayland COPY backend; public-interface coexistence requires no SDK changes | Ordinary-window COPY with immutable text/binary payloads, opaque native press credentials, cancellation and UI-thread completion. Dedicated source queue/worker and post-SDL-pump passive mirror cleanup; no MOVE, custom icon, Shell-layer origin or Files mutations |
| Windows outgoing drag | Explicitly deferred | Future OLE backend implements the same GUI contract; no separate application API or PollyOS service is needed. Windows build compatibility does not imply native outgoing-drag support |
| Native IME extensions | Read-only research completed; explicitly deferred to Beta by the user on 2026-10-12 | No implementation or transport spike in this round. Existing Rime preedit/candidate/commit stays unchanged. Reopening requires a single native input owner or separately authorized SDK extension, accurate Unicode/selection transactions and sensitive-field isolation |
| Ordinary-window transparency (MT-01) | Wayland integrated in `dd40d03`; Windows implementation preserved in child `dca78a0`, not integrated pending user-run composed-output acceptance | Windows capture returned `E_ACCESSDENIED`; native-window contracts are not composed-pixel proof. User chose interactive own-fixture verification before deciding integration. Whole MT-01 remains incomplete |
| Desktop icons and selection (BD-04/BD-05) | Integrated `cbe4000` and `0881e09`, including selected-only layout ownership | JS App shortcuts, internal arrangement/persistence and captured marquee/multi-selection. No shared Host/render writes, file mutations, uninstall or cross-application Shell dragging |

Desktop shortcuts start empty and are added from Polly > Applications. Ctrl/Shift,
marquee, grid movement, keyboard focus and focused-only Enter use the documented
Linux/Windows desktop convention. Configuration v2 atomically migrates v1 while
preserving all existing preference domains; untouched disconnected-display pins
keep their saved home. Native mainline and relocated installed-runtime flows
were independently exercised, including input/capture/lock/output retirement,
actual fixture-app launching, persistence, bitmap ownership and numeric marquee
blending. Installed product modules matched Git hashes with the source Shell
directory hidden; test-only harness modules were supplied separately.

The original `native-shell.mjs` synthetic context-menu fixture still fails before
Shell construction on both the old and new sources because it omits a held
secondary-button press. That qualification gap is retained, not called a new
desktop regression or an all-legacy pass. Physical monitor/hotplug matrices,
Windows desktop replacement and icon-name theme resolution are not qualified.

The [cross-platform drag design](./DESIGN.md#54-cross-platform-native-drag-and-drop)
separates application payload policy, the shared GUI session/credential/lifetime
contract and OS-specific Host implementations. Windows OLE, macOS and X11 are
not part of the currently approved Wayland implementation.

The integrated drag increment independently passed ten Windows and ten fresh
Linux mainline checks. The Linux drag fixture executed all 27 native scenarios,
including real JS initiation, native/SDL/self reception, byte-exact typed views,
17-MiB transfer, backpressure, credential rejection, GC/owner closure and
seat/connection loss; the GC receipt confirmed the returned Promise settled
as cancellation. Windows checked the common contract, explicit unsupported
behavior and existing window/input lifetimes, not OLE interoperability.
Original child artifacts and 147 compiled-source blob receipts were verified;
its 27-case ASan/UBSan run kept leak detection off and prebuilt SDK libraries
uninstrumented. Qualification remains limited to the pinned SDL 3.4.10 /
wlroots 0.19.3 PollyWM stack, not all compositors or platforms.

Independent mainline integration checks passed seven Windows native/GUI cases
and six fresh Linux GUI/compositor cases, including actual Wayland roles,
fractional-scale geometry, modal seat input, close lifetimes and the existing
input, document-paint, desktop-integration and lock regressions. Original child
source/artifact hashes were verified without rewriting receipts.

Popups are ungrabbed: explicit popup grabs are unsupported, and Wayland
outside-click dismissal is not promised. The focused child ASan/UBSan run
disabled leak detection and did not instrument prebuilt dependencies.
Physical GPU, Windows ANGLE, macOS and X11 runtime qualification remain outside
this increment.

GUI automation and system accessibility implementation are not started by
these workstreams. Materials remain a separate candidate. This work does not
change the delivered Alpha.8 ISO, version freeze or its original receipts.

## Alpha.7 Files interaction and physical-test candidate

The user requested a new physical-test ISO after a small Files interaction
polish. The selected scope is captured text drag-selection, a genuinely
draggable list scrollbar, and keyboard/focus feedback. No new file operations,
multi-selection, outgoing drag-and-drop or custom animated cursors are included.
The native mouse mechanisms and Files/SDK polish are integrated. The source
version is frozen as `0.1.0-alpha.7`. Fresh package/media content checks passed,
but full VM acceptance is blocked. The user explicitly chose the unqualified
candidate for their own physical-machine testing; this is not an accepted release.

| Gate | Required outcome | State |
|---|---|---|
| Files polish | Real drag-selection and scrollbar input, cancellation/lifetime and keyboard/focus behavior, with existing file operation semantics preserved | Integrated `f49dffd`: eight native journeys / 29 PNGs at normal/narrow sizes; parent verified original hashes/EOL-only source differences and Windows/Linux integration. Paired-click/cancellation fixture corrections `592895f` also passed |
| Runtime freeze | Integrate the qualified changes, set `desktop/VERSION` to `0.1.0-alpha.7`, and record the clean source revision | Version freeze in this revision; the media producer must clone its exact clean Git commit and preserve that full SHA in runtime/package/ISO provenance |
| Package and media | Fresh frozen build, install/dependency/provenance checks and a new Debian 13 x86_64 UEFI RAM-only ISO | Clean runtime `31da563`, native package checks and 167 runtime/overlay ISO files verified; ISO SHA-256 `25a031343d84850bd738ea8a1f0a07342abe797effb3253d68869891fb7e17b4` |
| VM and handoff | Normal boot/application acceptance against the actual ISO, then deliver those same bytes with hashes, logs and qualification records | **Blocked:** inconsistent Settings keyboard theme selection, one unresolved 20-second reopen timeout, and incomplete ISO Files interaction sequence. User requested the explicitly unqualified candidate in `dist\pollydesktop-0.1.0-alpha.7-debian13-31da563-unqualified-test\`; no complete VM or hardware pass claimed |

Only one media/VM lane runs after the freeze. The accepted alpha.6 ISO and its
evidence stay unchanged in their own directory. Alpha.7 uses a new output
directory, keeps the no-installer/no-automatic-disk-write Live contract, and
must show its actual version and build identity in Settings.

The headless test suite (`pollyui --test tests/<name>`) currently covers **283
assertions** across rendering, layout, DOM, events, runtime, networking,
persistence, and the JS framework layer (Vue reactivity, ~86 components, the SFC
compiler, and a Fluent control pack).

Cross-platform plan in **[docs/PORTING.md](./docs/PORTING.md)** (SDL3 desktop+
mobile backend, bare embedded-Linux/Wayland/DRM). The Host layer is the only
platform-specific code; the surface-creation seam is already abstracted.

---

## SysRT implementation task plan

Native mappings for files, processes and sockets are implemented on the declared
ABI profiles. Desktop policy remains above them. Keep the next steps small:
prove one complete execution/service path before adding broad API coverage.

| ID | Priority | Task | State / first acceptance | Prerequisites |
|---|---|---|---|---|
| RT-01 | P0 | Generic asynchronous native calls | First closed loop implemented: worker -> owning dispatcher -> Promise; scalar/CString inputs, scalar results, explicit errors and joined shutdown. Broader support stays staged | Existing FFI/dispatcher |
| RT-02 | P0 | Native memory/resource ownership | First closed loop implemented: managed async leases plus explicit adoption with byte extent and void(pointer) releaser; alias/GC/close retention. Borrowed views and fallible handle destructors remain staged | RT-01 for async leases |
| RT-03 | P0 | Native callbacks | First target integrated: scoped same-thread synchronous scalar callbacks, explicit exceptions/thread rejection and teardown. Data-pointer callbacks and retained/asynchronous registrations remain staged | RT-01, RT-02 |
| RT-04 | P0 | ABI metadata generation | First target integrated: deterministic Linux x86_64 statx layout/file constants from native headers, with generator --check and target/type guards. Other domains/targets remain staged | Independent |
| RT-05 | P1 | IPC/D-Bus SDK | First two-process loop integrated: explicit-address JS client/service, zero-wait noarg/u/b/s/o calls and fixed scalar replies, diagnostics, single-use request replies and stable cancel/close/deadlines. Setup/name claim synchronous; application authorization, containers/subscriptions remain staged | RT-01, RT-02; RT-03 only for callback-based routes |
| RT-06 | P1 | Real desktop capability migration | First service integrated: user theme-file/resource policy is JS over native files, with Shell authorization, lifecycle and rollback preserved; old C bridge removed. Bitmap decoding stays a generic GUI mechanism | Native files; RT-05 for D-Bus-based services |
| RT-07 | P1 | Independent Settings/application boundary | First app integrated: Appearance/About in an independent process/realm behind narrow IPC, daemon PID/UID and current-generation checks; Displays/Network/Audio/Keyboard retain explicit Shell-panel entry points. Relocatable single-instance launch; no private Shell connection inheritance or lost controls | RT-06, bidirectional IPC |
| RT-08 | P1 | Application configuration/state | First target integrated: typed Shell JSON preferences over native files, one-time legacy conversion preserving the original, exclusive writer lifetime and explicit publication/durability failures. Other apps' legacy storage unchanged; no native FileSystem quota | Existing native file API |
| RT-09 | P2 | Additional platforms/protocols | Deferred: Windows filesystem and DNS/HTTP/TLS only when the next real use case needs them | Relevant mechanism above |

RT-01 does not promise cancellation of arbitrary native calls: accepted work
finishes before VM destruction. RT-02 adds flat managed-buffer arguments; unknown
external pointers, pointer vectors/results, callbacks and thread-local error observers
remain excluded. A Promise
does not make every OS API safe to call from another thread.

## Service migration after Alpha.6

The substrate/Alpha closed loop is complete; remaining mechanisms and active
domain bridges are listed explicitly in
[SysRT capability gaps and service migration](./docs/SYSRT-MIGRATION.md).
The chosen order is a real service replacement, not all-purpose FFI expansion
or merely moving UI while retaining its old backend.

| Slice | Deliverable | State / prerequisites |
|---|---|---|
| SM-01 | JS Wi-Fi/iwd service replaces `desktop/native/network.c/.h`; existing scan/radio/connect/credentials/cancel/disconnect/forget and owner-loss behavior retained | Complete: JS service/transport integrated, old C bridge and hooks removed; native service, raster/GL Shell and ordinary-user Settings network flows passed |
| SM-02 | Independent Settings Wi-Fi page uses a narrow service client | Later, after SM-01; moving UI alone is not backend replacement |
| SM-03 | Next selected OS service replaces its domain bridge | Not started; choose the consumer before adding PipeWire/Wayland callback mechanisms |

SM-01 does not add a root service, change system authorization policy, migrate
other Settings pages or rebuild the physically accepted Alpha.6 media.

## Modern desktop presentation and interaction

The user selected Windows 11 as the layout/style direction for Settings, Shell
and Files. Implement original components and icons over PollyUI, not copied
system assets. The accepted Alpha.6 demonstrated function, not a finished UX.

| Surface | Concrete change | Preserved boundary |
|---|---|---|
| Settings | Integrated: sidebar, headings, grouped cards, theme-preview tiles and concise status/errors; system version/short build SHA on every page, full identity in About. Native normal/narrow layout and actual identity checks passed | Appearance/About use the existing narrow IPC; four managed pages retain explicit Shell-panel delegation |
| Shell | Integrated: modern taskbar/launcher/menu spacing, typography, original icons and fresh-session Modern default | Window/workspace controls, input focus, power confirmation, rollback and user-selected classic themes |
| Files | Integrated Explorer-like navigation/command/address areas and Places sidebar; Name/Modified/Type/Size columns, Properties for complete metadata | Current native file operations, exact-entry identity and no-clobber/error semantics |
| Files interaction | Complete first slice: single selection/focus, open, navigation, sorting, loaded-name filtering, context actions and inline rename. Normal/narrow native browser and details journeys passed, including real file/MIME operations and normal window close; current-main normal evidence was independently verified | No fake cut/paste/delete/search controls; new OS mutations require their own real backend and acceptance |

One isolated UI workstream owns these surfaces; SM-01 owns D-Bus/iwd backend
and composition. Their code ownership is kept separate. Visual acceptance uses
actual rendered windows and layout/interaction checks, not screenshots of a
mock or a theme-color-only change. No production blur/GPU effect is claimed
without a working implementation. Existing Alpha artifacts remain untouched.
Files' final acceptance runs browser and details as independent journeys with
fresh private HOME directories, real UID1000 input, file/MIME results and normal
window close in each. Their validated aggregate covers 11 distinct captured
states. Each native supervisor retains its 120-second deadline; the default
two-journey CTest envelope is explicitly 360 seconds, not an unchanged total
budget or a product performance claim. No controller shortcut replaces input.
Current-main normal captures and source-byte hashes were independently checked;
the narrow-window evidence has the same product source content with recorded
CRLF/LF checkout differences. Earlier timeout runs and pre-correction captures
remain preserved separately, never combined to manufacture an acceptance pass.

## Beta candidates: animated desktop and desktop icons

Recorded at the user's request on 2026-10-12. These are **Beta candidates**,
not a frozen Beta scope or current Alpha release gates. The user subsequently
selected BD-04 and BD-05 for design and implementation (now integrated in
`cbe4000`/`0881e09`), while explicitly
deferring the native IME extension (BD-06) to Beta. BD-01 through BD-03 remain
unselected. No version bump, media rebuild or change to historical receipts is implied.

| ID | Candidate requirement | Implementation boundary |
|---|---|---|
| BD-01 | Animated desktop companion: a character that can move across the screen, follow configurable paths and change movement/actions in response to events | JS controls paths and behavior; reusable native position, transparent presentation and input-region mechanisms support rendering. Transparent pixels must not block underlying applications; interactive regions are explicit. Not a new cursor mode or permission for arbitrary apps to create privileged overlay surfaces |
| BD-02 | Procedural animated wallpaper: animated geometry and graphics-API drawing, including game-like effects, alongside existing static images | Reuse the background layer; simple node transforms already have building blocks, but a general JS drawing surface/API is not yet implemented. Keep icons and selection above the animated background |
| BD-03 | Video wallpaper with playback and looping | Native decoding, playback timing and frame presentation with thin JS controls; avoid decoding or copying every full frame in JS. Video playback and hardware acceleration are not currently delivered or qualified |
| BD-04 | Desktop App icons/shortcuts: icon and label, single-click selection, double-click/Enter launch, context menu, internal drag-rearrangement, grid alignment/sorting and saved positions | Implemented in `cbe4000`/`0881e09`; reuse catalog/launcher and stable IDs. Removing a shortcut does not uninstall the App. Real desktop files and mutations remain separate scope |
| BD-05 | Desktop marquee and multi-selection: left-button drag on empty desktop draws a translucent rectangle; support single selection, additive/toggle selection, ordered-range selection, select-all, keyboard navigation and Escape cancellation | Implemented in `cbe4000`/`0881e09`; native capture/cancel with output-local JS selection. Gestures cancel on focus/capture loss, lock and output retirement |
| BD-06 | Native IME context/editing extension: surrounding text, directional selection, delete-surrounding and atomic native edit transactions; actual context consumption where an engine supports it | Explicitly deferred to Beta on 2026-10-12. Preserve existing Rime input; transport alone does not add Rime context intelligence. Native single-owner/SDK route and platform scope must be decided before reopening; no implicit Windows IMM/TSF implementation |

If selected, build desktop selection/icons and simple companion/image-frame or
node-based wallpaper animation before broader drawing/video capabilities.
Animation needs static/reduced-motion fallback and lock/invisibility-aware
pause or reduced frame rate. Position/input geometry must account for output
scale and display changes; cross-output gestures require explicit handling,
not an assumed global mouse grab.

Internal icon rearrangement and marquee selection do not depend on outgoing
cross-application drag-and-drop. Dragging a desktop shortcut into another App
requires a separate Shell-layer authorization and payload contract: the
currently approved outgoing-drag increment is ordinary-window COPY only.
These candidates do not expand the delivered ordinary-window drag increment.
BD-04/BD-05 implementation follows their separate user approval, not an
automatic expansion into desktop file operations or cross-application dragging.

## Next-version candidate: transparency and materials

The user asked to retain the 2026-10-11 material discussion as a candidate for
the next version. On 2026-10-12 the user selected **MT-01 only** for design and
implementation, first Wayland and then Windows with shared code extracted and
different native paths separated. MT-02/MT-03 remain candidates, not selected
for implementation. No release number or new media is assigned by this work.
See [transparency/material conclusions](./DESIGN.md#51-transparency-and-material-discussion)
for current capabilities, layer ownership and constraints.

| Candidate slice | Concrete deliverable | Scope/status |
|---|---|---|
| MT-01 | Ordinary-window transparent background with intact opaque foreground text; capability/error reporting | Wayland integrated in `dd40d03`; Windows child `dca78a0` awaits user composed-output acceptance and is not integrated. Shared strict opt-in flag; transparent popups/input shapes remain outside this increment |
| MT-02 | Cached wallpaper-derived Mica-like base and in-app material composition | Candidate: GUI/Skia plus explicit desktop theme/wallpaper inputs; not live cross-window blur |
| MT-03 | Regional background acrylic/blur for taskbar, menus and transient surfaces | Candidate: PollyWM render/damage/cache path plus effect requests; not a GUI-only style property |

The Wayland milestone independently passed eight composed-output scenarios:
raster with SDL OpenGL/software presentation and Skia GL/auto at 1x/1.5x.
Actual zero/half/opaque alpha pixels, opaque text, changed underlying colors
after movement, native resize, frame/frameless, owned/modal closure and
rectangular input/capture were checked. Mainline Linux eight-case CTest and
Windows nine-case compatibility runs passed; Windows transparency still
reports unsupported until its backend is delivered. This is software-renderer
qualification, not physical-GPU evidence or completion of the whole MT-01 item.

Prefer MT-01, then MT-02, then MT-03 if the candidate is approved. Keep solid
fallbacks explicit and validate native pixels, clipping/readability and actual
render/damage cost before claiming support. Windows' existing DWM setter needs
visibility and failure handling; it is not proof of a complete effect. The
MT-01 implementation approval does not authorize MT-02/MT-03, a version bump
or a new ISO.

## Next-version requirement: system-level animated rabbit cursor

The user selected this for the version after Alpha.7, **excluded from Alpha.7**.
The first source implementation is present; the next release number is not yet frozen.
PollyWM supplies the desktop-wide default rabbit cursor: idle, running on
movement, hopping on click and an effort pose during drag. Application windows may explicitly
override it with an appropriate cursor; returning to an inheriting region
restores the system default. This requires custom native/compositor cursor
images and hotspots, animation state/lifetime handling, output scaling and a
clear client override contract. The native theme/action module, original
prebuilt assets and semantic cursor-shape bridge now implement the prototype.
Preserve focused-client authorization, protected-role behavior,
static/reduced-motion fallback and cursor-only animation work.
See [the recorded scope](./DESIGN.md#53-system-level-animated-cursor-candidate).
The [implementation contract](./docs/DESKTOP-CURSOR.md) documents wlroots
frame playback, DEFAULT/legacy/hidden behavior and actual native cursor-texture
acceptance. Source-level static/default, action, lifecycle, scale and package
wiring are implemented. Preferences UI, touch/pen/multi-pointer and hardware/
new ISO qualification are not included and remain future work.

## Engines & pipeline

| Feature | Status | Notes |
|---|---|---|
| HostEngine — Win32 window, event loop, resize | ✅ | `gui/src/host/win32`; smooth live-resize (double-pump + authoritative size) |
| **Frameless window / custom title bar** | ✅ | `WM_NCCALCSIZE`+`WM_NCHITTEST`; keeps resize/snap; `appRegion:drag` |
| **JS `window` controls** (minimize/maximize/close/setFrameless/setBackdrop) | ✅ | global `window` object in the windowed app |
| **Native mouse capture / cancellation / cursor** | ✅ | Document-owned capture and click lifecycle; Win32 OS capture and Wayland live button grab; activation callbacks and native system cursors. JS widgets/gestures remain separate; see [input contract](./README.md#native-mouse-interaction-mechanisms) |
| **Mica / Acrylic backdrop** (Win11 DWM) | 🟡 | `DwmSetWindowAttribute` set; visible Mica needs a transparent surface |
| Per-monitor **DPI awareness** (logical px → physical) | ✅ | `WM_DPICHANGED`, scale in render + hit-test |
| **Surface seam abstraction** (`create_gpu`/`create_metal`) | ✅ | opaque native handle; ready for SDL3/macOS/Linux |
| ScriptEngine — QuickJS-ng VM | ✅ | runs `.js`/`.mjs`, error reporting |
| Model — retained DOM tree, refcounted lifetimes | ✅ | `gui/src/model/node.c` |
| Bridge — JS ⇄ native, wrapper cache + GC finalizers | ✅ | verified by refcounts |
| LayoutEngine — Yoga Flexbox | ✅ | `gui/src/layout` |
| RenderEngine — Skia | ✅ | full paint set below |
| Event loop — pump + run-loop, async-aware | ✅ | `gui/src/script` |

## Rendering backend

| Feature | Status | Notes |
|---|---|---|
| **GPU: Skia Ganesh → ANGLE → D3D11** | ✅ | the standard Windows GPU path |
| Raster (CPU) surface + `StretchDIBits` fallback | ✅ | also used by headless tests |
| Linux CPU raster + SDL3 presentation | ✅ | native Skia m124 build, Fontconfig/FreeType; not a Linux Skia GPU backend |
| macOS GPU (Metal / ANGLE) | 🛠 | with the macOS host port |
| Linux Skia GLES backend | 🟡 | SDL-owned EGL/GLES 3; llvmpipe verified, hardware qualification pending |
| Official ANGLE binaries for distribution | 🛠 | today staged from installed Chrome/Edge |

## Paint / visuals

| Feature | Status | Notes |
|---|---|---|
| Background-color fills | ✅ | `#rgb`/`#rrggbb[aa]`/named colors |
| Borders (width/color) | ✅ | `borderWidth`/`borderColor` |
| Border-radius (rounded corners) | ✅ | `borderRadius`; clips bg/border/image |
| Box shadows (blurred) | ✅ | `shadowColor`/`Blur`/`X`/`Y` |
| Gradients (linear) | ✅ | `gradientFrom`/`gradientTo`/`gradientDir` |
| Images (load + draw, cached) | ✅ | `backgroundImage`, scaled + clipped |
| Element opacity / alpha | ✅ | `opacity` (subtree layer) |
| Transforms (translate/rotate/scale) | ✅ | about center; paint-space |
| Clipping / `overflow:hidden` | ✅ | clips children to the box |
| Scrolling (`overflow:scroll`/`auto`) | ✅ | scrollTop/Left + wheel + clamp |
| `z-index` | 🟡 | paint = tree order; no explicit z |
| Radial gradients, filters/blur regions | 🛠 | |

## Text

| Feature | Status | Notes |
|---|---|---|
| Text rendering (Skia + DirectWrite) | ✅ | measured into layout |
| `measureText(str, fontSize, weight?)` | ✅ | |
| Inherited `fontSize` / `color` | ✅ | from parent element |
| **Font weight (bold) + style (italic)** | ✅ | `fontWeight`/`fontStyle` |
| **Per-glyph font fallback** (symbols + emoji) | ✅ | substitutes a system face for missing glyphs |
| **Multi-line text** (embedded `\n`) | ✅ | measure + draw per line |
| **Word-wrap to a width** | ✅ | greedy word wrap; measure + paint agree |
| **`text-align`** (left/center/right) | ✅ | per-line within the box |
| **Blinking, movable caret** (text field) | ✅ | `gui/sdk/js/textfield.js`, `gui/tests/caret.js` |
| **Text selection + click-to-position caret** | ✅ | `gui/sdk/js/textinput.mjs` (drag-select, edit) |
| IME (CJK / emoji composition) | 🛠 | |
| **Font families** (`fontFamily`) | 🟡 | monospace→Consolas, serif→Georgia; arbitrary loaded faces pending |
| **Gradient-filled text** (`textGradientFrom/To`) | ✅ | |

## Layout (Yoga)

| Feature | Status | Notes |
|---|---|---|
| `flexDirection`, `flexGrow`, `flexShrink` | ✅ | |
| `flexBasis` (px/%/auto) | ✅ | |
| `flexWrap` | ✅ | |
| `justifyContent`, `alignItems`, `alignSelf`, `alignContent` | ✅ | incl. space-between/around |
| `gap` | ✅ | |
| `width`/`height` + `min/max` (px, %, auto) | ✅ | |
| Per-edge `padding` / `margin` | ✅ | all + L/R/T/B |
| `position: absolute` + `top/left/right/bottom` | ✅ | overlapping views |
| `display:none` (hide without removing) | ✅ | collapses + skipped in paint |
| `aspect-ratio` | 🛠 | |

## DOM / bridge API

| Feature | Status | Notes |
|---|---|---|
| `createElement` / `createTextNode` / `body` | ✅ | |
| `el.style.*` (exotic object) | ✅ | string values |
| `appendChild` / `removeChild` / `insertBefore` | ✅ | |
| parent/first/last/next/prev, `childNodes` | ✅ | |
| `nodeType`, `tagName`, `textContent` | ✅ | |
| `addEventListener` / `removeEventListener` | ✅ | |
| `tabIndex`, `focus()` / `blur()`, `document.activeElement` | ✅ | |
| `setAttribute`/`getAttribute`/`has`/`remove` | ✅ | generic attribute map |
| `id`, `className`, `classList` (add/remove/toggle/contains) | ✅ | |
| `getElementById`, `querySelector(All)` | ✅ | `#id` / `.class` / tag / `*` |
| `scrollTop` / `scrollLeft` | ✅ | reflected to scroll state |
| `offsetLeft/Top/Width/Height`, `getBoundingClientRect()` | ✅ | computed layout geometry |
| `innerHTML`, complex CSS selectors | 🛠 | |

## Events / input

| Feature | Status | Notes |
|---|---|---|
| Click (hit-test + **bubbling**), click-to-focus | ✅ | |
| `mousedown` / `mouseup` / `mousemove` | ✅ | carries clientX/Y |
| `mouseenter` / `mouseleave` (hover) | ✅ | non-bubbling |
| `wheel` + default scrolling | ✅ | nearest scroll container |
| Keyboard `keydown` + `keyup`, **Tab** focus cycling | ✅ | DOM key names |
| Structured input + committed text | ✅ | key/code/modifiers/repeat, textinput.data, Shift+Tab, pointer buttons, two-axis wheels; physical device/IME qualification remains separate |
| `focus` / `blur` events | ✅ | non-bubbling |
| **`preventDefault` / `stopPropagation` / `stopImmediate`** | ✅ | + `defaultPrevented` |
| `dblclick`, `contextmenu`, drag, touch | 🛠 | |

## Script runtime

| Feature | Status | Notes |
|---|---|---|
| `console.*` | ✅ | log/info → stdout, warn/error → stderr |
| `setTimeout` / `clearTimeout`, promises/microtasks | ✅ | |
| `setInterval` / `clearInterval` | ✅ | |
| **`requestAnimationFrame` / `cancelAnimationFrame`** | ✅ | per-frame, ms timestamp |
| **ES modules** (`import`/`export`, `.mjs`) | ✅ | loader + normalize |
| **`localStorage`** (persistent key/value) | ✅ | file-backed, survives restarts |
| **`fetch`** (Promise; http/https + file://) | ✅ | WinHTTP / Linux libcurl; method/body/headers, text()/json(), bounded request shutdown |

## Concurrency

| Feature | Status | Notes |
|---|---|---|
| `Worker` (separate JS context per thread, postMessage/onmessage) | ✅ | JSON messages |
| `computeAsync(n, cb)` — native bg work → UI callback | ✅ | |
| UI-thread **dispatcher** (BeginInvoke-style marshal) | ✅ | `shared/dispatch` |
| Worker transferables / SharedArrayBuffer, nested workers | 🛠 | |
| Thread pool + native async **I/O** (file/network) | 🛠 | one-thread-per-task now |
| JS (main DOM) on its own thread | ⏸ | superseded by JSI + Workers |

## Styling system

| Feature | Status | Notes |
|---|---|---|
| Imperative `el.style.x = y` | ✅ | |
| Inheritance (fontSize/color/weight/style) | ✅ | text inherits from parent |
| **CSS-ish stylesheets + selectors** (`gui/sdk/js/css.mjs`) | ✅ | tag/.class/#id/*, descendant, specificity |
| **Engine-level `:hover` / `:focus`** (`hoverStyle`/`focusStyle`) | ✅ | `PU_STATE_*` flags; per-property override; repaint-only (no relayout) |
| **Light & dark themes** (`useTheme`) | ✅ | runtime theme switch |
| Desktop theme configuration | ✅ | Versioned JSON, bounded local bitmaps, user overrides, explicit reload/restore, runtime decoration snapshots and opt-in app subscriptions. See `desktop/THEMES.md`. Existing layout parameters are configurable; arbitrary templates, automatic file watching and new compositor effects remain separate work. |
| Units beyond px/% (`em`/`rem`/`vh`/`vw`) | 🛠 | |
| `:active`, full theme-variable system | 🛠 | |

## Animation

| Feature | Status | Notes |
|---|---|---|
| `requestAnimationFrame` driving | ✅ | per-frame, ms timestamp |
| **Tween + easing library** (`gui/sdk/js/anim.mjs`) | ✅ | `animate()`, 8 easings, delay, promise |
| **Declarative transitions** (`transition` prop) | ✅ | reconciler tweens changed numbers/px/hex-colors; per-prop filter; re-target cancels in-flight |
| **`<Transition>` enter/leave** (`gui/sdk/js/transition.mjs`) | ✅ | onMount/onLeave reconciler hooks; leave defers DOM detach until tween ends |

## Higher-level

| Feature | Status | Notes |
|---|---|---|
| **Vue-style reactivity + Composition API** (`gui/sdk/js/vue.mjs`) | ✅ | ref/reactive/computed/watch, createApp/setup |
| **React-style reconciler** (virtual DOM, `gui/sdk/js/reconciler.mjs`) | ✅ | h()/render()/mount(), diff + components |
| **Vue SFC compiler** (`gui/sdk/js/sfc.mjs`) | ✅ | `<template>/<script>/<style>` → component; v-if/v-for/:bind/@event, interpolation, ref auto-unwrap, **slots**, stateless tag form + attribute fallthrough |
| **Custom element tags** (`defineTag`, `gui/sdk/js/pollyui.mjs`) | ✅ | author by name: `h('button',…)` / `h('fluent-card',…)`; auto-registers all `N*` as kebab tags |
| **Fluent / WinUI control pack** (`gui/sdk/js/fluent.mjs`) | ✅ | 8 SFC controls: card/button/infobar/toggle/hyperlink/badge/progressbar/expander |
| **WinUI 3 Gallery demo** (`gui/sdk/js/winui.mjs`) | ✅ | frameless + Mica, NavigationView, 5 populated pages (Home/Basic input/Collections/Dialogs/Styles); Naive theme retinted Fluent so all 85 components look native |
| **MS Store / Fluent demo** (`gui/examples/playground/msstore.mjs`) | ✅ | responsive card grid, auto-advancing hero, custom draggable title bar |
| **Naive UI-style component library** (`gui/sdk/js/naive.mjs`) | ✅ | **~86 components** — full Naive UI parity (+ NForm/createForm validation, NTable, dialog API): inputs (Input/Number/Select/Cascader/TreeSelect/AutoComplete/Mention/DatePicker/TimePicker/ColorPicker/Slider/Switch/Checkbox/Radio/Rate/Upload/Transfer/DynamicInput/DynamicTags), data (DataTable+sort/select/VirtualList/Tree/List/Descriptions/Timeline/Calendar/Statistic/Avatar/Badge/Image/Carousel/Code/GradientText/Ellipsis/Time/Countdown), feedback (Modal/Drawer/Popconfirm/Popover/Popselect/Tooltip/Message/Notification/LoadingBar/Alert/Result/Spin/Skeleton/Progress), nav (Menu/Tabs/Steps/Pagination/Breadcrumb/Anchor/Affix/BackTop/Dropdown), layout (Layout/Grid/Flex/Space/Card/Divider/Collapse/Watermark/Scrollbar), Typography/Icon/ButtonGroup/Empty/ConfigProvider — plus a portal layer, form validation, light & dark themes |
| **CSS engine** (`gui/sdk/js/css.mjs`) | ✅ | stylesheet + selector cascade |
| **Tween/animation** (`gui/sdk/js/anim.mjs`) | ✅ | rAF-driven, easings |
| **Text input** (selection + editing, `gui/sdk/js/textinput.mjs`) | ✅ | click/drag-select; clipboard/IME pending |
| Per-glyph font fallback + font-family + gradient text | ✅ | symbols/emoji, monospace/serif, gradient-filled text |

## Accessibility

| Feature | Status | Notes |
|---|---|---|
| Semantic tree → UI Automation / AT-SPI / NSAccessibility | 🛠 | screen-reader support |

## Performance

| Feature | Status | Notes |
|---|---|---|
| **Skip-when-clean layout** (cache; skip Yoga when only render-only state changed) | ✅ | scroll/hover/fade frames: layout 8ms → ~0 (3.6× per-frame) |
| **Repaint gating** (no repaint when nothing changed) | ✅ | idle ~0% CPU; events repaint only on real change |
| True per-subtree incremental layout (persistent Yoga + reset-aware styles) | 🛠 | helps layout-*changing* animations |
| Display-list / dirty-region rendering, compositor-thread animation | 🛠 | the WinUI-class render path |
| True idle (no 60 Hz frame-timer wakeups when idle) | 🛠 | |

## Tooling & infra

The user deferred the Playwright-style GUI automation adapter on 2026-10-11.
When resumed, follow browser/Playwright locator, action and waiting conventions;
no detailed protocol design or implementation is scheduled now. Keep existing
test harnesses; this adapter is separate from system accessibility bridging.

| Feature | Status | Notes |
|---|---|---|
| **Headless test harness** (`--test`; click/mouse/scroll/key/render(ts)/flush/pixel/save) | ✅ | deterministic, **283 assertions**; `PU_TEST_W/H` viewport, `PU_PERF` tracing |
| No-console release build (`PU_WINDOWED`) | ✅ | |
| In-process symbolized crash handler (DbgHelp) | ✅ | |
| CMake + Ninja + clang-cl; fetch/vendor deps | ✅ | |
| CI running the test suite | 🛠 | |
| JS bundler (assets), hot reload, inspector | 🛠 | |
| Packaging / installer | 🛠 | |

---

### Suggested next steps

1. **True per-subtree incremental layout** — persistent Yoga tree + reset-aware
   style application; unblocks layout-changing animations and the compositor path.
   (Needs a broadened layout test corpus first.)
2. **SDL3 host backend** — one backend for Linux/macOS/iOS/Android (see PORTING.md);
   then the **Skia Metal** surface path for Apple, and a **transparent surface** so
   real Mica/Acrylic shows.
3. **Dirty-region / display-list rendering + compositor-thread animation** — the
   WinUI-class render path (60fps motion at scale).
4. **Accessibility** — semantic tree → UI Automation / AT-SPI / NSAccessibility.
5. **Text**: custom font families beyond the built-ins, IME (CJK/emoji), clipboard.
