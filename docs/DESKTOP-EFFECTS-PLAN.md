# Standard desktop effects plan

This is an implementation plan, not a delivery or hardware-qualification claim.
Standard must include the implemented capabilities, Settings controls, original
example resources and runtime dependencies. Mini and Compact do not inherit new
dependencies implicitly. Existing media and its evidence keep their identities.

## Sequence and acceptance

| Stage | Scope | Acceptance |
|---|---|---|
| 1 | Existing panel/Dock transparency controls and an ordinary transparent-window preview | Theme defaults remain unchanged; Settings can apply, save, restore and report unavailable effects; preview uses real per-pixel composition and closes with Settings |
| 2 | Global ordinary-window opacity | Existing and new windows, decorations and child surfaces have consistent composition; trusted security surfaces remain opaque; cancellation and 100% restoration preserve input and focus |
| 3 | Real window thumbnails and 2D switching | Compositor-owned window pixels, bounded caches and current target lifetimes; retain MRU, reverse cycling, modifier-release acceptance and Escape cancellation |
| 4 | Procedural wallpapers and animation lifecycle | Original built-in Canvas effects behind desktop icons; bounded frame scheduling, lock/output/visibility pause, reduced motion and explicit static recovery |
| 5 | GPU composition and Flip 3D | Native perspective window cards using the stage-3 sources; existing rounding/shadow/material compatibility; capability and session-restart requirements are explicit |
| 6 | Desktop companions | Original PNG sprite resources and finite actions; bounded output-local movement, drag/cancel and explicit interactive regions; transparent regions pass input through without focus theft |
| 7 | Video wallpaper | Asynchronous native local-file decoding, bounded frame ownership, timestamps, loop/pause, mute and explicit failures; no per-frame JS pixel copying |
| 8 | Workspace cube and Standard integration | Four-workspace transition policy with correct focus commit/cancel, output changes and lock privacy; rebuild Standard and qualify combined effects on actual media |

Stages are implemented one at a time. A completed source milestone does not
mark later milestones or a new ISO as delivered. Extend existing tests; creating
new test files requires separate user approval. On 2026-10-21 the user approved
necessary new test files for the whole plan. No commits or remote publication
are implied.

## Current progress

Stage 1 is implemented in the working tree. Appearance Settings exposes theme
defaults, opaque bars and existing transparent bar effects, with strict
Shell-owned application, capability diagnostics and v1-v4 to v5 preference
migration. The ordinary Settings-owned preview has a real half-alpha background,
opaque foreground and unchanged rectangular input. An isolated UID1000 native
run exercised the actual controls and preview pixels; existing source fixtures
cover publication failure, uncertainty, authorization, restoration and cleanup.
Its first native attempt failed because the temporary SDK container had no
passwd entry for UID1000; evidence is retained separately from the subsequent
run with a container-local test user. No host account was changed.

Stage 2 now has compositor group composition and a separate 50-100% Settings
slider. Existing and newly opened ordinary windows inherit it; foreground text
also fades. Native control, strict ownership, preference restore/rollback,
renderer capability reporting and explicit resource/geometry recovery are
implemented. A matching additive wlroots API preserves the original effects4
public structure layout and existing rounding API; the exact patch pin changes,
so old SDKs are rejected instead of linked as compatible. The locally built
candidate SDK is `localhost/polly-effects-opacity-sdk-f687df90:dev`; historical
Full SDK/runtime/images remain unchanged. This source work is not new media.
The paired native Settings run exercises actual slider input, new-window
inheritance, rejection and visible 100% recovery for oversized popup geometry,
and preservation of saved user intent. Group pixels, scaling/rotation,
cache limits, source pairing and lock coverage pass their focused native cases.
Parallel native runs use a 512MiB container SHM mount; the product scene budget
remains 128MiB. The initial default-SHM exhaustion remains retained evidence.

Two additional legacy fixtures still fail: `gui-wayland-transparency` at its
caption-button assertion and `gui-wayland-window-contract` at resize-grab entry.
Both failures reproduce at the same assertions with the unchanged Full source
and old SDK. They are not counted as passes or silently fixed in this feature
work; the legacy baseline and new-source logs are retained separately.

Stage 3 is implemented in the working tree. Appearance Settings selects the
unchanged title list or real 2D previews, using optional v5 `switcherStyle`.
Private shortcuts-v3 keeps pixels compositor-internal; version 2 retains the
title list. Bounded subtree snapshots, source revisions, active-only dirty
scheduling, committed-request rejection and target/lock cleanup preserve the
existing input and focus contract. The selector uses actual measured image
rectangles, native acknowledgement before transparent holes, and compact paged
cards. Minimized sources may retain their last committed frame.

