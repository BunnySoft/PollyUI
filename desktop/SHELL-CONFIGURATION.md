# Shell configuration v5

Shell is the sole writer of `application.configDir/shell-preferences.json`.
Independent Settings requests changes through the existing authenticated IPC;
it never receives a configuration handle. Linux Shell composition passes
`--no-legacy-storage`; ordinary applications, protected roles, headless tests
and Windows retain their existing localStorage composition by default.

The JSON object has exactly `version: 5`,
`theme: { id, filesEnabled, transparency, windowOpacityPercent, switcherStyle?, switcherMotion?, wallpaper?, companion?, workspaceCube? }`,
`audio`, `display`, `workspace`, `shortcuts`, `desktop`, and `launchers`. A null theme ID selects the
packaged default; `filesEnabled` defaults to true. `transparency` is `theme`
(unchanged theme policy), `opaque`, or `transparent`. Missing transparency in
older records normalizes to `theme`; unknown values fail explicitly.
`windowOpacityPercent` is an integer from 50 to 100, defaulting to 100.
Optional `switcherStyle` is `list`, `thumbnails`, or `flip3d`; omission retains the existing
title-list switcher. It is an additive field in the unreleased v5 schema.
Optional boolean `switcherMotion` defaults to true and controls native 3D
transitions, independently of the wallpaper's reduced-motion setting.
Optional `wallpaper` is exactly `{ mode, reducedMotion, video? }`, where mode is
`theme`, `aurora` or `video` and reducedMotion is boolean. Video mode requires
`video: { path, loop, paused }`: one bounded absolute local pathname and two
booleans. Other modes can retain that selection without playing it.
Omission preserves static theme
wallpaper and does not allocate an animation canvas or a visibility watch.
Optional `companion` is exactly `{ enabled, reducedMotion }`, both boolean.
Omission keeps it disabled and allocates no companion window, watch or timer.
Null preference sections
mean no saved profile. Non-null audio/display/workspace sections retain their
existing v1 domain schemas and validation limits; shortcuts store only
action/modifiers/key, not labels or live handles. Unknown fields/versions and
invalid values fail explicitly. All updates validate the complete next object.
Snapshots are deeply frozen and published only after file publication.

The shortcut catalog has ten actions. The original seven retain their IDs and
numeric order; `tile-left`, `tile-right`, and `restore-floating` append defaults
Super+Left, Super+Right, and Super+Down. Null shortcuts use native defaults;
non-null v4/v5 shortcuts must contain every action exactly once. Independent
Settings consumes this same catalog for recording, disabling and resetting.
The private `polly_shortcuts_v1` interface requires version 2 for the complete
catalog. Version 3 adds compositor-owned thumbnails; a version-2 server retains
title-list support and reports thumbnails unavailable. Version 4 adds native
perspective/depth composition and read-only depth-consistent picking; version 3
retains its original rectangle format. Version 1 is rejected
instead of applying a partial catalog.

Settings authenticates with `Connect`, builds its actual UI and presentation
handler, then reports `Ready`. The Shell starts the presentation request only
after readiness, not during UI construction. Both steps require the current
owned PID/UID; no-reply requests cannot publish readiness. Existing startup and
request deadlines are unchanged, and errors do not automatically relaunch or
replay writes. The test-only inspection endpoint has separate readiness; it is
not a product authority or part of this handshake.

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

Existing v1/v2/v3/v4 JSON is validated, upgraded once by the same atomic writer, and
preserves every original domain. It does not reread legacy localStorage.
An upgrade write failure is explicit, retains the uncommitted original file, and
does not create a success-shaped in-memory configuration. A post-rename
durability failure retains the published v5 file and reports uncertain durability.
Existing v4 ten-action bindings are preserved without rerunning shortcut migration.
The seven v1/v2/v3 legacy shortcut bindings, including disabled/custom bindings, remain
unchanged. Only the three new defaults are added. If a new default collides with
an old binding, that new action is explicitly Disabled and the Shell reports
all such conflicts once after successful migration publication; Settings can
reassign it. Migration never changes an existing user chord to make room.
Collision matching includes the three arrows' native XKB hexadecimal keysym
aliases (including zero-padded forms); the original stored key text is preserved.
The desktop/launcher domains remain version 1. Older binaries do not read v5; downgrading the Shell requires a separate,
explicit configuration compatibility decision. Before returning to an older
binary, restore an original backup or otherwise provide a configuration that
that binary understands; there is no automatic downgrade or backup framework.
An unknown schema is never replaced with empty defaults. With an empty launcher
list, taskbar/Dock slots retain their previous running-task behavior.

