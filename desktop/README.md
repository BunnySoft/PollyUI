# PollyDesktop

For the current system-level introduction, principles, capability matrix and
handoff, start with **[PollyOS 技术简介与交接指南](../docs/POLLYOS.md)**.
PollyOS is the system name; existing subproject/tool/artifact names remain unchanged.
The **[historical deferred-work ledger](../docs/POLLYOS-BACKLOG.md)** tracks
unfinished subfeatures across the original 45 milestones, theme/release decisions
and the second-stage plan; a completed milestone does not close all future extensions.
The [storage/Linux compatibility design](../docs/POLLYOS-STORAGE-DESIGN.md)
is the current **P0 implementation priority**: writable single system,
classified persistent state, shared Apps and independent recovery.
The ledger owns all sequencing and status; current D1 and private application
stores below remain unchanged until separately verified migration.

An experimental Linux desktop subproject. **PollyWM** is our own C11 Wayland
compositor built on **the pinned PollyUI wlroots 0.19.3 scene-effects SDK**, not labwc, GNOME or KDE.
It includes a native development **PollyShell** with themed wallpaper, panels,
Dock and appearance settings. An unsigned, memory-only x86_64 UEFI development
ISO now boots this desktop in a disposable VM. It is **not yet a complete,
production-qualified desktop distribution**; see **[Live image](./LIVE.md)**.