The stage-3 paired candidate was `localhost/polly-effects-preview-sdk-f687df90:dev`,
with patch SHA256
`9a3c3247563f8d78e5f80351d459d7b20f75958a66f8e25fef740b2b86e47888`.
The expanded UID1000 native run checks actual composed pixels, live updates,
idle reuse, rejected requests, Escape, source closure, minimized restoration,
pointer activation and persistence across a new Shell PID. Independent Settings
exercises the actual style buttons together with the existing opacity controls.
The source suite has 182 passing cases. Snapshot pixels, group opacity, existing
scene effects, lock coverage and exact dependency pairing pass focused native
cases. The legacy title-list fixture also passes after supplying its required
isolated private session bus; the initial missing-bus failure is retained.

Stage 4 is implemented in the working tree. The original Canvas Aurora wallpaper
has actual Settings controls, strict optional v5 policy, a 640x360 / 230400-pixel
per-output backing limit and a bounded 30-FPS timer. Reduced motion retains one
still frame without recurring work. Private session-status-v3 pushes actual scene
visibility changes; opaque coverage, output disablement and session lock stop
drawing, while translucent full-output coverage does not. Re-exposure and unlock
resume; static restoration and surface teardown release buffers and watches.
Drawing errors explicitly restore static art without an idle retry loop.
Mini remains Pixman and gains no Mesa/LLVM/GLES dependency from this work.

The source suite now has 190 passing cases. The UID1000 native lifecycle lane
checks changing and stable actual composed pixels, independent outputs, both
coverage cases, real lock/unlock, output disable/re-enable, preference restoration
in a new Shell PID and resource release. Actual independent Settings controls
also pass. Disabling an output visibly retires its existing taskbar material;
the lane checks that exact diagnostic and successful regional-material
re-registration afterward, not a silent success fallback. First failures are
retained: a display-label versus owned-output fixture mismatch, an output-change
marker lifetime bug located by GDB, and a static-frame presentation-order race.
None is relabeled as a successful original run. Existing transparency, preview,
lock, dependency and title-list regressions pass with the new source.

Stage 5 is implemented in the working tree. Settings offers capability-gated
Flip 3D and animated/still poses. Private shortcuts-v4 composes up to nine actual
window frames using native perspective-correct GLES sampling, depth and
depth-consistent pointer picking. Transitions are bounded to 180ms with 33ms
scheduling; static sources reuse frames without an idle loop. The original
MRU, reverse switching, modifier release, Escape and minimized restoration
contracts remain. A saved unsupported 3D style visibly uses 2D/title fallback
without silently rewriting the preference.

Regional Gaussian material now has a native two-pass GLES implementation,
including rounded/group-opacity content below it; it is not discarded to make
3D work. Real UI exercise exposed shared-context framebuffer state loss after
nested cache composition/import. Explicit render-target restoration fixes that
path. GPU Settings also exposed an initial authentication-versus-UI-ready race:
the owned `Ready` handshake now precedes `Present`, with unchanged deadlines
and no automatic retry. The test-only probe waits for its own registration
separately instead of confusing it with product readiness.

The exact current patch SHA256 is
`dce388b731ff2299c6e3c4debf112f9a8acb8accfea51117ca6fce559bdd98f2`;
the paired SDK is `localhost/polly-effects-gpu-sdk-f687df90:prototype3`.
Existing ABI4 public layouts are retained with additive APIs and strict
compile/source checks. The source suite has 194 passing cases. Independent
native VM runs exercise actual Settings controls, all three source images
visible together, live red/magenta commits, immutable frames, correct depth,
zero idle recomposition, bounded transition frames, invalid request preservation,
pointer restore, real lock cleanup and a fresh Shell PID. The final retained
run also preserves complete actual output captures. Raw native Gaussian
pixels differ by at most one channel level from the CPU oracle.

These are no-network, memory-only injected fixture runs with real virtio DRM
and GBM DMA-BUF, but software llvmpipe rendering and headless scene outputs.
They are not physical-GPU, KMS scanout, performance or stock-ISO acceptance.
The source-only dependency also builds with GLES/GBM/udmabuf disabled and no
GLES/GBM runtime linkage; this is not a new musl Mini media qualification.
First failures, the interrupted VM run and the screenshot transport packet loss
remain retained, separate from passing reruns. No test deadline was increased
or dropped. The GPU CTest fixture explicitly skips without a selected DRM test
node; the VM lane, not that skip, supplies GPU-path evidence.