Transparency mode applies to desktop bar backgrounds, not global application
window opacity. Compatible Mac-style themes use their existing Dock/menu-bar
alpha, and fluent taskbars use the existing authenticated compositor material.
Opaque mode removes regional requests and restores opaque bar paint. Theme mode
restores the original loaded catalog without editing or deleting theme files.
Theme selection/reload and packaged-catalog restore retain the explicit user
mode. Unsupported activation fails before publication; Settings displays the
capability reason. As with other preferences, a post-publication durability
failure reports uncertainty and retains the actual committed appearance.

Only the current Shell-owned Settings PID/UID can call `SetTransparency`.
The independent Settings application also provides a local, owned ordinary
window preview when its Host reports per-pixel transparency. Its background has
alpha while foreground text remains opaque; its rectangular input is unchanged.
Closing the preview does not close Settings; closing Settings retires the preview.
No privileged Shell connection, foreign pixels or global opacity is granted to
the preview. Memory-only Live preferences still reset after reboot.

Global ordinary-window opacity is a separate Settings slider and restore-100%
control. Its private appearance-v10 capability checks the actual compositor
renderer, not merely the protocol version. Only the current Shell-owned Settings
process can request changes; the compositor applies group opacity after child
composition rather than separately fading overlapping child buffers. Window
decorations, fullscreen backing and popup groups participate; trusted Shell
surfaces, session-lock and other dedicated security roles do not. Rectangular
input, focus and window placement remain unchanged.

The Shell saves only an acknowledged setting. A failure before preference
publication restores the previous native percentage; a post-publication
durability error retains the committed setting and reports uncertainty. The
saved percentage is restored at Shell startup, and ordinary windows opened
later inherit the policy. Theme selection and theme-file operations retain it.
Compositor caches share the existing scene budget. New geometry is checked
before output rendering; an unfit surface explicitly disables opacity to
preserve a usable desktop and reports the actual 100% separately from the saved
user intent. This does not silently rewrite the requested preference or retry
the failed effect on an idle timer. Shell ownership loss restores opaque windows.

Settings can select title lists or real 2D window previews. Shell saves only an
available, validated style; an active selector keeps its current style until
the next opening. MRU order, reverse cycling, modifier-release acceptance,
Escape cancellation and card-click activation retain their existing semantics.
An unavailable preview capability is reported explicitly, and the title-list
selector remains usable.

Preview pixels stay inside the compositor. The Shell supplies measured image
rectangles on its own current selector surface; native code validates ownership,
serial, bounds and geometry before replacing the committed preview group.
Rejected requests leave that group intact. JavaScript receives status and a
ready mask, not foreign-window pixels; the mask indexes rectangle ordinals.
Image holes become transparent only after the corresponding native acceptance.
Input remains on the selector rather than on the windows pictured inside it.

Each page has at most nine thumbnails, normally at most 256x160 logical pixels;
native snapshots are bounded to 1024x640 pixels and share the existing 128MiB
scene-effects budget. Source changes schedule bounded updates while the selector
is active; unchanged frames are reused without an idle polling loop. Minimized
windows may show their last committed frame, not an invented live animation.
Closing a source updates the candidate set. Cancellation, lock, presenter loss,
target retirement and selector destruction release frames, listeners and timers.
Existing media does not acquire these controls without a new paired build.

Flip 3D is compositor-owned GLES composition of up to nine actual window
snapshots, with perspective-correct texture interpolation and a depth attachment.
It does not use application WebGL, export foreign pixels or render a CSS-like
rotation of the GUI itself. Near/far selection, live updates, minimized last
frames, Escape, modifier release and pointer acceptance retain the original
switcher focus policy. Picking uses the native committed quad pose and depth;
a held click is cancelled when its selection/serial changes.

Each projected frame is at most 2048x1280, with 10 bytes/pixel reserved for
RGBA, depth and workspace in the shared 128MiB scene budget. Old and candidate
frames and source snapshots coexist within that limit. The 180ms transition
uses bounded 33ms scheduling; still poses and unchanged static sources have no
recurring composition. Source closure, lock, keyboard/owner loss, selector
retirement and output teardown revoke the frames and picking state.