The Shell-owned [System Settings window](./SETTINGS.md) brings Appearance,
Displays, Network, Audio, Keyboard and About together using the existing native
controllers. Unavailable services remain explicit; closing Settings does not
stop the desktop, audio policy or independent applications.
Packaged Settings now opts into a cached, opaque wallpaper-derived client base
when the theme explicitly requests it (Modern does). Bitmap sources use a
bounded authenticated projection of the current committed wallpaper, not
filesystem permissions or live background capture. The direct app API and
missing/solid policy retain the solid path; see the
[Settings material contract](apps/settings/README.md#opaque-wallpaper-derived-client-base).

## Optional native window effects

Theme JSON remains version 1. `window.nativeEffects: "rounded"` opts server-decorated
floating windows into the existing `window.radius`; missing or `"none"` preserves
the old rectangular native window. `"rounded-shadow"` additionally enables a real
external Gaussian-outline shadow, using `ceil(window.shadow / 2)` as its sigma.
Optional `nativeShadowColor` is RGB; active/inactive `nativeShadowOpacity` and
`nativeShadowInactiveOpacity` are integer percentages (JS defaults 24/12), and
`nativeShadowX`/`nativeShadowY` are integer offsets within -64..64. The JS defaults
are black, x=0 and y=round(window.shadow/4); none are interpreted as presets in C.
`window.shadow` alone never enables native shadows without that explicit mode.
Packaged Modern explicitly selects `rounded` with its existing radius 8 and no
shadow; Aqua, Lion and Big Sur select `rounded-shadow` with their existing
radius/shadow tokens. Classic and XP remain on the previous native path.
Custom themes with a missing field stay unchanged, and an explicit `"none"`
override disables the effect.
Maximized/fullscreen, explicit client-side decorations and undecorated
windows remain unaffected. Popups are separate from the rounded client-plus-frame
subtree. Input regions intentionally remain the existing rectangles, including
visually clipped corners; this feature does not introduce corner click-through.

The compositor isolates real scene descendants, preserving source crop, buffer
transforms, alpha and subsurfaces, then applies antialiased coverage once. It never
asks JavaScript to capture client pixels. Existing scene output commits, damage,
frame callbacks and lock visibility remain authoritative. Opted-in caption strips
remain square, including maximized frames, so only the compositor owns outer AA.
Shadows have no input/opaque region, exclude the window interior, and use the same
real underlay rather than a simulated backdrop. Rounded trees cannot
direct-scan out; visibility is conservative so clipped corners retain real underlay.
Caches are per output/scale/pixel phase and invalidated by subtree changes.
Each target is limited to 32768 pixels per axis and 16 megapixels. All targets
share a 128MiB backing-plus-workspace reservation, including shadow coverage workspace; allocation/budget failure
explicitly fails composition rather than substituting a square window.

The source patch and SHA-256 pin live in `patches/wlroots-scene-effects.patch` and
`release/debian/wlroots-effects.json`. The SDK recipe and release checks use the
same applier; the private library has a distinct effects-ABI SONAME. CMake checks
both its header ABI and required linked symbols; startup and packaging also compare
the actual library's embedded patch SHA-256, not only an adjacent receipt file.
Private appearance protocol and
geometry schema 7 reject older WM/Shell/decorator pairings; the private library is
effects ABI 4 (`libwlroots-0.19-polly-effects4.so`). Its SDK prefix is
`/opt/pollyui-wlroots-effects4`; do not overwrite an effects2/effects3 installation.
GLES rounding/shadow effects still require 23-bit fragment highp precision, checked explicitly;
unsupported precision fails effects rather than using a mediump shape. Ordinary
no-effect rectangles keep their existing path. Stock SDKs are not a supported fallback.
Rounding and shadows do not themselves sample the backdrop.

### Regional Dock backdrop (Pixman)

The production Big Sur Dock explicitly opts into `panel.regionalBackdrop` in
public theme JSON schema 1: `{ "sigma": 8, "tint": "#e7e7e7", "opacityPercent": 28 }`.
These are original Polly design values, not measured macOS values or a claim of
macOS vibrancy. The existing Dock rectangle is the entire effect/input footprint;
its glyphs, bitmaps, focus, grouping, markers, counts and hover animation remain
separate foreground content. No other panel, menu bar, application or lock surface
automatically acquires glass.

Effects4's generic non-input node composes the current lower scene in paint
order into an expanded regional target, filters premultiplied RGBA with a
normalized separable Gaussian truncated at three sigma, applies premultiplied
tint and rounded coverage, and clips back to the footprint. It neither captures
the node/foreground nor reads a previous output frame. JavaScript never receives
scene pixels. Each output has its own scale/position-keyed cache; scene changes
conservatively damage the footprint, not a periodic full-output repaint. Hiding,
destroying, output removal and compositor lock/unlock release retained samples.
The generic regional path exposes `WLR_SCENE_BACKDROP_*` limits: eight nodes,
4096x768 logical pixels per node, sigma 0.5..32, at most 64 physical sigma and
2*1024*1024 physical pixels including `ceil(3*sigma*actual_output_scale)` padding
on **each** side. Each expanded axis must also fit 32768 pixels. Logical admission
does not guarantee support at every scale/sigma: for example 640x660 at scale 1,
sigma 16 fits, but scale 2 with the same sigma exceeds the expanded pixel limit
and is explicitly rejected. No production geometry reduction, tiling, second
renderer or JS readback is used. All old/candidate buffers and filter workspace
share the unchanged 128MiB scene effects peak budget; even a geometry within the
pixel limit can be rejected when that shared reservation is occupied.
Pixman effect SHM backing is reserved before rendering so tmpfs exhaustion is an
explicit allocation failure rather than a later mapped-page SIGBUS.

The existing private v7/schema2/role1 **Dock** request retains its original
4096x512 logical extent explicitly in `prepare_backdrop`. A newer generic library
does not grant that protocol taller targets or Start/menu authority. This
primitive/SDK extension does not deliver a production Start consumer, change
theme JSON/config/geometry schemas, or qualify GLES/physical GPUs.

The exact separable filter is CPU-bounded, not a real-time performance guarantee.
When `__x86_64__` and `__SSE2__` are defined, an internal baseline-SSE2 helper
unpacks exactly one four-byte pixel into four float channels. Each tap uses
one multiplication and one addition per lane in the original tap order.
Four adjacent columns in the horizontal pass, and four adjacent rows at one
column in the vertical pass, have independent four-channel accumulators.
Three unpacked input pixels initialize a sliding register window; each tap
loads and converts only the next four-byte packed pixel, broadcasts its
coefficient once, then updates all four independent sums in original tap order.
Only the unweighted input conversion is reused, never a weighted sum or an
unrounded horizontal result. Rotation happens after consuming the current tap;
there is no next-tap prefetch. Complete blocks alone use this path, with the
original single-pixel SSE2 loops handling the last one to three columns or rows.
Horizontal blocks write only valid intermediate columns. Vertical blocks read
only those packed columns and write four valid destination rows.
Each accumulator is stored to four local floats before the original `lroundf`;
kernel normalization, horizontal packed-byte rounding, vertical premultiplied
tint and rounded coverage stay unchanged. The four exit lanes use explicit
original `lroundf` calls and constant byte shifts rather than a runtime channel
index/packing loop; vertical lanes retain the original component mapping and
per-channel tint, clamp and coverage order. This removes fixed per-pixel packing
overhead without a workload threshold or a different short-kernel algorithm.
The sliding-input change has a separate source pin and needs a rebuilt matched
SDK/core. It currently has only production-object/static qualification;
runtime exactness, bounds and performance require new evidence, not the earlier
implementation's results.
There is no SIMD-width neighboring pixel read, approximate rounding, new
allocated workspace, runtime CPU/policy
channel, ISA flag, fast-math/FMA policy change or ABI change.
The compile-time fallback retains the original scalar Gaussian source, not
the earlier four-pixel scalar experiment or a different material. The published
single-output SSE2 and frozen eight-output predecessor passed the exact-byte
fixture, but those results do not qualify the new sliding-input path or other
architectures, compilers or flags.
A full 640x660, sigma16, scale1 update still performs 351,621,120 channel taps.

The frozen eight-output predecessor's one comparison against the published
single-output SSE2 library remained **HOLD**: large-case production medians
improved only 1.21--1.24x, and the 4096x1 moving-build median regressed from
4.5902 to 5.0047ms. Its test-driver C flags also differed (`-std=c11` versus
the reference compiler default), so it was not a fully qualified symmetric
performance pair. All original observations remain frozen, with neither a
noise waiver nor a rerun. A future pair must use the same top-level CMake
entry and explicit C standard/extensions for both roles, and compare actual
compiler flags for every core translation unit and the scene test driver
before collecting samples.

The original native measurement was about 294ms. Earlier standard-C candidates
did not achieve the twofold goal and remain independent frozen experiments.
The following measurements predate the exit-lane expansion and the published
SHM/private-process safety composition; they do not qualify that new pairing.
One GCC14/O3 reference-versus-SSE2 comparison, in sequential processes pinned
to the same allowed CPU on a shared host, with one warmup and three measured
samples per case, gave these medians. Preparation includes real lower-scene
composition; moving includes filtering and output capture:

| Footprint, sigma16, scale1 | Reference prepare / moving | SSE2 prepare / moving | Speedup prepare / moving |
| --- | ---: | ---: | ---: |
| 640x640 | 296.347 / 301.344ms | 117.124 / 117.771ms | 2.53x / 2.56x |
| 640x660 | 294.193 / 297.001ms | 118.720 / 122.445ms | 2.48x / 2.43x |

Both full-footprint targets exceed the twofold engineering threshold, but
**not** the 16.7ms frame budget or an all-case non-regression requirement.
The same fixed pair recorded 37x29/sigma0.5/scale1.25 prepare
0.812->0.906ms (+11.6%) and moving 6.170->6.654ms (+7.8%);
41x33/sigma2.25/scale1.5 prepare 1.171->1.229ms (+5.0%); and
4096x1/sigma0.5/scale1 moving 16.798->16.867ms (+0.4%).
These regressions are retained, not waived as noise or
removed by choosing samples. All nine cases' raw times and medians remain
part of the comparison evidence. This is not an exclusive-CPU or universal
speedup claim. Idle captures still reuse the cache without filtering.
Byte equivalence and performance observations do not explain the earlier
ENOSPC, SIGBUS or reap holds, or deliver a production Start consumer.

`desktop-scene-effects` retains its original assertions and 30-second timeout.
Maximum-geometry acceptance qualification uses an independent private IPC
namespace with 65,536,000 bytes of SHM, all available before the scene driver
starts, rather than sharing a namespace with preceding GUI lifecycle suites.
The matched ABI4 driver passed the complete original scene contract in that
recorded envelope and restored every VFS field after exit. A separate first
combined 64MiB run failed backing reservation at the accepted 4092x508 case;
its available space at that point was not recorded. That failure remains
unresolved, not reclassified as a proven leak or a passing combined suite.
Neither geometry assertions nor resource limits were relaxed. This scene
qualification envelope does not make the normal owner-specific SHM allocator
contract require an exclusive mount.

Its separate `--gaussian-compare EXISTING_OUTPUT_DIRECTORY` mode records raw
prepare/moving/idle timings for nine fixed full-scene cases and writes each
case's complete initial/moving frames. Link the same test source separately
against each correctly paired compositor core/SDK, rather than swapping
libraries under a mismatched core; compare the resulting files byte for byte.
The mode rebuilds each backdrop/cache for every sample, checks movement causes
one new filter, checks idle causes none, and verifies destruction returns cached
bytes to zero. Enabling a prepared backdrop also causes an initial capture
filter in both SDKs; its separate timing and equal filter counts are retained.
The comparison does not reduce geometry, sigma, padding or kernel quality.

Comparison mode now separates production work from screenshot verification.
It allocates three actual-output-sized validation buffers and touches every
pixel once during each case's setup, then reuses them for the unchanged four
trials. The maximum validation storage is 39,321,600 bytes. Its allocation,
prefault cost and longer lifetime are disclosed, not charged to the Gaussian
kernel or presented as lower whole-program memory use. The ordinary scene suite
still allocates its captures normally; production SDK sample/result/workspace,
output allocation and cache limits are unchanged. Each capture still copies
every output pixel using the real stride and performs the original byte checks.

`GAUSSIAN_STAGE` reports wall time, thread CPU time and per-thread voluntary and
involuntary context switches for prepare, initial capture, moving and idle.
Capture build, verification copy and state finish are separate. Build includes
lower-scene/FIR preflight, output allocation and rendering, **not pure FIR**.
Metrics are buffered until all cases finish; the one empty measurement is
reported without subtracting it. Missing clocks/counters and record overflow
fail explicitly. `GAUSSIAN_CONTEXT` and the cursor log identify the real
executable/resource paths: a relocated or symlinked test must not silently use
different cursor assets from its reference.

One corrected, symmetric GCC14/O3 comparison of the exit-expanded filter and
the original scalar math, both using the published safety allocator/core,
retained all nine cases, one warmup plus three measurements, CPU 0, 30 seconds
per process and 65,536,000 bytes of SHM. Its predeclared production-stage medians
were:

| Footprint, sigma16, scale1 | Scalar prepare / moving build | SSE2 prepare / moving build | Speedup prepare / moving build |
| --- | ---: | ---: | ---: |
| 640x640 | 305.994 / 293.538ms | 112.836 / 116.834ms | 2.71x / 2.51x |
| 640x660 | 302.796 / 302.197ms | 115.604 / 115.964ms | 2.62x / 2.61x |

All seven other cases' observed prepare/moving-build medians also improved,
without a tolerance or sample exclusion. Full frames and filter/cache counts
remained identical. Complete three-sample ranges and CPU/context data are
retained: this is one shared-host observation, not a statistical guarantee for
arbitrary runs. Earlier malloc-inclusive and cursor-asymmetric observations
remain separate evidence, not retroactively passing results. The matched
ordinary scene contract passed its original accepted/pressure/tall assertions,
but the independent published SHM fixture's first run retained a one-page and
one-inode global-statistics deficit after a positive buffer drop. A distinct
owner-identity diagnostic did not reproduce that deficit; it does not waive
the original failure or establish a kernel/allocator cause. The normal SHM
test's shared-mount contract is corrected below, with stronger object-specific
checks rather than retroactively reclassifying that original run. These results
are still far from 16.7ms/60Hz and do not deliver a production Start consumer.

The same reservation now covers every buffer created by the selected wlroots
SHM allocator, including output/swapchain and cursor buffers. After creating the
unlinked file, it retries `posix_fallocate` on `EINTR` and reserves the entire
backing before mapping or returning the buffer. Any other returned error is
logged and closes the fd/frees the unpublished object, returning `NULL`; there is
no sparse-mapping fallback. The effects wrapper's existing reservation remains.
GBM/DRM/udmabuf allocators, imported client buffers and geometry/API contracts are
unchanged. This is a deterministic SHM-backing safety fix, not a diagnosis of
earlier SIGBUS, ENOSPC or process-reaping failures. The API/layout and SONAME stay
ABI 4, but the patch/source SHA-256 changes: rebuild the paired SDK and WM in a
separate prefix/output directory rather than overwriting a retained SDK.

`desktop-shm-allocator` runs the real pinned SHM factory, checks physical fd
backing **before** access and fully reads/writes 4096- and 131072-byte buffers.
Normal mode needs tmpfs with at least 1MiB free and no own SHM mappings, not an
exclusive mount. It checks the actual destruction notification, old-fd `EBADF`,
and `mincore` `ENOMEM` for every recorded old mapping page, without touching
freed memory. Before opening proc files that could reuse a descriptor number,
it proves the original object's release. Every phase must restore the complete
own SHM `(fd, device, inode)` set, empty own SHM mapping set and original total
fd count; allocation-failure paths cannot hide a leaked unpublished object.

The first whole-mount VFS snapshot stays in its original position, with later
owner/post-VFS observations explicitly separate. Normal mode reports changes
in global space/inodes, but does not misattribute another legitimate user's
allocation to this object's owner. A separate controlled, real same-mount
helper counterexample retained one backed page while all three target objects
were destroyed, closed and unmapped: the old global predicate rejected every
one despite exact owner restoration. Releasing/waiting that owned helper
restored all global totals and control fds. This establishes the normal-test
assumption defect, not the cause of any historical one-page deficit, ENOSPC,
SIGBUS or reap failure. That diagnostic is retained separately, not registered
as ordinary CTest coverage.

To exercise rejection, run the same
`pollywm-shm-allocator-test --private-64k` binary with
`POLLY_SHM_PRIVATE_TEST=1` **only inside a new disposable, private IPC container**
with `--shm-size=64k` and a ten-second timeout. It checks an empty 65536-byte tmpfs,
allocates/writes/drops 32x32 ARGB, requires three 128x256/131072-byte requests to
return `NULL` without data access or child processes, checks recovery after each,
then requires another 32x32 allocation to succeed. This exclusive mode retains
all original exact global free-block/available/inode restoration assertions as
well as the stronger owner checks. No quota, timeout or rejection is relaxed.
Run normal mode separately
with adequate private SHM to prove the large geometry is still accepted. Missing
preconditions return `77` with `UNAVAILABLE`, not success; CTest does not mark it
as a passing skip. The pressure mode is deliberately not an ordinary CTest.

Only the authenticated Shell publisher can stage the actual mapped, fixed-size,
bottom-anchored top-layer surface on its inherited connection. Theme preparation
declares the expected target count; numeric material requests are preflighted
before commit, which rechecks owner, generation, privacy epoch, surface sequence and actual box.
Invalid or unsupported active selection preserves the committed theme/resources;
inactive catalog lookup remains pure. Missing `regionalBackdrop` retains the
legacy RGBA/opaque Dock rendering path. There is no silent alpha/solid fallback
for a requested regional effect. A live composition failure reports a Shell
error and holds the last committed output frame, retrying only after scene
changes. The new backdrop capability is **Pixman only**; GLES activation rejects
it before publication while the existing GLES rounding/shadow support is unchanged.

`desktop-scene-effects` checks the real compositor Gaussian oracle, scale/rotation,
foreground exclusion, movement, cache reuse, privacy clearing and missing-effect
whole-frame byte restoration. `desktop-regional-backdrop-native` uses the actual
Shell Dock over independently running applications and checks foreground/input,
transaction rejection and retirement. This is not DRM/hardware qualification.

### Modern taskbar and bounded optional Start recipients

Packaged Modern opts its real per-output taskbar into
`panel.taskbarBackdrop: { "sigma": 8, "tint": "#f3f3f3", "opacityPercent": 72 }`.
These are Polly design values, not Windows measurements, DWM/Mica or an official
Acrylic reproduction. This is the same current-lower-scene Pixman path described
above, not wallpaper-derived client material or foreground opacity. Missing
fields retain the original solid paint. All other packaged consumers and the
v7/schema-2/role-1 Dock contract remain unchanged.

The private appearance global advertises version 9 while still accepting version
7. Shell negotiates at most 9; the independent decorator can remain on 7 and
geometry schema 7. `shellBackdropCapability()` separately queries implemented
Shell-recipient support **and** the active renderer. An actual old v7 provider
returns false, even if its Dock capability is true. Unsupported theme selection
fails before creating replacement surfaces or changing preferences/appearance.
Public clients receive no new capability.

`prepare_shell_backdrop` uses the existing complete appearance transaction and
six numeric words: `[3, role, radiusMilliLogicalPixels, sigma, tintRGB, opacityPercent]`,
where role 2 is a stretched bottom taskbar and role 3 a focused, fixed-size Start.
The request pairs actual owned `wl_surface` objects, not titles or role strings.
Both must be mapped/presented, belong to the authenticated Shell on the same
actual output, and match their real anchors, layer, keyboard/exclusive policy,
buffer dimensions and footprint. Commit rechecks both sequences/boxes, privacy
epoch and theme generation. Start additionally requires its taskbar in that
same snapshot; one taskbar per output and one Start share the original eight-node
and aggregate 128MiB old-plus-candidate/workspace limits.

Start first maps with its original solid background and becomes transparent only
after a successful whole-set native transaction. Close/reopen, peer destruction,
output changes, focus/shape invalidation and lock retire the relevant recipient,
not other outputs. Since-8 retirement notifications carry the installing serial
and exact target ordinal; native state keeps only numeric identities after the
call, not a Window or raw surface. Late old-serial notifications cannot alter a
new menu, and rejected pending transactions do not erase the applied identity.
Foreground, input, slots, hitboxes and menu keyboard behavior do not change.
Material failures are independent of business errors and are not retried in a
timer loop; live composition failure retains the last output frame.

Both the v7
Dock and v8 paired Shell recipient policies explicitly retain a 4096x512 logical
footprint limit, separately from effects4's generic 4096x768 primitive. The newer
SDK does not grant Start or other overlays additional authority. Modern's unchanged
660px menu token produces a real 640px menu on a 720px output, so packaged Start
does **not** set `startBackdrop` and remains solid without an expected error on
each open. A custom Modern theme may optionally set `panel.startBackdrop` with
the same strict sigma/tint/opacity fields, only with `taskbarBackdrop` present.
An actual footprint above 512 is explicitly rejected, keeps Start solid and
preserves committed taskbars. A naturally shorter real output, e.g. height 540
and unchanged 460px menu sizing, can use this bounded opt-in. That limited positive
case is not qualification of the standard 640/660px menu.

**Standard-height Start is a separate explicit correctness opt-in, not a default
or real-time guarantee.** A custom theme can add `"standardHeight": true` inside
`panel.startBackdrop`. This strict optional boolean selects schema 4 / role 3 and
the independent appearance-v9 `startBackdropCapability()` /
`prepare_start_backdrop` pair, admitting the entire actual Start up to 4096x768.
Absent or false keeps the original v8/schema3 request and 512 limit, even on a v9
provider. Taskbars always use v8/schema3. An old v8 provider reports the new
capability false; explicit opt-in is rejected before replacing surfaces,
committing appearance, changing foreground or saving preferences. Public JSON
stays schema 1 and numeric geometry stays schema 7. Both builtin and fallback
catalogs omit the opt-in and keep packaged Start solid.

The standard path reuses the same menu, placement, search, scroll, input and
solid-first/clear-after-commit transaction. The unchanged 660px layout token
produces actual 640px on 1280x720 and actual 660px when output height permits.
Ownership, paired taskbar, current mapped/presented buffers, sequences, privacy,
retirement, eight-target and shared 128MiB limits are unchanged. Resource refusal
leaves Start solid and previously committed taskbars intact with a visible
independent material error, without timer retry. The unchanged exact filter can
take substantially longer than a 16.7ms frame for these extents; correctness
does not qualify 60Hz, interactive budgets, a default change or full E22 completion.
No SDK/kernel/algorithm, surface geometry, resource quotas or deadlines change.
GLES new blur and physical/GPU qualification remain unsupported/unclaimed.

`desktop-shell-regional-backdrop-native` extends the original native lifecycle
fixture: actual two-output taskbars and a naturally bounded production Start over
moving applications, unchanged opaque foreground/input, real pointer/Tab/Enter,
strict pair/transaction rejection, precise stale retirement, budget and privacy
boundaries, plus the standard-height solid rejection. It does not close E22 or
claim Windows-reference pixel equivalence.

## Desktop application shortcuts

The desktop starts empty. Open **Polly > Applications** and choose **Add to
desktop** beside an available application. Adding the same catalog ID again is
idempotent, including across outputs. **Remove shortcut** in Applications or
**Remove selected shortcuts** in the desktop context menu only removes the
shortcut; it never uninstalls an app or touches an application's files.
Right-clicking the wallpaper still offers **System Settings**, alongside
**Add from Applications** and **Sort by name and align to grid**.

Click an icon to select it; double-click or Enter opens it through the existing
catalog launcher. Ctrl-click toggles a shortcut; Shift-click selects a range in
stable row-major grid order, and Ctrl+Shift adds that range. Drag the left button
on empty wallpaper to draw a translucent bounding-box marquee; Ctrl-marquee
toggles hits and Shift-marquee adds hits. Empty unmodified clicks clear selection.
Ctrl+A selects visible shortcuts on that output. Arrow keys/Home/End move focus,
Shift extends a range, Ctrl moves focus without changing selection, and Space
selects/toggles the focused icon. Enter opens only the focused selected shortcut,
not every selected application. Context Menu or Shift+F10 opens shortcut actions.
Escape cancels a held interaction and restores its original selection/positions,
or clears idle selection.

Drag a selected icon to move the selected group, preserving relative positions
on a collision-free 96-by-104 logical-pixel grid. Movement starts at the same
four-logical-pixel axis threshold as GUI clicks. Placement is saved only on a
real release; capture/focus loss, session lock, output retirement, opening a
Shell menu and shutdown cancel the held interaction. Pre-publication save failure
restores the previous layout and shows an error; published-but-not-confirmed
durability is reported without pretending rollback. Shell clock/status repaints
retain the document's selection, focus and active capture.

Icons live on each existing **background** surface, not a fullscreen overlay.
Background keyboard focus is on-demand and does not intercept covered apps or
the session lock. The shortcuts are shared across the manually synchronized
workspaces, while selection/capture belong to one output document. Dragging is
output-local, not a simulated global/cross-output capture. DPI, panel/Dock
reservations and small outputs constrain placement; excess shortcuts remain
saved and can be removed from the context menu's complete list. Disconnected
display pins temporarily appear on a surviving output and retain their original
home until moved/sorted.

Managed bundles with registered PNG/JPEG `manifest.icon` resources, and
desktop entries with an absolute PNG/JPEG `Icon` path, use the existing bounded
native Bitmap decoder. Their decoded artwork is released on
unpin, catalog object change or Shell shutdown; loading errors explicitly show
that original fallback artwork is being used. Desktop-entry icon names do not
yet have a freedesktop icon-theme resolver. Settings/folder/general application
fallbacks reuse Polly's original rectangle/line artwork, not downloaded or
platform-owned icons. Uninstalled/unavailable apps retain an explicitly labelled
shortcut and cannot launch a stale command. Labels use current catalog names;
the saved label is only a snapshot for a missing entry.

Packaged Files, Settings, Processes and File Text include original 64px Polly
PNG tiles in `share/icons/hicolor/64x64/apps`. Their desktop entries are
configured with the installation data prefix and declare `X-Polly-AppId` to
match the real launcher identity. The same registered artwork serves desktop
shortcuts, application menus and running taskbar/Dock groups. This is explicit
registration, not a title, executable-name or desktop-file-suffix guess; an
ambiguous runtime identity keeps the fallback instead of choosing arbitrarily.
Managed bundles use the already-validated manifest ID for this association.

Classic/XP Start headers receive one immutable local display profile at production
startup, using real uid/euid and a bounded, identity-checked local passwd record.
They show the display name and actual username/UID, or explicit unavailable
labels; the original generic avatar remains. This readonly metadata grants no
authentication/account-management authority and never guesses from environment
variables. Legacy callers without a profile retain the PollyDesktop brand.
See [the Shell contract](shell/README.md#local-session-display-profile).

The artwork source is `tools/generate-application-icons.mjs`, using only native
rectangles and gradients, with no downloaded or platform-owned assets. To
regenerate from the repository root with the existing playground, set
`PU_RENDERER=raster`, `PU_TEST_W=64`, `PU_TEST_H=64` and run
`pollyui-playground --test desktop/tools/generate-application-icons.mjs`.
The checked-in PNGs are installed directly; regeneration is not a runtime or
release dependency.

The [v4 Shell configuration](./SHELL-CONFIGURATION.md) preserves existing
theme/audio/display/workspace/keyboard/desktop preferences and atomically migrates
v1/v2/v3 profiles. Taskbar/Dock pins are independent of desktop shortcuts; returning
to an older Shell requires a configuration version it understands.
This feature is PollyOS Shell behavior, not Windows Explorer/macOS replacement,
a desktop filesystem, cross-app drag-and-drop, animation, or an accessibility
system bridge. The icon list exposes option/multiselect semantics and roving
focus within the existing native DOM.

Direct fixtures:

```powershell
node --test desktop\tests\desktop-shortcuts.mjs desktop\tests\configuration.mjs desktop\tests\menu-host.mjs
```

On a private ordinary-user Linux fixture, run
`sh desktop/tests/desktop-shortcuts-native.sh DRIVER POLLYUI LOCK_FIXTURE EVIDENCE_DIR`
with the existing `pollyui-layer-client-test`, production `pollyui`, and
`polly-lock-test-client` binaries. It uses two headless PollyWM outputs, actual
seat pointer/keyboard events, dedicated spawned fixture apps and session-lock
protocol input isolation; it is not a hardware/DPI/Windows qualification matrix.
The runner also checks hover/selection pixels, numeric marquee blending,
simultaneous 1.25/1.5 logical-output scaling, shortcut removal and process reload,
and uses original managed-catalog bitmap fixtures to verify pin/unpin/replacement
and teardown ownership. The catalog artwork fixture is not an application
installation or managed-registry integrity qualification.

The user reported successful first-target physical validation of Alpine alpha.4
on 2026-10-06; this is not a comprehensive hardware matrix or independent
per-GPU acceleration measurement. The next base is **Debian 13 trixie amd64,
built from a debootstrap minbase rootfs**, not a GNOME/KDE Live image or a
bootable use of the slim container image. Debian minbase, glibc runtime and
systemd/logind Live candidates are implemented. The corrected Mesa build now
passes the Debian graphical sanitizer gate. On 2026-10-07 the user also confirmed
that Debian alpha.5-r2 boots and runs on physical hardware. This is a basic
boot/runtime result, not per-GPU, network, audio or endurance qualification.
Maintenance automation is not enabled.
The Alpine build remains a preserved user-verified fallback;
see [base selection and maintenance plan](../docs/desktop-base-maintenance.md)
for version pinning, upstream synchronization, acceptance and rollback policy,
and [Debian build status](./release/debian/README.md) for commands and known gaps.

## Architecture and implementation plan

The [product boundary conclusions](../DESIGN.md#11-product-and-module-boundaries)
defines PollyUI, PollySystemRT and PollyOS ownership. Legacy Linux native
integration now lives in `native/`, outside the GUI engine; this is a source
boundary, not a claim that its remaining QuickJS/policy coupling is resolved.
The ordinary filesystem core lives in `../sysrt/providers/linux/`, with its
unchanged v1 binding in `../sysrt/projection/quickjs/`.

Keep three boundaries:

- `compositor/`: PollyWM owns outputs, seats, window geometry, focus and
  composition. wlroots supplies device/rendering/protocol infrastructure.
- `shell/`: shared appearance presets, the native multi-surface PollyShell and
  a separate simulated appearance preview. The real shell runs in its own
  process; a shell crash must not terminate other applications.
- Session/system integration: native application launching, private D-Bus session and notifications; future system services,
  permissions, persistence and distribution packaging.

Local managed application bundles can now be installed from a directory/tar/zip
using the ordinary-user `polly-app` tool and launched through the Apps catalog.
Program objects, registration and AppData are separate; explicit replacement and
rollback preserve data and reject changed data-schema contracts. Removal retires
registration but intentionally retains code caches and data. See
[managed applications](./APPLICATIONS.md) for commands, bounds and remaining work.
The separate [D1 installed-development image](./release/debian/README.md#installed-development-virtual-disk-d1)
adds a user-approved GPT/EFI + ext4 A/B + required `/home` layout for disposable
virtual disks. It does not select or write physical media, implement system
updates, or change the memory-only Live image.
The current builder's separate console-account follow-up adds local
`polly`/root setup, default password login, once-per-boot optional autologin,
standard password changes and everyday `su -`; see
[installed console accounts](./release/debian/README.md#installed-console-accounts-development-follow-up).
Integrated graphical login/administration and locking remain incomplete.
The alpha.5 code line adds managed applications, authoritative startup/runtime
service status and explicit release-input tooling. The latest Debian alpha.5-r2
ISO/USB includes the Mesa lifetime correction and passes 4 GiB UEFI VM preflight.
It remains a memory-only development candidate; the earlier Alpine alpha.4
physical baseline and Debian alpha.4-r1 boot media remain separate preserved
artifacts, not silently upgraded installations.

Caption text in all six themes uses the shared GUI Canvas2D renderer. Its
sanitized title remains capped at 512 code points; Linux ICU boundaries move
that cap down to a complete grapheme and keep measured prefix-plus-ellipsis
fitting from splitting combining sequences, emoji ZWJ sequences or flags.
Empty or too-narrow text boxes draw no extra ellipsis. Other platforms retain
the SDK's existing code-point fallback, not a newly qualified grapheme backend.

Custom theme `window.fontFamily` accepts the existing `sans-serif`, `serif` and
`monospace` defaults or a single literal installed family such as `DejaVu Sans`.
Names are bounded to 128 UTF-16 units and allow letters, combining marks,
numbers, spaces and common name punctuation (`.`, `_`, `-`, parentheses and
internal apostrophes). Controls, URLs, paths, quoted names, comma-separated
lists and font-resource declarations are rejected. This setting accepts no
font-file path and downloads no font. GUI system-font matching chooses the family;
a missing family follows the existing backend fallback and is not certified
as installed. Builtin/recovery themes and public theme version 1 are unchanged.
Focused checks are `node --test desktop/tests/caption-font-contract.mjs` and
Linux `PU_RENDERER=raster pollyui --test desktop/tests/caption-text-render.mjs`;
the latter requires the native ICU/Canvas runtime.

The compositor does not link QuickJS, Yoga, Skia or SDL. The generic PollyUI
engine must not depend on the desktop. Use wlroots' scene graph for external
applications rather than importing their buffers into the PollyUI DOM.

| Stage | Scope and acceptance gate |
|---|---|
| 1 - implemented here | Standalone compositor, two real xdg-shell clients, rendering/frame callbacks, focus, move/resize, close, lifecycle and nested WSLg execution. |
| 2a - implemented here | Maximize/fullscreen/restore, output-aware placement and migration, logical output geometry, and popup constraints. Independent clients exercise delayed/skipped configures, nested menus and simulated output changes. |
| 2b - remaining window policy | Tiling/overview, advanced window rules and real-hardware hotplug qualification. |
| Display settings - implemented | Native resolution/refresh, scaling, rotation, placement and enable/disable controls; confirmed layout persistence with exact-identity startup restoration; compositor-owned keep/revert watchdog with Shell-loss/topology recovery. |
| Clipboard and pointer drag transport | Native UTF-8/MIME clipboard, primary selection, validated Wayland pointer drags and icons, cancellation/focus recovery, and incoming PollyUI text/file drops. PollyUI outgoing drag-source and full DataTransfer APIs remain deferred. |
| Native input method | Separately trusted Rime service, public text-input-v3 relay, compositor-positioned PollyUI candidates, inline preedit, click-to-commit, cancellation, sensitive-field isolation and service-loss typing recovery. |
| Linux Unicode text | HarfBuzz shaping, ICU bidi and grapheme/line boundaries, shared measurement/drawing, whole-grapheme editor movement/deletion, RTL hit testing and selection. Shared JS caption text uses GUI Canvas measurement/drawing and ICU-safe truncation. |
| Session bus and notifications | Owned private D-Bus daemon per development session; validated app inheritance, bus-loss cleanup, standard notifications with native themed toasts/center/actions and bounded sender-owned state. |
| Status tray | Sender-owned asynchronous StatusNotifier watcher/host, native memory icons, status changes, pointer/scroll actions and themed DBusMenu submenus with stale/disabled-action protection. Icon-name-only items use labels; legacy XEmbed remains deferred. |
| Wi-Fi client | Native iwd settings for discovery/RSSI, scanning, radio power, connection, bounded interactive authentication and forgetting profiles, with root-owner verification and service-restart recovery. Isolated protocol/UI fixtures pass; real radios and DHCP/DNS need hardware qualification. |
| Audio policy and controls | Opt-in private PipeWire core, own routing/default-device policy, acknowledged volume/mute/device preference persistence and validated socket connection, without WirePlumber. Real virtual playback/capture, manual routing and device-loss coverage; physical audio and Pulse/ALSA client compatibility remain separate. |
| Workspaces - implemented | Four first-run, globally synchronized manual workspaces; create/switch/remove/rename/reorder, safe window-family migration, current-workspace taskbar/Dock filtering and keyboard switching. Names/order/current selection persist across sessions; Shell reconnect preserves live state. Empty workspaces remain. |
| Switcher and shortcuts - implemented | Native recent-use window list with forward/reverse cycling, cancellation and release/click acceptance; editable, conflict-checked, disableable shortcuts with restart persistence. |
| Window decorations - implemented | Negotiated server-side titlebars/borders, title text, controls, drag/resize, maximize/fullscreen geometry and live five-theme integration, while honoring client-side decoration requests. |
| Appearance - implemented preview | Switchable XP, Server 2003 Classic, OS X Aqua, Lion and Big Sur-inspired original themes. The preview remains simulated; the native Shell and negotiated PollyWM frames reuse the same tokens. |
| Linux runtime - raster/GLES milestone | Native Alpine/musl Skia build, Fontconfig/FreeType fonts, SDL3 EGL/GLES with explicit raster fallback and runtime error handling. Software GL is validated; physical GPU acceleration is not yet qualified. |
| Runtime services - implemented | Linux HTTP/HTTPS with certificate checks, XDG app namespaces, atomic storage and joined request/worker/task shutdown. No sandbox, secret store or full browser Fetch API is implied. |
| CI - definitions and local checks | Alpine ordinary/sanitizer builds with real clients on headless PollyWM, Windows core/WinHTTP and macOS raster jobs. Hosted execution requires pushing the workflow; local Linux/Windows results do not verify macOS. |
| Shell boundary and development session | Optional explicitly spawned shell with a private Wayland connection, bounded opt-in restart/backoff, and an isolated session launcher. Login, authentication and production session policy remain separate. |
| 3a - compositor layer-shell | Four layers, committed placement, exclusive work areas, keyboard modes, per-output lifecycle and nested popups. Real protocol clients exercise rendering and shell-crash isolation. |
| 3b - PollyUI layer host | Native layer roles on a shared trusted connection, output selection, raster/GLES rendering, input, fractional scaling and output-loss cleanup. Actual native clients cover these paths. |
| 3c - native development PollyShell | Real per-output wallpaper, taskbar/menu bar, floating Dock, appearance/about overlays, searchable native application launcher, live window buttons/actions and persistent five-theme selection. System services remain separate steps. |
| Multi-window runtime - implemented | A shared JS realm with per-window documents, input, rendering and close lifecycle. PollyShell can own multiple native surfaces without creating a process per surface. |
| 4 - usable session | Outgoing PollyUI drags, advanced text, power and remaining audio/network integration, secure session lock, restricted management commands where standard protocols are insufficient. |
| Runtime packaging | Relocatable Alpine/musl and Debian/glibc x86_64 runtimes, private patched SDL, pinned runtime packages, dependency inventory, licenses and SHA-256 checksums. Debian records the locally corrected Mesa DEBs separately from official archive binaries. Runtime bundles are not bootable media. |
| UEFI Live development image | Memory-only root; current Debian/systemd/PAM/logind candidate and preserved Alpine/OpenRC/PAM/elogind baseline. Temporary ordinary-user automatic login, target kernel/firmware, optical ISO and GPT/FAT32 USB image. Debian alpha.5-r2 passes VM preflight and user-reported physical boot/basic operation; per-device qualification remains separate. No installer, protected login, enabled secure lock or signing trust. |
| Authentication and lock mechanism | Ordinary-user PAM helper, separately trusted standard session-lock client, native password UI and crash/output-loss black-cover protection. Real masked typing/PAM unlock verified; protected-session/power integration remains incomplete and the passwordless Live keeps locking disabled. See `SESSION.md`. |
| Basic power controls - approved source policy | Normal application-close/Save/Cancel flow and actual login1 capability checks; new Debian Live/installed recipes pin standard polkitd with basic poweroff/reboot restricted to active local polly. Old media retain denial; new guest power acceptance is separate. No custom root proxy or pkexec/GUI agent; suspend/hibernate remain unavailable. See `SESSION.md`. |
| 5 - persistent system | D1 A/B persistence is historical evidence. P0 targets a writable single system, early `/usr` mapping, classified state/shared Apps and independent recovery; new-layout implementation/acceptance, physical installer and production trust remain incomplete. |

Prefer standard Wayland protocols. Workspaces/window management may later
require a narrowly scoped private protocol or socket, with an explicit trust
boundary. **There is no custom management socket or test-control protocol in
the production compositor.** Virtual-keyboard access is limited to the
separately spawned input-method connection, not public applications or the Shell.

### Trusted shell connection

`pollywm --shell PROGRAM [ARG...]` starts exactly the chosen executable without
an intermediate command shell. This must be the last compositor option; later
arguments belong to the child. Nothing is started implicitly. For example,
with a private runtime directory and backend configured as below:

```sh
./build/desktop/pollywm --socket pollywm-0 --shell \
    ./build/linux-sdl/pollyui --app-id org.pollyui.shell desktop/shell/preview.mjs
```

This still displays the **simulated preview**, not an actual panel. PollyWM
passes one socketpair endpoint as `WAYLAND_SOCKET=3`, and sets the child's
`WAYLAND_DISPLAY` to its own public socket instead of the parent compositor.
Only that exact live `wl_client` receives reserved shell globals. The
`zwlr_layer_shell_v1` version 4 global is filtered on both advertisement and
binding. Fixtures verify that guessing a known global ID does not bypass the
filter; ordinary xdg clients do not receive layer-shell privilege.
The standard `zwlr_foreign_toplevel_manager_v1` window-management global is
restricted to that same live shell connection. Public clients cannot enumerate
or control other windows through it, even when they know its global ID.
`polly_appearance_v1` is similarly restricted: v1 selects a known decoration
theme; v2 validates and commits bounded runtime decoration snapshots. Its
read-only companion, `polly_theme_manager_v1`, is public but grants no management
or filesystem access. Neither is a general window-management socket,
input-injection interface or arbitrary rendering API.
Workspace globals `ext_workspace_manager_v1` and
`polly_workspace_toplevel_manager_v1` have the same connection-bound restriction.
The standard protocol handles workspace operations; the private extension only
adds window membership and moves that the standard protocol does not provide.
`polly_shortcuts_v1` uses the same boundary for a fixed action catalog and
switcher presentation. It cannot run arbitrary command strings, and recording
suppression is only effective while a trusted Shell layer has keyboard focus.
`zwlr_output_manager_v1` and `polly_output_guard_v1` are also restricted. The
first carries standard output state/configuration; the second confirms or
reverts the current provisional transaction. Ordinary clients still receive
read-only `xdg-output` logical geometry.

Trust is **not** derived from UID, PID, `app_id`, executable name, or arbitrary
environment values. Even a new public connection from the shell's own process
has no shell privilege. libwayland consumes/unsets `WAYLAND_SOCKET` and marks
its connected descriptor close-on-exec. Shell code must use that connection for
its privileged surfaces; it must not deliberately copy the descriptor or
`WAYLAND_SOCKET` into launched applications. New application processes use the
public `WAYLAND_DISPLAY` connection.

On disconnect or shell process exit, the capability is revoked. Existing
ordinary windows retain their geometry, focus and connections. A nonzero exit
is reported without stopping PollyWM; initial exec failure instead fails
startup. The compositor reaps only its own shell child. Shutdown disconnects it,
tries SIGTERM, then escalates to SIGKILL after a bounded grace period. Child
signal masks are reset rather than inheriting the compositor's blocked signals.
Plain `--shell` still does not respawn automatically. `--shell-restarts N`
explicitly allows at most N additional attempts after nonzero exit or a signal,
with exponential backoff from 100 ms to 1600 ms. The lifetime budget is not reset
automatically. Normal exit status zero is never retried; exhausting the budget
leaves ordinary applications running and logs the failure. A new connection is
created for every attempt. Pending restarts are cancelled on shutdown.

`--exit-with-shell` additionally terminates PollyWM when the shell exits normally.
It does not terminate the session on a shell crash. Use this only when the shell's
normal exit is intended to end the session: remaining clients will disconnect.
The separate opt-in `--exit-on-shell-failure` returns a failed session after the
restart budget is exhausted; it never ends a locked session. Installed diagnostic
checks enable this option with no restart allowance so an observed failure returns
nonzero instead of leaving an empty compositor until the outer timeout. Ordinary
sessions keep their existing preserve-applications behavior.
There is no process-tree supervisor, login/authentication service, or production
logout/save protocol yet.

This is a compositor protocol boundary, **not an OS sandbox**: hostile processes
with ptrace/root access, a compromised trusted shell, or deliberate capability
delegation are outside it. Future privileged protocols must extend this filter
and validate the ownership and arguments of their requests. No management
protocol is promised by reserving a connection.

## Display configuration

The native **Appearance > Displays** panel changes real output state. It offers
advertised/custom resolutions, refresh rate, scale, rotation, logical placement
and enable/disable controls. Native fields are owned by the panel's document;
they do not use the original application's document accidentally.

Every apply is backend-tested and requires all current heads. Disabling every
output, stale snapshots and invalid geometry are rejected. Successful changes
remain provisional for 15 seconds; Keep/Revert and Enter/Escape decide the result.
The saved state and timer are in PollyWM, so a frozen or crashed Shell cannot
leave an unconfirmed setting indefinitely. Output loss aborts confirmation and
restores surviving outputs where possible. A failed recovery is an explicit
error, not a claim that the previous state was restored.

Logical geometry is advertised through `xdg-output`, which is necessary for
SDL clients to agree with fractional scales and output positions. Temporarily
disabled outputs regain their compositor work-area owner when re-enabled.
PollyShell saves the last confirmed display combination in its own validated
JSON preferences. Startup restoration requires exact connector/make/model/serial
matching and unambiguous hardware identities; missing or replaced displays retain
safe defaults. A differing layout still needs 15-second confirmation, while an
unchanged layout does nothing. A compositor-owned one-shot startup claim prevents
Shell reconnect from retrying rejected profiles. Corrupt data is reported and
preserved, and Forget saved layout changes no live outputs. This does not add
disk persistence to the Live image or automatically switch profiles on hotplug.
Physical GPU/DRM and HDR/VRR support still require dedicated hardware qualification.

## Server-side window decorations

PollyWM supports `zxdg_decoration_manager_v1` and prefers server-side decoration
when a negotiating client has no explicit preference. Explicit client-side
requests are honored. A client which does not implement this protocol retains
its own header; PollyWM does not guess whether an application has painted one
or place a second titlebar over it.

The existing GUI renders caption text, active/inactive titlebars, borders and
minimize/maximize/close controls into detached Canvas2D strips. The compositor
composes complete snapshots and owns input. Titlebar double-click toggles maximize; drag
moves floating windows and edges/corners resize them. Releases outside the
pressed control cancel the action. Fullscreen hides the frame, and maximized
client geometry excludes both Shell reservations and decoration extents.
Negotiation and client-size changes use the normal configure/ack/commit
path, so an older client buffer does not acquire a newer frame layout.
Position and theme-only changes with unchanged client size, mode and decoration
negotiation reuse the presented buffer. An idle client need not redraw before
its titlebar can move or resize. Outstanding size changes still require the
latest matching commit, including when a theme refresh arrives while resizing.

Shell appearance selection sends validated JSON and a JS-compiled geometry
array through its private paired v4 publisher connection. A separate windowless
PollyUI decorator services bounded GUI render requests over its own private
renderer connection, using the same logical rectangles as WM hit testing. Four
immutable pixel strips and their revision/generation/scale/state are validated
and atomically staged, never mixed individually with a previous frame.
Custom IDs and same-ID edits apply without rebuilding the compositor.
There is no legacy theme-ID selection or automatic schema downgrade.
Generated test fixtures contain preset geometry; the WM contains no preset
catalog. Generated schema fields keep native bounds consistent with the JS
layout compiler. Mixed old private versions fail
explicitly. Public theme JSON and application APIs are unchanged.

Caption rasterization and text shaping reuse GUI Canvas2D, with no hidden
caption window. The WM's separate theme painters, FreeType/Fontconfig face cache
and direct font dependencies are removed. Skia/SDL/QuickJS/Yoga are not embedded
in PollyWM. Shell exit leaves the independent renderer and current theme alive.
A renderer failure retains complete presented frames while new geometry waits;
bounded restart reissues fresh revisions rather than stretching old pixels or
assuming the client can draw missing decorations. Failure is explicit when
recovery is exhausted, with no second C painter. Bare WM operation without the
service remains a separate, unqualified CSD fallback. See [the ownership and bounded
frame contract](THEMES.md#decoration-execution-boundary).
Painting through the GUI does not itself add accessible DOM controls to native
captions; platform caption accessibility integration is still a separate gap.
The current frames have rounded titlebar tops, not rounded clipping of client
content, blur or shadows. Input bounds remain rectangular. Restore a maximized
or half-screen window by dragging its native title; basic drag-edge release is
described below. Client move/resize requests still require floating placement.

## Appearance direction and native preview

The native entry is `shell/main.mjs`. Run it through the development session
launcher shown below. `shell/shell.mjs` owns the live surface set; `shell/views.mjs`
renders its controls, reusing the preview's original wallpaper artwork and
immutable theme tokens. The following preview documentation describes the
separate `shell/preview.mjs`, not the native Shell.

The desktop will offer multiple selectable appearances rather than hard-code a
single era. Appearance is separate from window-management policy: the compositor
remains floating, and no workspace/tiling policy was selected by choosing these
visual styles.

| Theme ID | Inspiration | Current visual treatment |
|---|---|---|
| `xp` | Windows XP / Luna | Blue rounded frames, green launcher, soft controls, original vector hills |
| `server2003` | Windows Server 2003 / Classic | Square gray frames, configurable blue title gradient, beveled buttons, solid desktop |
| `aqua` | OS X / Aqua | Pinstriped chrome, glossy pill controls, left-side circular captions, menu bar and dock |
| `lion` | OS X / Lion | Gray chrome, graphite woven-grid background, left-side captions, compact gray dock |
| `bigsur` | macOS / Big Sur | Larger rounded frames, unified light title/toolbar, blue accents, rounded-square dock tiles and original colorful bands |

`shell/themes.mjs` loads deeply immutable data from `themes/builtin.json`.
Every preset has the same desktop, color, window, icon, button, panel and layout groups.
`getDesktopTheme(id)` rejects unknown IDs rather than silently choosing a
different appearance. The Server 2003 preset intentionally represents its
Classic look, not another Luna color variant.

User JSON themes, limited overrides, local PNG/JPEG wallpaper resources,
explicit reload/restore and opt-in application subscriptions are described in
**[Runtime desktop themes](./THEMES.md)**. Layout and wallpaper parameters are
data-driven; configuration still cannot alter window-management behavior.

`shell/appearance.mjs` draws the preview using the **actual PollyUI reconciler
and native renderer**, not browser HTML or screenshots of another desktop.
The theme picker and launcher menu work with pointer, Enter and Space.
Minimize/maximize/close/reopen operate on the **sample window inside the
preview**; folder and sample-action controls update local demo state only.
Switching themes preserves this state. The outer native window keeps its
normal host decorations.

The window-frame, taskbar/dock and menu designs are original implementations
inspired by these eras. No Microsoft/Apple logos, wallpaper photographs, OS
fonts, copied assets or system binaries are bundled. Aqua and Big Sur's glass-like gradients
are opaque drawing, not compositor transparency/blur. The preview is explicitly
labeled **SIMULATED SHELL**; it does not launch applications, modify files or
OS settings, provide real window decorations, or manage PollyWM's other windows.
Theme selection currently lasts for the preview process only.
Big Sur's simulated preview provides the light appearance; it does not exercise
the production Shell's opt-in Pixman regional backdrop. A dark variant is absent. The larger floating
dock has reserved space in both normal and maximized sample-window layouts.

Run from the repository root with an already built PollyUI runtime:

```powershell
.\build\win-clang\pollyui.exe .\desktop\shell\preview.mjs

# Native rendering, layout, input and pixel assertions; failures exit nonzero:
.\build\win-clang\pollyui.exe --test .\desktop\tests\desktop-appearance.mjs
```

The existing root README describes the Windows/macOS runtime build. If Skia
has not been fetched, use `tools/fetch_skia.ps1` before `tools/build.ps1`.
The same `.mjs` entry is portable to the macOS and Linux runtimes. Linux now has
a separate native raster-runtime image; the compositor-only image does not
include PollyUI. See the root README's Linux build instructions or run:

```powershell
.\desktop\tools\test-linux-runtime.ps1 -Nested
```

This runs the actual PollyUI appearance code under WSLg and then PollyWM.
Linux has a Skia GLES path and structured input with separate text commits;
The native Shell uses separate layer windows rather than embedding this preview
as its desktop. IME preedit now has a separate native service and editor path.

The appearance test saves `build/appearance-<id>-<width>x<height>.png` for each
theme. It covers token shape/immutability, native layout and color rendering,
caption positions, menus, keyboard activation, preview window lifecycle,
state-preserving theme switches and mount/unmount. Use `PU_TEST_W` and
`PU_TEST_H` for different viewports; 640x480 is the preview's minimum target.
These appearance tests run separately from the WSL compositor suite.

The real Shell now has running-window buttons and a shared decoration policy.
Window-manager state remains owned by PollyWM; theme code must not become an
alternate window manager.

## Implemented behavior

- xdg-shell toplevels and parented popups; wl_shm clients and wlroots rendering.
- Viewporter and fractional-scale globals, with wlroots scene-managed preferred
  scale notifications for native clients.
- Click-to-focus and raise; activation and keyboard/pointer event forwarding,
  including implicit pointer grabs for drags outside a window.
- Cascaded initial placement on the output nearest the pointer, with the window
  origin kept accessible on small displays; interactive move/resize and client min/max sizes.
  Top/left resize anchors use the geometry actually committed by the client.
- Maximize/fullscreen and restore, including requests before the initial map.
  Floating geometry survives repeated state changes and fullscreen over maximized
  windows. Restoring floating mode uses the saved geometry's nearest live output;
  leaving fullscreen while still maximized fills the current output.
- Placement follows configure acknowledgement **and buffer commit**, not merely
  the request. Late buffers do not receive newer positions. Smaller fullscreen
  content is centered over an opaque black backdrop, and content is clipped to
  its output in fullscreen/maximized mode (including client-side shadows).
- Existing windows select the output with the greatest overlap (nearest output
  if offscreen). Fullscreen honors an explicit live output requested by the client.
  Output mode, scale, transform, disable and removal update affected placements.
  Windows migrate to an enabled output when their target disappears, including
  configured windows that have not mapped yet.
- Popups and nested menus honor positioner constraint adjustments at creation
  and reposition. Reactive popups are reconstrained when parent/output geometry
  changes; non-reactive popups retain their requested parent-relative placement.
- Client-side move/resize requests require a matching seat, client and pointer
  grab serial. Forged, cross-client and expired requests are ignored.
- Focus falls back to another mapped window on unmap, close or disconnect.
- Real minimized state hides a mapped window without destroying its surface or
  saved maximize/fullscreen geometry. Focus falls back only to visible windows;
  Alt+Tab restores its selected window, including when every window is minimized.
  Minimize dismisses existing popups and rejects new popups from a minimized
  parent. Clients may request minimization before their initial map.
- Shell-only foreign-toplevel handles expose live titles/app IDs, state, parent
  handles and output membership. Activate restores and focuses through the real
  seat; minimize/restore, maximize/fullscreen and close use the compositor's normal
  policy. Unmapping destroys the handle; close requests do not forcibly kill apps.
- Basic selection forwarding through `wl_data_device_manager`.
- XKB keymaps (standard `XKB_DEFAULT_*` environment settings), input-device
  lifecycle, frame scheduling via wlroots, signal-driven clean shutdown.
- Auto-selected wlroots backends; tested with headless and nested Wayland using
  the Pixman software renderer. No Skia GPU support is implied by these results.

| Binding | Action |
|---|---|
| Alt + left-button drag | Move the window |
| Alt + right-button drag | Resize from the bottom-right |
| Alt + Tab / Alt + Shift + Tab | Preview next/previous window; release Alt to activate |
| Ctrl + Super + Left / Right | Switch to previous/next workspace without wrapping |
| Super + Left / Right | Tile the focused window into the left/right half of its current work area |
| Super + Down | Restore a tiled window's original floating position and size |
| Alt + F4 | Ask the focused client to close |
| Alt + F9 | Minimize the focused window |
| Alt + F10 | Toggle maximize |
| Alt + F11 | Toggle fullscreen |
| Alt + Escape | Exit PollyWM |

Alt+Tab is scoped to the current workspace, including restoration of minimized
windows there. Inactive workspaces do not receive pointer/keyboard input.
The real Shell displays a recent-use picker without activating previews.
Escape cancels it, and clicking a row accepts it. Standalone PollyWM without
an opted-in Shell presenter retains immediate switching. The picker uses text
labels rather than live window thumbnails, and appears on the first display.

**Settings > Keyboard** records, disables and resets the ten
window/workspace bindings above, except the fixed development exit.
Conflicting bindings are rejected as a whole, including collisions with reverse
window switching. Preferences survive a full compositor restart through the
Shell's app-scoped storage. Binding-recording mode and picker cancellation do
not invoke the Alt+Escape session exit. Configuration v4 migrates the original
seven bindings without changing user chords; a conflicting new default is
Disabled with a once-only migration diagnostic. The private shortcut interface
requires paired version 2 binaries.

Half-screen tiling is native configure/ACK/buffer/frame-fenced geometry, not a
Shell transform. It partitions the actual output work area before insetting
server decorations, including layer-exclusive panel and Dock reservations.
An odd width gives the right half the remaining pixel. Repeating a side or
switching sides does not replace the original floating restore box. Maximize
and tile entry retain the last frame-presented floating size, not a newer client
buffer still waiting on the decorator; interactive scene moves retain their
actual position and completed resizes update that presented fact. Maximize
and fullscreen retain the tile underneath; leaving them returns to that tile.
Super+Down restores floating, never minimizes. Fullscreen must first be exited.
Client min/max/fixed-size constraints that cannot fit an exact half are refused
with a diagnostic and no geometry/state mutation. If a later output/work-area
change makes a tile impossible, it explicitly returns to constrained floating
geometry instead of pretending to fit. Output removal restores against a live
output, not a retained output pointer. Lock, workspace, focus, trusted recording
and seat grabs retain the existing input authority. Tiled windows use XDG tiled
edges, not maximized/fullscreen flags, and have no floating shadow/rounding.
Client move/resize requires floating placement; native-title drag-to-restore and
basic drag-edge release are described below. No Snap flyout, overview or
physical-GPU qualification is implied.
The parent desktop may intercept shortcuts in nested mode. Negotiating clients
can use PollyWM titlebars; clients requesting self-drawn headers retain them.
Maximize/fullscreen capabilities are advertised. Fullscreen must be exited before
dragging. Except for the admitted native-title restoration, interactive move/resize
is ignored in placed states or while a state/placement configure is outstanding. State requests during
an existing interactive drag end that drag. Maximized/fullscreen sizes follow the
output rather than floating min/max size hints. Floating windows whose minimum
size exceeds an output may extend beyond it, but their top-left remains reachable.
Maximized windows use the output's unreserved work area; fullscreen windows use
the full output. Without panels these bounds are identical.

### Layer-shell policy

Only the explicitly spawned trusted shell connection can create layer surfaces.
This is intentionally not permission for arbitrary same-user clients such as
third-party panel programs connected to the public socket.

- Scene order is background, bottom, ordinary windows, top, overlay. Within a
  layer, newly created or reassigned surfaces are above older ones. A focused fullscreen
  window hides top surfaces on its output; overlay surfaces remain visible.
  Switching back to an ordinary window restores that output's top surfaces.
- An omitted output selects the enabled output nearest the pointer. Explicit
  output requests are honored. Disable/removal sends `closed` and destroys the
  affected layer surfaces/popups; the shell must recreate them on a suitable
  output. Layers are not silently migrated to a different monitor.
- Positive exclusive zones are applied in overlay-to-background order, newest
  first within a layer, and only while mapped. Anchors and edge margins determine
  the reserved edge. Zone zero uses the remaining area; zone -1 uses the entire
  output. Even if zones exhaust an output, the work area retains one logical
  pixel in each dimension so xdg size hints never ambiguously become zero.
- New sizes are configured once, and placement waits for the corresponding
  configure **and buffer commit**. Old/skipped acknowledgements do not acquire a
  newer placement; a first map awaiting a newer configure stays hidden. Unmap
  releases reserved space and resets initial-configure state. Calculations use
  wide intermediates; unusable/overflowing geometry closes the surface with a
  diagnostic rather than wrapping dimensions.
- Keyboard `none` leaves application focus unchanged. `on_demand` focuses on
  pointer click. Mapped, visible top/overlay `exclusive` surfaces take priority,
  with application focus restored when they close, unmap, or relinquish focus.
  WM shortcuts other than the Alt+Escape logout-confirmation request are forwarded
  while a layer owns keyboard focus. This is **not** a secure session-lock API.
- Only a real Shell-owned transient menu with the dedicated
  `PollyShell.menu.<output>` namespace, overlay/zone -1/exclusive contract is
  dismissed on an outside caption/client press. Its existing layer-close
  lifecycle clears focus before that same press follows the normal route once.
  Other exclusive surfaces and session-lock guards are unchanged. Shell
  panel/Dock/desktop layers retain their existing DOM dismissal and opener
  toggles rather than being pre-closed by the compositor.
- Layer popups may extend outside the panel, are constrained to its output, and
  support nested/repositioned/reactive xdg popups. Layer content is clipped to
  the output separately from the popup tree. A shell crash releases its layer
  surfaces, popups, focus and reservations without destroying ordinary windows.

Layer geometry is compositor-owned policy, not a second PollyUI window manager.
The scene helper's eager placement/unconditional configure behavior is not used:
size deduplication and commit-matched placement follow the existing xdg policy.
The generic wlroots subsurface scene helper still owns buffer rendering.

The root README's **Wayland shell surfaces** section documents the native
PollyUI API. Its raster/GLES fixtures verify actual Wayland buffer dimensions and
pixels, pointer/keyboard delivery, two outputs, 125%/200% scaling, mode/rotation,
removal, reservations, role replacement and rejection on public connections.

PollyWM routes the public `wl_data_device_manager` clipboard and pointer-drag
protocol and `zwp_primary_selection_device_manager_v1` primary selection.
Drag requests require a visible origin and the owning client's current pointer
grab serial. Icons and their subsurfaces render above Shell layers without
intercepting input. Escape, source destruction, a hidden/unmapped origin,
workspace changes and output-layout changes cancel the drag. Keyboard focus is
cleared during the drag and restored on completion/cancellation. Touch drags
are not implemented. Clipboard ownership is not persisted after the source exits.

Not implemented: tiling/overview, Xwayland, full session recovery,
PollyUI outgoing drag sources, screen capture/portals, remaining advanced typography,
complete protected-session integration, full desktop services or installer.
The opt-in PAM/session-lock mechanism itself is implemented. Display settings and
guarded startup profiles are available; physical-device qualification remains.
Popup constraints follow the adjustments allowed by the client (not arbitrary
forced clipping). Multi-output/HiDPI and DRM/seat access still need real-hardware
qualification; **WSLg is not evidence of native GPU/DRM or boot readiness**.

## Native input-method service

The input-method architecture deliberately avoids GLib/GIO and desktop-toolkit
candidate windows: a custom service and PollyUI candidate UI reuse an input
engine library. The adapter is `input-method/engine.c`, using the
librime C API (`rime>=1.7`; Alpine 3.24's 1.17.0 is exercised). Its runtime
dependency closure does not include GLib/GIO, GTK, Qt, GNOME or KDE.

`-DPU_BUILD_IME_ENGINE=ON` builds `polly-ime-engine` independently of the
compositor library. The Linux runtime checker enables it; the standalone
compositor build leaves it off. The adapter accepts an absolute shared-data
directory, an existing private user-owned 0700 directory, and a schema ID from
the configured schema list. Deployment/schema errors are explicit. One owning
thread/process handles the engine; maintenance is joined before use and exit.

Snapshots copy preedit, commit and candidate text into bounded C storage and use
UTF-8 byte offsets. They carry revisions so stale candidate clicks cannot act on
changed composition. Reset discards preedit without committing; ASCII mode
returns unhandled keys for the service to forward. Learning follows
the selected Rime schema, not an invented runtime privacy option. The small
original test schema disables its user dictionary and uses isolated temporary
data; it is not a distribution dictionary or a production configuration.

`pollywm --input-method PROGRAM` explicitly starts a separate trusted process;
place this option before `--shell`. Its inherited `WAYLAND_SOCKET=3` connection
alone may bind `zwp_input_method_manager_v2` and
`zwp_virtual_keyboard_manager_v1`. It cannot bind Shell management globals;
the Shell cannot bind the IME globals. Public text-input-v3 clients receive only
their own focused input. Guessed global IDs do not bypass these checks.
An IME crash does not close applications: preedit/popups are cleared and
ordinary keyboard delivery resumes. Automatic IME restart is not implemented.

The relay validates surrounding-text offsets and output bounds, rejects stale
commits, and requires a valid commit in the current focus epoch before accepting
virtual-keyboard forwarding. Background text-input requests do not invalidate
the active context. Forwarded held keys are released when an input session
changes. Password, PIN, hidden-text and sensitive-data contexts are not sent to
the service. This is a connection-bound capability model, not a sandbox for
an untrusted IME executable or schema/plugin.

`pollyui --input-method --app-id org.pollyui.ime desktop/input-method/main.mjs`
runs the candidate UI. It uses `inputMethod.start(sharedDirectory, userDirectory,
schema)`, `state()`, `choose(revision, index)` and `onchange`. Revisions are
strings; candidate indices are zero-based integers. `state()` includes active/
ASCII state, preedit, selected candidate, last-page status, and candidate
text/comments. This mode is exclusive with `--desktop`, keeps its event loop
alive without visible windows, and does not initialize Rime in ordinary apps.
Only an initialized, authorized service can create
`window.create({inputPopup: true, width, height, title})`.

Candidate surfaces use the standard input-popup role, not layer-shell or
ordinary toplevels. PollyWM positions them at the editor caret, constrains them
to the output, and preserves editor keyboard focus during clicks. Empty or
cancelled composition closes the candidate surface. The current candidate UI
has a fixed-size scrollable list and neutral appearance; theme following and
other input engines remain future work.

The runtime image includes Alpine's `rime-plum-data`; the default schema is
`luna_pinyin_simp`. Its data and engine licenses remain separate dependencies
for packaging review. Enable it in the development session with `--ime`:

```sh
sh desktop/tools/run-session.sh --nested --ime --restarts 3 \
    ./build/desktop/pollywm ./build/linux-sdl/pollyui ./desktop/shell/main.mjs
```

Set `POLLY_IME_DATA` to another absolute shared-data directory and
`POLLY_IME_SCHEMA` to a configured schema ID. User deployment/learning data
lives in the `org.pollyui.ime` XDG data namespace. The launcher checks service
support and dictionary availability; a default session without `--ime` is
unchanged. `run-input-method.sh` receives the chosen runtime via
`POLLY_IME_RUNTIME`.

The vendored input-method-v2 and virtual-keyboard-v1 XML files preserve their
upstream notices and come from the `swaywm/wlroots` 0.14.1 source mirror; their
version-1 wire interfaces are used with the supported wlroots 0.19.3 API.
Text-input-v3 comes from installed `wayland-protocols`.

The Linux text shim now includes direct HarfBuzz shaping and ICU bidi,
grapheme segmentation and line opportunities. Editor pointer geometry and
selection share the shaped text. The HarfBuzz build deliberately disables
GLib/GObject/Cairo rather than using Alpine's GLib-linked binary; the full
runtime dependency closure is checked. See the root README's Unicode layout
contract for ligature-caret and paragraph-direction limitations.

Remaining text work includes broader engine/hardware qualification and
advanced typography. SDL 3.4 exposes caret/purpose and preedit but no
surrounding-text setter; PollyUI does not implement delete-surrounding edits.
Numeric/phone purposes temporarily force the service into ASCII mode and
restore the preceding mode on the next ordinary text field. Display settings
mark their numeric inputs accordingly.

### SDL disconnect hardening

The runtime image builds SDL 3.4.10 at commit
`8e37db5e797b6167f3a00d697d816a684bd259c7`, applying
`patches/sdl-wayland-sync-lifetime.patch`. Stock SDL allocates an untracked
show/hide `wl_callback` during window teardown even after its Wayland
connection has failed; the callback can never receive its completion event.
Valgrind traced the forced-session-exit leak to this path.

The patch makes the window own its show/hide callback, clears the pointer on
completion and destroys an outstanding callback during window teardown.
It does not suppress leak reports, touch SDL internals from PollyUI, or
replace the host event loop with polling. The source notices are retained,
and this is an explicitly modified SDL build, not an upstream release fix.
The build disables IBus/libdecor integration; input methods and decorations
are supplied by PollyIME/PollyWM instead.

`tools/build-sdl-linux.sh SOURCE_DIRECTORY [INSTALL_PREFIX]` reproduces the
build; the default prefix is `/usr/local`. It checks the exact source revision
and refuses mismatching patches. Configure PollyUI with
`-DSDL3_DIR=INSTALL_PREFIX/lib/cmake/SDL3` when switching an existing build
from system SDL. The runtime checker sets this to the image's patched build.
HarfBuzz's toolkit-free source build is installed separately as a static library
at `/opt/pollyui-text`; the image sets `PKG_CONFIG_PATH` for its `harfbuzz.pc`.
It must not replace the distribution's shared HarfBuzz, whose optional ABI is
required by independent applications such as `foot`/libfcft.

## Build independently on Linux

wlroots has an unstable API: this target requires the pinned 0.19.3 source plus
the checked-in effects ABI 4 patch and embedded source identity. Stock Alpine
`wlroots0.19-dev` is no longer a current build SDK. Earlier 0.19
versions omit `wlr_buffer_finish()` in the SHM allocator destructor, causing
use-after-free during nested/Pixman teardown. Upstream 0.19.3 fixes this; do not
lower the minimum or work around it by changing teardown timing.
Other wlroots API series need an explicit port, not an unbounded dependency change.
The installed `wayland-protocols` must also include
`staging/ext-workspace/ext-workspace-v1.xml`. Use the paired Debian SDK recipe.
The historical Alpine compositor/runtime stages and new Alpine package creation
are explicitly unsupported/deferred until the same source SDK is ported and verified;
archived user-tested Alpine images are not current rebuild evidence.

```sh
# Inside the pinned Debian SDK, from the repository root:
export PKG_CONFIG_PATH=/opt/pollyui-wlroots-effects4/lib/pkgconfig:${PKG_CONFIG_PATH}
cmake -S desktop -B build/desktop -G Ninja -DCMAKE_BUILD_TYPE=Debug
cmake --build build/desktop
ctest --test-dir build/desktop --output-on-failure
```

This standalone build does not fetch or build Skia, SDL, QuickJS or Yoga.
The root project also exposes `-DPU_BUILD_DESKTOP=ON` for a combined build;
it remains **OFF by default**, so normal Windows/macOS builds do not acquire
Linux dependencies. A combined build still needs the normal PollyUI dependencies.
Use `-DBUILD_TESTING=OFF` when only the compositor is needed.

## Install and package the development runtime

A combined desktop build installs the `PollyDesktop` CMake component:

```sh
cmake --build build/linux-sdl -j 2
DESTDIR="$PWD/build/install-root" cmake --install build/linux-sdl \
    --prefix /usr --component PollyDesktop
build/install-root/usr/bin/polly-desktop --headless --audio --ime --check
```

The installation includes PollyWM, PollyUI, its adjacent application-launch
helper, runtime JS modules and session scripts. `polly-desktop` locates its
resources relative to its installed binary directory, not the source checkout.
The patched SDL is private under `lib/pollyui`; the installed executable uses
an origin-relative loader path and does not replace the system SDL.
`--check` starts the real session and waits up to 15 seconds for its created Shell
surfaces and configured services. `--ime` requires successful native engine/schema
initialization and a live input-method role; `--audio` requires its private policy
discovery to complete. Disabled services are not required. State transitions are
logged, and service loss, missing required services or timeout fail explicitly.
An outer 30-second deadline covers a frozen startup/event loop, with termination
cleanup. Checks reject nonzero `--restarts` rather than retrying failures into a
success. This is initialization health, not physical GPU/audio/input acceptance
or a Chinese candidate interaction test.
Normal operation omits `--check`; `--help` lists wrapper options.

`desktop.sessionServices()` queries an authoritative input-method state:
`disabled`, `starting`, `ready` or `failed`. The connection-restricted
`polly_session_status_v1` interface allows the Shell to inspect, but only the
separately authorized input method to report completed engine initialization.
Public connections cannot bind it, even from the Shell's own process.
Disconnecting or losing the initialized role invalidates readiness. A same-process
SDK or localStorage flag is never used as service authority.

Inside the current paired Debian SDK, create a versioned package with its matching
dependency sources. Current Alpine packaging is explicitly rejected; the archived
Alpine artifacts and old container recipe are historical only.

```sh
node desktop/tools/package-linux.mjs build/linux-sdl dist/pollydesktop \
    /opt/pollyui-sdl /opt/pollyui-harfbuzz
podman build -t localhost/pollydesktop-alpha \
    -f dist/pollydesktop/Containerfile dist/pollydesktop
podman run --rm --network=none localhost/pollydesktop-alpha
```

The packager refuses existing output directories, sanitizer builds, incomplete
desktop builds and mismatched pinned dependency sources. It resolves both ELF
dependencies and explicitly required dynamically loaded Wayland/Mesa modules.
The clean runtime image runs as an unprivileged user without the checkout, SDK,
build tools or a host audio server. This does not add a production seat/login
policy or grant host device access.

Outputs include the installable `.tar.gz`, `rootfs/`, exact distribution runtime
package versions, a file/hash/source manifest, an SPDX 2.3 dependency inventory,
license notices, the SDL patch and `SHA256SUMS`. Libraries normally supplied by
Alpine are not bundled in the tarball; the supplied Containerfile installs them.
The tarball explicitly records root ownership, 0755 directories/executables and
0644 data/configuration. The runtime Containerfile extracts this archive instead
of copying a Windows-backed staging tree, whose mode bits may not preserve POSIX
permissions. Treat `rootfs/` as inspection/staging data; deploy the archive or
perform a native CMake install.
The package list can contain dependencies of independent applications such as
foot, including distro HarfBuzz/GLib; our own ELF dependency check still rejects
GLib/GIO/GObject and shared HarfBuzz. Artifact checksums are not update signatures.

The source revision and dirty-worktree flag are recorded. A Windows worktree
whose Git metadata is unreadable inside the container must supply
`POLLY_SOURCE_REVISION` and `POLLY_SOURCE_DIRTY=0` or `1` from the host; the tool
never assumes that such a checkout is clean. Exact package versions depend on
their continued availability in Alpine repositories: an archived APK mirror
and bit-for-bit reproducible build are not provided yet.

This artifact is explicitly a **development runtime bundle, not itself an ISO**.
The separate [Live image builder](./LIVE.md) adds a kernel, UEFI boot and
temporary ordinary-user PAM/elogind session. Protected login/authentication, secure
lock, installer/persistence/recovery, update trust and hardware qualification
remain separate release gates. The dependency
inventory is not a completed third-party source/license-compliance audit.

## Run nested in an existing Wayland session

The development launcher provides a private runtime directory, shell identity,
an owned D-Bus daemon, signal forwarding and cleanup. It keeps application configuration/data outside
the temporary runtime directory and changes to the repository root for module
loading. Paths supplied to it are resolved relative to the invoking directory.

```sh
sh desktop/tools/run-session.sh --nested --restarts 3 \
    ./build/desktop/pollywm ./build/linux-sdl/pollyui ./desktop/shell/main.mjs
```

This starts the real development Shell. `--headless` needs no parent display;
omitting both flags preserves wlroots backend selection. Restart is opt-in
(`--restarts` defaults to zero). The launcher uses `--exit-with-shell`, so closing
the shell normally ends this development session. It prints the absolute public
Wayland socket path for independently launched clients.

The bus socket is `bus` inside that same owned 0700 runtime directory.
`session-bus.sh` percent-encodes the socket path, waits for actual readiness and
publishes `DBUS_SESSION_BUS_ADDRESS` plus the matching
`POLLY_SESSION_BUS_ADDRESS` marker. The marker is not a security capability;
native code also validates the address, runtime directory and socket ownership.
The parent bus and starter variables are removed. D-Bus service activation
receives this session's public Wayland display, not the parent's X11 display,
Shell private socket or capture/debug variables.

Concurrent sessions have separate bus IDs and namespaces. Bus loss terminates
the development session with an explicit error; compositor exit/signals stop
and reap only its owned daemon and remove known runtime socket/activation
directories. `dbus-daemon` is a required launcher dependency; this does not
start a system bus, network/power daemons or a production login manager. Audio
is a separate opt-in service described below.

PollyShell acquires the standard Notifications name only on this private bus,
never on an ambient parent session. Native toasts and a panel-accessible center
share the current theme; actions are unicast back to their sender and never
executed as commands by the Shell. Sender ownership, stale UI revisions,
expiry/close reasons and queue limits are enforced natively. Markup, external
images, sound and persisted history are not advertised or implemented. See the
root README for exact API fields and limits. The separate StatusNotifier
watcher/host also runs on this bus. Desktop-entry D-Bus-only activation remains
unsupported.

Tray item registration verifies well-known-name ownership asynchronously;
requests are pinned to the sender's unique bus name and object path.
Name-owner changes remove stale items and in-flight registrations. Icons are
copied ARGB pixmaps in process-local Skia assets, never remote-supplied file
paths. Passive items are hidden and attention status is emphasized.
Icon-name-only items currently use a readable label fallback.

For exported application menus, the Shell requests bounded DBusMenu layouts
and AboutToShow lazily, tracks revisions and invalidates old UI actions on
updates. Native menus include submenus, separators, visibility/enabled state
and check/radio indicators; a click sends a fixed DBusMenu Event rather than
executing arbitrary text. Providers without an exported menu receive
ContextMenu requests. All item/menu requests have native two-second deadlines.
No Qt/KDE/GLib library is used by these implementations; `org.kde` is a protocol
namespace, not a desktop dependency.

Native fixtures register independent providers, inspect rendered icon pixels,
click all three pointer actions, send scrolling, toggle passive/active/attention
status, reject registration by a different owner and verify owner-loss cleanup.
They also exercise hung providers, live submenu changes, disabled/stale menu
rejection and exact clicked-event delivery in raster and GLES modes.

### PipeWire audio backend

The selected backend is PipeWire core with our own native policy and PollyUI
controls, not WirePlumber. Enable it explicitly:

```sh
sh desktop/tools/run-session.sh --nested --ime --audio \
    ./build/desktop/pollywm ./build/linux-sdl/pollyui ./desktop/shell/main.mjs
```

`session-audio.sh` starts the daemon from `system/pipewire.conf`, waits for its
private `polly-audio` socket and exports the session remote to child apps.
It never starts a host audio service. The Shell validates the owned runtime,
socket and peer UID, then passes the connected FD to PipeWire rather than
allowing ambient runtime-directory/socket fallback. Concurrent sessions use
separate cores. Daemon loss, normal exit and termination signals have explicit
owned-process cleanup.

The native main loop discovers bounded nodes/ports/links and default metadata.
Policy respects stream autoconnect and explicit targets, preserves manual links,
negotiates raw DSP ports and manages only its tagged routes. A supported mono
stream can be adapted to a stereo endpoint. Missing explicit targets remain
unrouted; default-device loss selects a fallback without discarding the preferred
name. Lingering links and metadata survive a policy/Shell reconnect. PollyShell
also saves acknowledged settings-control changes across logins: endpoint volume,
mute/unmute (including microphone state) and selected device names. Preferences
are bounded/versioned JSON; missing devices retain fallback without overwriting
the saved choice, and ambiguous names are not automatically restored. Runtime
IDs are never saved. Corrupt preferences and write/acknowledgment failures are
explicit, with a Forget saved audio settings recovery action.

The default config uses ALSA enumeration and ACP auto-profile/auto-port support.
Actual cards, jack changes, profiles and realtime latency need hardware
qualification. The tests use their own virtual sinks and synthetic source,
check nonzero captured samples and exact route endpoints, and cover manual/
missing-target behavior, stale controls, public-API denial and service cleanup.
They do not access speakers or microphones. PulseAudio emulation, ALSA-client
redirection, Bluetooth audio and portal capture permissions remain separate.
Setting up a private server and restricting Shell APIs is not an application
audio sandbox. See the root README for the API and model limits.

### iwd network backend

The selected Wi-Fi backend is iwd, with its own built-in network configuration
and PollyUI-owned UI. The Shell opens the system-bus client only when Wi-Fi
settings are requested. It never treats the private session bus as a production
system bus, starts iwd implicitly, edits `/etc`, or changes group/policy rights.

Before use, the bus must resolve `net.connman.iwd` to a root-owned unique
connection. All replies, signals and credential requests are associated with
that owner and an epoch; a replacement daemon cannot inherit stale actions or
prompts. Only the trusted Wayland Shell can start these APIs. Unknown/removed
object paths and stale snapshot revisions are rejected. Limits are 16 devices,
256 networks, bounded object/property/message sizes and 32 outstanding requests.
Connect/authentication have 120-second limits; ordinary operations and discovery
have shorter deadlines. Only one interactive mutation is outstanding at a time.

The UI provides radio power, scan, ordered SSIDs/RSSI, connect/disconnect, and
confirmed forgetting of discovered saved networks. It warns that iwd may save
credentials and enable autoconnection; there is no false "never save" checkbox.
PSK and pre-provisioned EAP agent prompts use native masked fields. EAP
certificate policy stays with iwd's administrator-provisioned profile, not a
Shell certificate-bypass dialog. Neither password snapshots nor payload logs
are produced. On daemon loss, credentials and stale models are discarded.

`system/iwd-main.conf` is an image template, not an installed host change:

```ini
[General]
EnableNetworkConfiguration=true

[Network]
NameResolvingService=resolvconf
```

An Alpine deployment needs iwd, its OpenRC integration, the system D-Bus daemon,
openresolv and the distribution's authorized access policy. Do not run the
desktop as root to work around permissions. `Daemon.GetInfo` is experimental
in iwd; an unavailable configuration-status query is represented as unknown,
and disabled configuration is visibly distinguished from Internet connectivity.

The test runner's `--iwd` mode points `DBUS_SYSTEM_BUS_ADDRESS` at its own
temporary test bus and starts an independent API fixture. This checks real
native UI/control flow without touching the host network. It does not certify
wireless hardware, real DHCP/DNS, static-IP provisioning, hidden networks,
enterprise certificate configuration, Ethernet or VPNs. Those remain explicit
follow-up/qualification work.

PollyShell stores `desktop.theme` in its app-scoped localStorage. Unknown stored
IDs produce a visible warning and a logged fallback without overwriting the
saved value. Failed display setup is not retried on every timer tick for the
same output configuration; the appearance menu offers an explicit retry.
Output removal retires only its Shell surfaces. Geometry changes recreate the
affected panel/Dock; unchanged surfaces are reused. Clock updates and menus
share the one UI runtime. Menu overlays close with their Close button or Escape;
click-outside dismissal is not implemented yet.

The session enables the in-house `.desktop` launcher with `--desktop`; no
GLib/GIO dependency is introduced. The root README documents its compatibility
scope, private bus inheritance, and intentionally unavailable D-Bus-only
desktop-entry/X11 paths.

Floating Dock corners use actual alpha composition. Blur, polished animation,
dark variants and shaped click-through regions are still outstanding. The Dock
exposes Apps, Appearance, About and real running-window buttons driven by
foreign-toplevel state. Taskbars and Docks list current-workspace windows on
every output, rather than filtering by a window's physical output. Click an active
window to minimize, or another/minimized window to activate and restore. Right
click opens maximize, fullscreen and graceful-close controls. Window-list
overflow scrolls horizontally with the wheel. Buttons are currently text-based,
without app grouping, icons or pinning.

The same window menu also provides **Left half**, **Right half**, and
**Restore floating** in every theme. They call the compositor's existing
half-screen/restore geometry engine, not simulated shortcuts or transforms.
Fullscreen must be left first; minimized, modal-blocked, pending or unfit
targets cannot be placed. Restore floating is enabled only when a saved floating
layout is actually available. The existing menu viewport, keyboard navigation
and shared scrollbar remain usable on short displays.

Packaged Modern additionally opts into a basic native maximize-button hover
picker with the optional strict boolean `window.layoutPicker` in schema 1.
Missing/false retains the old behavior. A single **500ms UI hover delay** (not an
input deadline) opens the existing QuickJS Shell menu with **Left half**,
**Right half**, and **Restore floating**. Tab/Shift+Tab, Enter, Escape, pointer
input and the shared short-viewport scrollbar use the ordinary menu controls.
The actual native button and output supply output-local logical anchoring;
the Shell clamps the popup to that output, including negative global origins.
The anchor uses the presented window's actual maximum-overlap output, like
placement, rather than its remembered configure output. A floating caption
drag across displays therefore needs no unrelated reconfigure before hovering.
If a window straddles outputs and Max lies outside that principal output, no
hover grant is issued.

This requires explicitly advertised paired workspace manager/child v4
capability. v3 retains existing window menus and maximize clicks without
synthesizing a hover feature. Only the authenticated Shell can opt in. The
compositor issues a single-use grant bound to the actual hit, presented native
frame, target lifetime, workspace and output. Leaving the button cancels an
unredeemed grant; after registration the pointer may enter the exact owned
menu without canceling on the target's ordinary inactive caption repaint.
Registration does not bypass the existing mapped/presented/exclusive input
and placement-epoch checks. Clicks on native captions keep their old behavior;
placement admits once and closes without retries on an unknown transport
outcome. Target/output/workspace retirement, lock, grabs, recording, retheme
and Shell stop revoke the picker. Business errors remain separate from
material errors. No quadrants, arbitrary ratios, overview, new renderer,
preview or full Windows 11 Snap flyout is implemented.

Holding a native caption on a maximized or half-screen window arms a drag without
changing placement. Moving more than 5 logical pixels restores the last saved
floating size, constrained to the pointer output's actual work area and client
size limits, with the horizontal caption fraction and vertical title offset
anchored to the pointer. The same held gesture then moves the floating window.
Client move/resize requests and Alt-drag remain floating-only; title double-click
still toggles maximize/restore. A click or movement below the threshold does not
restore early.

Restoration uses the shared client-configure/native-caption presentation fence:
the old placed frame does not move while waiting for a client buffer or GUI
caption. Motion updates the pending landing point; release freezes that point
even if presentation is late. Crossing to another output while pending refits
the original saved size to that output's work area and issues a matching client
configure and caption-scale revision; the earlier output's ACK/frame cannot
present the new landing point. Workspace, lock/input isolation, target retirement,
output/layout changes or another geometry command end the gesture, and a late
frame never restarts it. Already admitted geometry can finish at its frozen point
unless superseded or unmapped.

Releasing an admitted native-title MOVE after **more than 5 logical pixels**
also supports basic edge snap: the left/right outer **12 logical pixels** of the
output under the actual pointer request the existing half-screen placement;
the top 12 request the existing maximize path. For output box `(x, y, w, h)`,
the strips are `[x, x+12)`, `[x+w-12, x+w)` and `[y, y+12)`, intersected with
that output's real bounds. Top wins at both corners; no quarter-screen layout is
implied. Output gaps never select a nearest head. The destination geometry uses
that head's current reserved work area (including panels/Docks), native insets,
client limits and the existing client/native-frame presentation fence, not the
head with the largest window overlap. Nothing is committed before release.

Clicks, movement of exactly 5 pixels or less, middle-of-output release, canceled
gestures, client/Alt moves, ordinary client drags and resize do not snap.
Admission runs once after ending this exact caption gesture and rechecks the
live target, current workspace, focus, modal, lock/exit, exclusive-layer, seat-grab,
recording, fullscreen, pending-layout and native-frame boundaries. Denials log
`Cannot snap title drag on release` with the reason and leave the legal floating
transaction intact; there are no retries or simulated shortcuts. In particular,
**release while drag restoration or its native frame is still pending refuses
snap**: only the already admitted restoration may finish at its frozen release
point. It never queues a snap to run after ACK. Once restoration has actually
presented, the same held gesture can snap; the original saved floating size is
retained even if a smaller destination temporarily constrained that restoration.
Keyboard/menu output selection and title double-click are unchanged.

`pollywm-integration` covers exact strip/drag thresholds, top-first corners,
non-caption moves, authority rejection and negative-origin, odd-width 125%
outputs with panel/Dock reservations. The real GUI `title-snap` decorator fixture
checks release-only admission, old-frame retention through client ACK, matching
client geometry plus shown owned current native revision, completed/pending
drag restoration, saved size and lock/output/role retirement. This is basic
drag-edge release, not a full Windows snap flyout, preview, animation, overview
or four-way tiling. It adds no JavaScript geometry channel, polling, input
deadline, preference or new renderer.

Placement uses the existing restricted `polly_workspace_toplevel_v1` object,
paired manager/child version 3. `desktop.windows()` optionally adds readonly
`placement` (`floating`, `left`, `right`), `placementPending`,
`placementCapabilities` (left=1, right=2, restore=4), and `placementMessage`.
Older providers omit these fields and the three commands are hidden; the
existence of a JavaScript function is not a capability announcement.
`openWindowMenu(id, ownedWindow)` registers an actual owned layer surface on the
bound live toplevel and returns a compositor-issued epoch.
`tileWindow(id, 'left' | 'right', epoch)` and
`restoreFloatingWindow(id, epoch)` return `{ admitted: true }` only after WM
admission; this is **not** a resize/presentation acknowledgment. The readonly
state changes only at the existing client/frame presentation fence, including
floating recovery if a client declines the exact half size.

At admission WM checks the exact registered surface's mapped/presented
exclusive-overlay input focus and trusted connection, live target/family,
workspace, lock, keyboard/pointer grabs, shortcut recording and geometry limits.
Neither surface names nor claimed roles grant permission. Placement never
activates first. Each admitted epoch is consumed once; `closeWindowMenu(epoch)`,
surface unmap/destruction, workspace changes and Shell retirement revoke it.
Nonzero request serials increase without wrap, and duplicate/unknown serials or
stale epochs cannot replay a placement. Denials retain the menu and show an
error; a transport-unknown result is not reported as rollback and is never
automatically retried. Ordinary clients do not receive these private objects.
Keyboard placement retains its separate, unchanged focus/layer/grab guards.
This adds no preferences and changes neither configuration v4 nor appearance,
shortcut, effects or public theme protocol versions.

The ordinary single-window menu also offers **Cascade windows on this display**
with paired workspace manager/child v5. `desktop.windows()` reports
`cascadeSupported: false` on v3/v4 providers; those menus hide the command and
`cascadeWindows(id, epoch)` rejects locally without sending an unsupported
request. The caption-hover picker still contains only Left half, Right half
and Restore floating.

Cascade derives the target's main output from its actually presented position,
not its last configure output. It preserves scene order and focus, affects only
the current workspace on that output, and skips unmapped/minimized/fullscreen
windows, transient families (including their ordinary parent), private Shell/renderer/lock/input
surfaces and pending client/native frames. Saved floating sizes restore
maximized/half windows using normal client limits, native insets and output work
area fitting. Captions step by 24 logical pixels, wrapping deterministically to
the work-area origin when the next size would cross a boundary; windows are not
resized just to pack the group. All eligible sizes and the temporary plan are
checked before any configure is sent. An empty plan, allocation failure, unfit
limits, retired display/target/epoch or input isolation is a visible denial, not
partial success. The epoch also remembers the target's original presented
display, so a stale menu cannot silently retarget a different head.

`cascadeWindows(id, epoch)` returns only `{ admitted: true }`, not an affected
count or all-presented promise. Each window independently crosses the existing
client/GUI-native-frame fence; a maximized/half old buffer is not moved as if
restoration were finished. Final placement is still `floating`; the v3
placement enum and capability bits are unchanged. This is a conventional
display-local menu layout policy, not Snap, overview or a JS batch/geometry API.
The focused CTest cases `desktop-window-cascade-protocol` and
`desktop-window-cascade` run the three-client protocol/fence and actual
production-menu paths respectively (`ctest -R desktop-window-cascade`).
Compatibility qualification additionally uses an actual frozen v4 provider
archive with its original headers and the new GUI; that external frozen-provider
fixture is not synthesized by reducing the new compositor's advertised version.

The ordinary menu additionally offers **Tile windows horizontally** (full-width
rows) and **Tile windows vertically** (full-height columns) with paired workspace
manager/child v6 and its explicit arrangement capability.
`desktop.windows()` reports `arrangementSupported: false` on v3/v4/v5 providers;
both commands are hidden and
`desktop.arrangeWindows(id, 'horizontal' | 'vertical', epoch)` rejects locally
without sending an unsupported request. V5 Cascade, half/restore and the three
layout-only Maxhover actions remain independently available.

These are one-time floating arrangements, not persistent Snap, four-way tiling,
preview or overview. They reuse Cascade's ordinary-menu authority, presented
principal output, current workspace, skipped entire transient families and
private/minimized/fullscreen/pending windows. Each outer frame receives an exact
integer partition of the complete work area before its own native insets are
applied. A cell that cannot exactly accommodate any declared min/max/fixed client
size or native insets rejects the whole temporary plan before any configure or
saved floating geometry changes. Empty cells, no eligible clients and allocation
failure are also explicit denials; no fit-to-work-area clamping is used to make
an unfit cell appear valid. Scene order and focus are preserved.

The result remains exactly `{admitted: true}`, not an affected count or a promise
that every client has presented. Each client and GUI-native frame crosses the
existing presentation fence. A client may decline the suggested cell size; its
actual final floating geometry is presented with a one-shot compositor error,
not silent success, forced pixel scaling or infinite retries. Windows remain
freely movable/resizable afterward, and later half/max operations save their
newly presented float size. This does not claim GPU/physical-display validation
or exact Windows replication. The focused CTest selectors are
`desktop-window-arrangement-protocol` and `desktop-window-arrangement`; external
compatibility qualification uses the actual frozen v5 archive and its original
headers/XML with the new GUI, not a reduced version advertisement.

The workspace menu manually adds/removes/renames/reorders workspaces and switches every output
together. Four are created on first use, or validated saved preferences restore
the ordered names and active choice at startup. Empty workspaces are never
automatically removed, fullscreen does not create a new Space, and themes do
not change workspace behavior. New workspaces append; moving a window does not
follow it. Window activation explicitly switches to its owning workspace.
Transient families stay together, including when a child appears on an inactive
parent's workspace.

Deleting a workspace moves its windows to the previous workspace, or the next
when deleting the first; the final workspace cannot be removed. These operations
do not close applications or discard their minimize/maximize/fullscreen state.
The compositor owns this session state independently of Shell restart.
PollyShell owns the JSON preference parsing and persistence; the compositor
accepts a bounded startup transaction only before ordinary applications or
workspace operations. Shell reconnect never overwrites current live workspaces.
Invalid preferences remain untouched with an error and an explicit Save current
layout recovery action. Full application/window session restoration remains
separate work. The Live
root is still memory-only, so guest shutdown discards saved preferences.
The root README documents the native workspace API and ID lifetime.

Keep the parent's socket separate from the new compositor's socket:

```sh
parent="$WAYLAND_DISPLAY"
case "$parent" in /*) ;; *) parent="$XDG_RUNTIME_DIR/$parent" ;; esac
export XDG_RUNTIME_DIR="$(mktemp -d)"
printf 'Use this runtime directory for clients: %s\n' "$XDG_RUNTIME_DIR"
WAYLAND_DISPLAY="$parent" WLR_BACKENDS=wayland WLR_RENDERER=pixman \
    ./build/desktop/pollywm --socket pollywm-0
```

From a second terminal, use the printed directory:

```sh
XDG_RUNTIME_DIR=<printed-directory> WAYLAND_DISPLAY=pollywm-0 foot
```

Launch a second client the same way. A trusted Shell handles Alt+Escape through
logout confirmation; a standalone compositor can be stopped with SIGTERM. Then remove
the now-empty temporary runtime directory. PollyWM requires an absolute,
user-owned, mode-0700 runtime directory. Do not reuse WSLg's world-accessible
runtime directory as PollyWM's runtime, and do not run a real desktop as root.

## Windows / WSL validation

The helper uses Podman **inside WSL** and the checked-in Alpine development
`Containerfile`. It does not install packages into the WSL distribution or need
privileged containers/device passthrough. It leaves a reusable development image
and build artifacts, but removes test containers and terminates their processes.
The development image includes Valgrind and wlroots debug symbols to diagnose
code inside the uninstrumented distribution libraries as well.

```powershell
# From the repository root; defaults to the Podman WSL distribution:
.\desktop\tools\test-wsl.ps1

# Also check a real WSLg output under Valgrind and launch two foot terminals:
.\desktop\tools\test-wsl.ps1 -Nested

# Clang AddressSanitizer + UndefinedBehaviorSanitizer, including nested checks:
.\desktop\tools\test-wsl.ps1 -Nested -Sanitize
```

Use `-Distro <name>` for another WSL distro with Podman installed. Nested checks
require the WSLg socket at `/mnt/wslg/runtime-dir/wayland-0` and briefly display
test windows. The default suite does not require a display or GPU. Sanitizers
instrument our code/fixtures, not the distribution's prebuilt wlroots library.

The integration suite runs independent Wayland client processes with shared
memory buffers, xdg configure/ack/commit and frame callbacks. It checks focus,
input, move/resize including geometry offsets and min/max sizes, shortcut
consumption, invalid/cross-client/stale grab serials, popup lifecycle, unmap/remap,
client crashes and destruction of a role before its surface. Synthetic input is
injected in the **test process**, not through a production protocol; nested
tests exclude physical input to avoid racing the fixture or the user's mouse.
The native window-Shell fixture injects real pointer events into taskbar, Dock
and context-menu surfaces and observes independent `foot` clients. It also
checks metadata, stale IDs, public-client rejection and a fresh Shell connection
enumerating an application that survived the previous Shell's exit.
Decoration coverage includes explicit/default negotiation, deferred mode and
theme commits, title/palette pixel changes, controls and drag cancellation,
floating drag/resize, fullscreen, fractional scale and destruction during a
pressed control. Public forced-bind attempts cannot change appearance.
Workspace coverage uses standard protocol transactions and real Shell clicks
on both taskbars and Docks. It checks atomic commit, hidden-window input and
popup isolation, transient families, stale map epochs, deletion migration,
the final-workspace guard, fullscreen preservation and Shell reconnect.
Public clients cannot bind either workspace global even with a known global ID.
Switcher coverage exercises modifier-held previews, release/click activation,
reverse cycling, cancellation, stale candidates, workspace isolation, recorded
and disabled bindings, conflicts, and settings restored into a fresh compositor.
Output coverage changes actual headless modes, rotation, scale and positions,
edits fields through native input, and exercises explicit keep/revert, watchdog
timeout, Shell crash, output removal, stale snapshots and final-output safety.
Data-device coverage uses independent clients for invalid/foreign serials,
source-less cancellation, drag-icon/subsurface hit testing, icon/source loss,
workspace switching, origin unmap and minimize. Native raster/GLES peers transfer
Unicode, empty text, MIME bytes and independent primary selection; fixture
data sources deliver real Wayland text and URI-list drops into the recipient
document. SDL adapter tests cover aggregation, cancellation and limit errors;
headless tests use an isolated clipboard and exercise input shortcuts.
Non-sanitized `-Nested` runs the fixture under Valgrind to cover library-level
buffer lifetime errors; `-Sanitize` uses ASan/UBSan instead, not simultaneously.
CLI tests cover invalid arguments, runtime permissions, socket collisions,
startup failures and shutdown/socket cleanup.

Window-policy coverage also includes repeated and pre-map state requests,
fullscreen over maximized windows, delayed/older/skipped buffer commits, restore
geometry, centered fullscreen pixel readback, popup/submenu constraints and
reposition tokens. The headless suite additionally creates/removes real wlroots
headless outputs and checks negative coordinates, gaps, 125% scale, rotation,
output disable/re-enable, small outputs and migration before a client maps.
These are protocol/geometry checks, not a claim of physical monitor validation.

The optional `runtime` container stage builds pinned Skia from source using
native Clang 18 and system font/codec libraries. `test-linux-runtime.ps1` builds
PollyUI and PollyWM together without replacing the Windows/macOS dependencies.
Its headless suite covers text/font fallback, rendering, JS/DOM, workers,
file-based fetch/storage and the five appearances, plus explicit startup failure
cases, keyboard/text/pointer/wheel contracts and detached DOM callback teardown.
The SDL adapter fixture exercises actual host translation with synthetic SDL
events, including modifier/repeat/code fields, text suppression, right-click
mapping and fractional two-axis scroll. `-Nested` checks a real SDL3 Wayland
client on WSLg and inside PollyWM; local HTTP/TLS fixtures also exercise headers,
redirect policy, request cancellation alongside busy workers/compute, and XDG
persistence/error handling. Add `-Sanitize` for ASan/UBSan in PollyUI,
QuickJS, Yoga and the compositor (not the prebuilt Skia/wlroots libraries).
All nested processes are bounded and cleaned up. Nested rendering checks run
raster, required GLES and automatic selection through resize/restore. PNG
readback verifies fills, gradients, opacity, rounded clipping and text. CI forces
Mesa llvmpipe; this validates GLES code, not physical GPU/DRM acceleration,
physical keyboards/keymaps or a bootable session. Separate native IME fixtures
exercise real Rime composition, inline preedit, candidate clicks, password
bypass, cancellation and service-loss recovery in both raster and GLES modes.

For Linux-native nested validation after building (install `foot` first):

```sh
# Resolve the parent socket before the fixture creates its own runtime:
parent="$WAYLAND_DISPLAY"
case "$parent" in /*) ;; *) parent="$XDG_RUNTIME_DIR/$parent" ;; esac
WAYLAND_DISPLAY="$parent" \
    ./build/desktop/tests/pollywm-integration \
    "$PWD/build/desktop/tests/pollywm-test-client" --nested
sh desktop/tests/nested.sh "$PWD/build/desktop/pollywm"
```

## Attribution

The wlroots tinywl example informed the Wayland lifecycle and scene integration.
Its MIT license notice is retained in `LICENSE.wlroots`. Project-owned PollyUI
and PollyDesktop code uses the root `LICENSE` (MIT); dependencies, fonts and
input-method data retain their separate licenses.