Stage 6 is implemented in the working tree. The original Polly rabbit uses a
deterministically generated PNG atlas and exact per-frame alpha input masks.
Settings provides enable/hide and reduced-motion controls. The first live
output owns a transparent keyboard-none overlay; actual transparent pixels pass
input through and visible interactions preserve ordinary application focus.
Actions are finite, idle has no recurring paint, drag stays output-local,
and explicit Hide releases resources and saves the disabled preference.
Lock cancels capture and restores its origin. Output removal retires the old
instance and creates a bounded one on a surviving output. No commercial
character assets, network service or GPU dependency is added.

Private session-status-v4 adds owned non-focus-stealing overlay activity,
reusing the bounded watch pool. The client publishes bounded input regions with
the next drawn buffer. Real lock exercise caught a synthesized release being
mistaken for a user drag commit; synchronized activity admission now prevents
that error. A first Hide fixture also needed to wait for actual asynchronous
surface retirement, not merely the JavaScript reference becoming null.

The source suite now has 199 passing cases. UID1000 native fixtures exercise
actual independent Settings enable/motion controls, real atlas pixels and zero
transparent/input mismatches over the complete 96x96 sprite, native click-through
to a fullscreen ordinary client, focus preservation, real captured movement,
lock cancellation, output removal/recreation, reduced-motion idle, new Shell
PID restore and the actual Hide control. Generated resources match byte-for-byte
after component installation, and package-contract verification includes both.
Ten focused Release fixtures, actual legacy 2D previews and independent Settings
also pass. Earlier failed runs and wrong-prefix install inspection are retained.

Stage 7 is implemented in the working tree. An optional separate native worker
uses the pinned, signature-verified FFmpeg 9.0.2 LGPL-only four-library closure,
with H264/VP8/VP9, MOV/Matroska, no audio/network/hardware decoding and no
GPL/nonfree components. The GUI and Shell do not link FFmpeg. The worker owns
timestamps, bounded scaling and one-credit shared-frame transport; native Skia
copies frames without per-frame JavaScript pixels. Source files are bounded to
2GiB and 1920x1080, output to 1280x720 and 30 FPS. Paused startup is encoded in
initialization, so a restored paused preference cannot publish an initial frame
before Play. Initialization remains deadline-bounded even while paused.

Real independent Settings exercises the ordinary-parent chooser, Escape
cancellation, actual MP4/WebM selection, Pause/Play and loop controls. Native
fixtures check changing composed pixels, frame-credit ownership, exact source
timestamps/durations, lock pause, surviving-output ownership, a new paused Shell
PID, explicit EOS with last-frame retention, malformed/oversized rejection and
visible static recovery without retries. The source suite has 204 passing
cases; seventeen focused Release/native regressions also pass.

The independent SDK is `localhost/polly-effects-video-sdk-f687df90:dev`.
Actual relocated component installation uses four regular private SONAME files
and an executable helper with `$ORIGIN/video`; all four resolve inside that
installation. A dirty-source development runtime package includes the complete
source archive/signature/public key, licenses, configuration and SBOM identity.
It is not frozen media. The default-OFF build also succeeds in the prior SDK
without FFmpeg installed or new video runtime linkage. This is not a new musl
Mini media qualification. A first package attempt correctly rejected an old
export's Git base label; the successful package uses the actual current checkout
read-only, with genuine Git provenance and its dirty state retained. Earlier
build/fixture failures remain separately recorded.

Stage 8's native workspace cube is implemented in the working tree; new Standard
media delivery remains. Shortcuts-v5 adds strict opt-in policy/status without
changing the ten-action catalog or older v2-v4 contracts. Actual independent
Settings saves enablement and independent animated/still policy. Exactly four
workspaces are required; no user workspace is removed to satisfy that policy.
The native compositor samples real window/decorations/shadows/popups and the
Shell background without activating hidden workspaces or exporting pixel FDs.
Four sides and closed caps use perspective-correct projection and depth.
Up to eight output recipients share the existing 128MiB budget; each source
face is at most 800x500 and each composed output at most 1280x800. Surfaces and
window counts are bounded. The background is captured on demand rather than
following Shell clock commits. Ordinary source/subsurface damage triggers
bounded refresh; unchanged sources have no idle composition loop.

Holding the workspace shortcut modifiers permits forward/reverse browsing;
release or Enter commits. Escape, outside/right click, lock, grabs, output or
workspace changes cancel. Native pointer picking uses the currently rendered
depth pose. Original focus stays unchanged during browsing. Transitions use
180ms easing and at most one 33ms timer; reduced-motion/still policy has no
animation timer. Retirement releases snapshots, nodes, watches and timers.