Settings gates Flip 3D on the actual paired GLES renderer capability, not merely
protocol version or application GL support. Pixman stays the default; enabling
a GPU graphics session uses the existing startup choice and requires a session
restart, not a live renderer swap. An unavailable saved 3D style visibly falls
back to real 2D previews or the title list without rewriting saved intent.
Existing regional material, rounding, shadows and opacity are retained by the
paired GLES implementation. Hardware/driver qualification and new Standard
media are separate from the source and software-GLES VM evidence.

Appearance Settings can enable the original procedural Aurora wallpaper, choose
reduced motion, or restore static theme wallpaper. Aurora is Canvas 2D drawing,
not video playback, a shader requirement or a downloaded image. The drawing
stays behind desktop icons and the selection overlay; it adds no input/focus
surface. The drawing helper caps backing size at 640x360 / 230400 pixels per
output and schedules at most 30 FPS. This is a work limit, not measured hardware
performance. Reduced motion draws a still frame with no recurring timer.

Private session-status-v3 supplies connection-owned background visibility
watches, at most 64 per connection. Scene-buffer output visibility accounts for
opaque coverage, output enablement and real session-lock coverage. Translucent
full-output surfaces do not falsely pause the wallpaper. Changes push events;
there is no hidden-window visibility polling loop. Pausing cancels the timer and
freezes animation time; output/surface teardown and static restoration release
the watch and the Canvas backing.

Only the current owned Settings PID/UID may call `SetWallpaper`. The Shell saves
the strict policy before applying it. An unpublished save failure retains the
old drawing; a committed durability failure applies the published policy and
reports uncertainty. A drawing failure explicitly removes the animated layer,
shows the static theme and reports the error while retaining saved user intent;
it does not retry on a timer. Selecting Aurora again is an explicit retry.
Theme selection, output recreation and Shell restart retain the policy.
Existing bitmap/primitive theme sources are unchanged. Wallpaper-derived client
materials still use their bounded static theme/bitmap projection, not live
copies of every animation frame. Native regional taskbar/Dock material continues
sampling the actual lower scene.

Appearance Settings can also enable the original Polly rabbit companion,
independently of wallpaper and switching style. The PNG atlas and generated
module reuse original Polly cursor masters, not proprietary character art.
Generation includes an exact alpha-derived input mask per frame. There are
eight 96x96 frames; the atlas is 768x96. An idle or reduced-motion companion
has no recurring animation. Click actions last at most 1200ms with bounded
34ms scheduling; right-click shows local built-in tips and a persistent Hide
control. There is no network assistant service, unsolicited application
automation, audio or arbitrary script/plugin loading.

The companion uses one transparent, keyboard-none owned overlay on the first
live output, with no exclusive work-area reservation. Mouse input is accepted
only on nonzero-alpha sprite pixels and the visible tip rectangle, never on
the rest of the output. `setOverlayInput` accepts at most 64 bounded rectangles
on a live owned layer Window; pending regions publish with its next drawn
buffer. Ordinary clients receive no such privileged Shell API. Native pointer
capture supports output-local drag; loss/cancel restores the starting position.
A synchronized activity check distinguishes a lock-induced release from a real
drag commit. It never takes keyboard focus.

Session-status-v4 adds bounded watches for keyboard-none top/overlay layers.
Lock stops actions and cancels capture. Output removal retires the old
window/watch/backing and recreates the companion on a surviving output;
positions are session-local and clamped, not a new persistent coordinate schema.
The sprite uses a 96x96 Canvas; the transparent host overlay is limited to
16 megapixels and needs at least a 240x240 logical output. Decoder/geometry/
transport failures stop it explicitly and retain saved user intent, without
repeated automatic launches. Re-enabling it is an explicit retry.

Only the current Shell-owned Settings PID/UID can call `SetCompanion`. Strict
pre-publication failure preserves the old policy/instance; committed durability
uncertainty keeps the published policy and is visible in Settings. Hiding
releases the actual overlay, input recipient, decoded pixels, activity watch
and timer. Its generated module and source PNG are paired install inputs.
No GLES, LLVM, font or external character dependency is introduced.

### Workspace cube

Optional `workspaceCube` is exactly `{ enabled, motion }`, both booleans.
Omission keeps immediate switching and allocates no cube snapshots or timer.
The trusted shortcuts-v5 connection configures this policy; v2-v4 window
switching remains compatible. Enablement requires the paired GLES renderer and
exactly four workspaces. Settings never deletes workspaces or switches renderers
to satisfy it. A saved unsupported preference remains saved with an explicit
restoration error; normal immediate switching is still available.

The default Ctrl+Super+Left/Right workspace actions become cube browsing when
enabled. Hold their modifiers, use Left/Right to rotate, release to choose;
Enter also accepts and Escape cancels. A left click picks the currently rendered
nearest workspace side by depth, not a rectangular guess. Caps, outside clicks
and other mouse buttons cancel. Pointer motion/scroll cannot leak through to
underlying applications while browsing. Window focus and the active workspace
remain unchanged until acceptance. Reconfigured shortcut chords still trigger
the same fixed actions.

The compositor samples real workspace membership and stacking, excluding
minimized clients; backgrounds/icons are shared, and ordinary decoration,
shadow, popup and global-opacity composition is retained. Hidden workspaces
are not activated or given keyboard focus to capture them. Sources are bounded
to 800x500 per face, projected outputs to 1280x800, at most eight enabled
outputs, 64 windows per face/output and 512 watched source surfaces, all under
the existing shared 128MiB effects budget. Availability is not a guarantee that
every eight-output/large-client combination fits that aggregate budget.
Explicit capture/allocation failure cancels with an error, not a success-shaped
placeholder. Animations are 180ms with one 33ms timer; still poses do not animate.
Background content is sampled on demand, not continuously from Shell clock
redraws. Source commits refresh at the bounded cadence; unchanged samples reuse
their immutable frames without an idle loop.

Lock, grabs, output/layout/scale changes, workspace changes, keyboard removal,
Shell loss and policy replacement retire selection without a workspace commit.
Timers, source watches and owned frame buffers are released. Native rejection
preserves prior policy; save failure rolls native policy back, whereas committed
durability uncertainty retains the published setting and reports the error.
Actual cube and existing Flip 3D fixture evidence uses software GLES with virtio
DRM/GBM, not a physical-GPU, performance or newly booted Standard claim.

Canonical Standard media assembly requires the actual GLES-capable paired SDK,
the native video helper and this source revision's complete runtime inventory.
The shared GTK-free GUI/Shell process still does not link FFmpeg. These delivery
checks do not enable cube/video by default or add dependencies to Mini.

### Local video wallpaper

The optional `PU_DESKTOP_VIDEO=ON` Linux SDL desktop build adds a separate
ordinary-user `polly-video-decoder`, not FFmpeg linkage to Shell/GUI.
The pinned FFmpeg 9.0.2 LGPL-only closure has software H264/VP8/VP9 decoding,
MOV/MP4 and Matroska/WebM demuxing, and no compiled URL protocols, network,
audio decoders, hardware acceleration, GPL or nonfree components. This does not
claim codec-patent clearance or a completed redistribution compliance audit.
The default remains OFF; Mini does not implicitly gain these libraries.

Settings uses the existing ordinary-parent file chooser, with real cancel,
Pause/Play, loop and static recovery controls. Audio is always disabled.
Reduced motion pauses the video and disables Play until Animate is selected;
before the first frame, static theme art remains visible. Once ready, pause
retains the last frame. Pause, visibility and reduced-motion changes reuse the
same native source. Source/loop changes and explicit retry replace it.

The source must be a readable regular non-symlink file of at most 2GiB, with
dimensions at most 1920x1080. One native worker downsizes without stretching to
at most 1280x720 and publishes at most 30 FPS. Source timestamps and frame
durations drive pacing; non-looping EOS retains the last frame. Per-output
cover geometry crops centrally behind desktop icons, with no input surface.
An already-open source FD, private sequence-packet socket and sealed-size
3,686,400-byte shared frame are the only inherited application descriptors.
One frame credit prevents overwrite until the GUI has copied an immutable
native Skia image; no per-frame JS pixel arrays or callbacks are involved.
There are at most eight owned output targets. The worker uses two decoder
threads, a 512MiB address-space limit and bounded allocations. Initialization
has a ten-second parent deadline even when playback starts paused.

Compositor-owned background activity pauses work on lock, disabled outputs or
complete opaque coverage; translucent coverage does not incorrectly hide it.
Output replacement detaches targets before retirement and retains one source
on survivors. Errors visibly restore static art while retaining the selected
preference; there is no clock-driven retry. Unpublished save failure preserves
playback, while committed durability uncertainty retains the published policy.
The helper, four private SONAME libraries, full pinned source archive/signature,
public key, notices, configure arguments and SBOM identity are paired package
inputs. Source/native fixtures are not booted-image or hardware qualification.

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