The complete native VM run `cube-vm-r7` verifies all four real source colors,
two neighboring workspace images visible together during rotation, wrap/reverse,
idle reuse, pointer and modifier acceptance, focus cancellation, repeated actual
lock/unlock, output removal/material recovery and a new Shell PID. It retains
complete composed captures. `cube-vm-r8` independently rechecks existing Flip 3D,
including three bounded transition frames and zero idle changes. The source
suite has 208 passing cases and nineteen focused Release cases also pass.
These still use virtio DRM/GBM with llvmpipe/headless outputs, not physical GPU,
KMS scanout, performance or stock-media qualification.

Output removal with fullscreen sources exposed an existing hidden-taskbar
backdrop preflight bug: a hidden ancestor prevented locating the sampling stop.
The unchanged prior SDK reproduces the new focused regression. The fix locates
that stop without enabling or sampling hidden siblings. A newly regenerated
paired patch is
`04e9b87e8956a3eaff4feae9fb4ef06b91c2ccb871dc5e883a68a81dce2bdab6`;
the current SDK is `localhost/polly-effects-cube-sdk-f687df90:dev`. Older SDKs
remain immutable and are now rejected by the exact pairing checks. Real UI
also exposed unnecessary full Appearance reconstruction on initial Present;
same-Appearance presentation now refreshes without retiring the ready document.
Other managed pages retain their original draft invalidation semantics.
The fixture's static lock-start flag was scoped to each Shell run, so the new
PID can acquire its own real lock. First failures remain retained.

The canonical Standard assembly entry now rejects a native bundle lacking the
actual paired GLES compile capability, isolated video decoder, new effects
scripts/resources or an exact match to the current source byte inventory.
Generic/legacy hardware entries are not relabeled as this product. Existing
clean-Git, frozen-runtime, signed offline-lock and media-integrity gates remain
unchanged. Source and development bundles remain dirty until an explicit local
commit is authorized; neither a synthetic clean label nor an automatic commit
is an acceptable media-build input.

No new effects media is delivered: existing
Full/Standard ISO files do not contain stages 1-7 until a new source-bound
runtime/media build is made.

## Ownership and compatibility

Settings owns controls and presentation, not privileged compositor access.
Shell owns policy and the single-writer, versioned preference document.
PollyWM and the GUI Host own surface composition, input regions and actual
presentation. Native media code owns decoding and bounded frame transport.
Use existing seams rather than a new general-purpose plugin framework.

Global opacity fades foreground text as well as backgrounds. It is separate
from background-only panel transparency, wallpaper-derived client material and
regional blur. It does not change ordinary window input regions.

Preserve the CPU/Pixman baseline and 2D switcher. GPU effects need native
compositor support; application WebGL2 alone is insufficient. Existing regional
blur began as Pixman-only; stage 5 adds the matched GLES path rather than
silently removing it.
If the renderer selection is startup-only, Settings must request a session
restart rather than pretending it switched live.

Keep previews inside the compositor; do not periodically screenshot the desktop
or expose arbitrary other-window pixels to ordinary clients. Revoke samples on
lock, owner loss, target retirement and output removal. Do not activate hidden
workspaces merely to capture previews.

Procedural wallpaper is generated drawing, not video playback. Retain wallpaper,
icons and desktop selection ordering. Shared animation policy must consider
transparent foreground windows: a translucent fullscreen window does not make
the wallpaper invisible. Avoid unbounded idle timers or repeated failed retries.

Companions are Shell-owned, non-focus-stealing surfaces, not unrestricted
always-on-top application overlays. Use original bundled art; user-supplied art
must be licensed for its use. Do not copy commercial character assets.

Video decoding should use a minimal native FFmpeg library closure and a
non-privileged helper with bounded frames. Software decoding establishes the
functional baseline; hardware decoding is a separate capability and qualification.
Local formats and exact libraries need an explicit package and notice inventory.
Existing VideoFrame pixel ownership is not a video decoder.

## Verification and delivery

For each stage verify real output and state, not only successful requests.
Preserve first failures and unsupported states. Confirm restoration, cleanup,
focus/input, resource limits and error reporting using the smallest relevant
existing fixtures before escalating.

Initial performance characterization targets a declared single-output 1080p,
30 FPS workload, recording CPU, memory, frame delivery and input latency.
This is not a promise of all-device, 4K or multi-output performance. The
existing intermittent Live Chinese-commit marker failure remains separate
until its cause is established.

At final integration retain source/runtime identities, exact dependency locks,
resources/notices, media hashes and actual boot evidence. VM functional checks
do not establish physical GPU, Wi-Fi, audio or performance qualification.
Memory-only Live preferences reset after reboot even when their file writes
succeed during the session.
