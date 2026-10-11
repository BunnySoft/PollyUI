# System rabbit cursor: next-version assessment

Recorded on 2026-10-11. The user selected a **system/desktop default rabbit
cursor, overridable by windows**, for the version after Alpha.7. This is a
design assessment, not implemented functionality or a frozen release/version
number. Alpha.7 remains Files interaction polish and a separately qualified ISO.

## Existing substrate and actual gaps

The current compositor already owns `wlr_cursor`, an Xcursor manager, pointer
motion/buttons, window move/resize and native data-device drag lifetimes.
It currently creates the theme manager with an unspecified theme and size 24.
Compositor decoration edges select resize cursors; authorized pointer clients
or the native drag owner may submit a cursor surface.

The installed wlroots 0.19.3 implementation already advances multi-frame
Xcursors using image delays, updates output cursor buffers and loads scaled
themes. Re-selecting the same manager/name is a no-op, so frequent motion does
not need to restart animation. Its public cursor-shape-v1 manager provides
semantic shape requests. The pinned SDL Wayland backend already negotiates
that protocol and maps its system cursors to default/text/resize/etc. shapes.
PollyWM does not currently create the cursor-shape manager.

Consequently, this does **not** require a new GUI renderer, shader/material
pipeline, SysRT/FFI service, private OS mouse hook or patches to wlroots/SDL.
Generic custom-image cursor APIs in PollyUI's Win32/SDL hosts are not a
prerequisite for a PollyOS-wide default theme. They are a separate capability
if applications later need arbitrary custom cursors outside PollyWM.

Main gaps:

- An original packaged rabbit Xcursor theme, with static and animated variants,
  stable hotspots, multiple sizes and conventional precision cursors.
- A compositor-owned input state machine selecting theme variants and retiring
  one-shot actions without resetting every frame.
- Semantic cursor-shape handling, focus/grab authorization and restoration of
  the correct owner on leave, client loss, lock, cancellation and output change.
- Install/release inventory, preferences and fallback behavior; cursor-specific
  native acceptance, not screenshots of an app overlay.

## Native modification boundary

| Surface | Expected modification | Difficulty |
|---|---|---|
| `desktop/compositor/server.c`, `server.h` | Centralize cursor choice; route motion/buttons, enter/leave, move/resize, isolation and shutdown; register cursor-shape manager | Medium |
| Small compositor cursor module | Own action/owner state, one-shot deadlines, animation transitions, fallback and timer/resource teardown; reuse wlroots frame animation | Medium |
| `desktop/compositor/data-device.c` | Observe confirmed native drag start/end/cancel without changing transfer authorization or file operations | Low to medium |
| Session-lock and decoration integration | Preserve protected surfaces and resize direction cues; clear pre-lock client/action state | Medium |
| Original cursor assets and build tooling | SVG/master artwork to prebuilt ARGB Xcursor frames, sizes, aliases, manifest and hotspots; verify installed data | Medium |
| `desktop/install.cmake`, package/live checks | Include cursor resources in relocation, frozen-input hashes and ISO payload checks | Low to medium |
| Host/SDK compatibility | Use existing system shape requests; clarify theme-default versus explicit legacy arrow semantics if extending the API | Small, but behavior-sensitive |
| Settings/Shell preferences | Theme/size/static-mode selection using JS configuration and narrow trusted configuration delivery; not per-motion JS callbacks | Can follow the core implementation |

The default artwork/theme selection can remain JS/configuration policy.
Realtime ownership, input event observation, authorization, lifecycle and
native cursor updates belong to C/PollyWM. Do not add application business
state machines to native code. A custom protocol is not the first choice when
the standard cursor-shape protocol supplies the required shape semantics.

## Ownership and compatibility

The rabbit is the theme's **default semantic cursor**, not a forced replacement
for every cursor on the screen. Prefer this order:

1. Protected/compositor interaction requirements, including precise resize
   directions and native drag result semantics.
2. Authorized explicit client shape or custom cursor surface, including an
   intentional hidden cursor. A null cursor is not permission to restore a rabbit.
3. The system rabbit default and its current action animation.

Leaving an override must recompute the cursor for the *current* surface and
state, rather than unconditionally selecting the rabbit. Entering an override
retires any old hop/effort animation so it cannot reappear on that client.
Retain the current focused-client/native-drag-owner admission boundary and
validate input serials through the standard protocol path.

Legacy `wl_pointer.set_cursor` carries an image surface/hotspot, not a shape
name. Never compare pixels, ignore a valid client image or reinterpret hiding
as inheritance. Such clients may receive a matching installed Xcursor theme
through ordinary theme/environment integration, but arbitrary old client
surfaces cannot be guaranteed to participate in compositor action animation.
The pinned SDL clients can use cursor-shape-v1 when PollyWM advertises it.

There is also an API compatibility decision: SDL maps the current
`window.setCursor('arrow')` to the standard DEFAULT shape. A themed DEFAULT
naturally becomes a rabbit; it does not distinguish "inherit this system theme"
from "force the old classic arrow." Document that intentional behavior change,
or add an explicit classic-arrow override if needed. Do not claim that the
existing protocol can recover that missing intent.

## Actions and proposed artwork

These are initial visual/timing recommendations, not measured performance or
fixed implementation requirements.

| Input/state | Rabbit treatment | Trigger and exit rule |
|---|---|---|
| Idle default | Small side-facing rabbit with upright ears; static resting pose | No active overriding shape or action; avoid perpetual idle animation |
| Moving | Running legs with slight ear motion, not a bouncing hotspot | Loop only while movement continues; propose about 12-16 frames/second and 100-150 ms quiet hysteresis |
| Button held without drag | Small crouch/compression | Press starts immediately; release/cancel ends it; do not claim a click has completed yet |
| Primary click | One short in-place hop and landing | Valid release below drag threshold; propose 150-220 ms; completion returns to current state, not stale idle |
| Double click | Merge into one crisp hop/ear accent | Do not queue two long animations or delay application double-click delivery |
| Secondary click | Subtle ear flick rather than a large jump | Keep menu placement and pointer visibility clear; no unsupported operation/success meaning |
| Held movement / window move | Leaning, pushing/effort pose | Generic held movement may enter after threshold; confirmed window/native drag uses its actual lifecycle; reset on release/cancel/loss |
| Native data drag | Effort pose plus the established allowed/copy/move/forbidden indicator when known | Follow negotiated native action; do not infer file copy or promise transfer success from mouse motion |
| Wheel/trackpad scrolling | Keep current precise default, optionally a tiny ear accent | Do not run or jump for every wheel tick; momentum is not pointer motion |
| Text / resize / crosshair | Preserve familiar I-beam, directional arrows or crosshair; optional restrained rabbit decoration | Explicit semantic shape wins; text selection and resize targets must remain precise |
| Busy | Familiar progress cue with optional rabbit motif | Only explicit busy/progress state; never infer busy because an app is slow or the pointer is stationary |
| Cancel / client loss / lock | Clear pending action and select the valid new owner's cursor | No stuck pushing pose, queued hop or stale client surface |

Compositor input can observe a held drag, but cannot know whether it is moving
a file, adjusting a slider or selecting text. Shape overrides preserve those
distinctions where supplied. Animations are feedback for input, not receipts
for successful application work. Touch/pen gestures and a per-device cursor
system are outside the initial mouse scope.

### Visual constraints

- Use original compact 2D artwork, not a large mascot sticker. Start by comparing
  24 and 32 logical-pixel canvases at scale 1; include larger physical assets for
  scaled outputs. Final size follows actual legibility/precision review.
- Fix one hotspot for each semantic family and keep it invariant across frames.
  A small high-contrast tip/nose marker anchors the click point; animate the
  body around it. Do not make the actual input position jump with the rabbit.
- Keep a stable canvas/bounds, crisp dark outline, light inner separation and
  restrained accent color so the cursor survives light/dark/busy backgrounds.
- Changing facing direction must not move the hotspot. Two direction variants
  are enough initially; eight-direction animation multiplies artwork/testing
  without improving basic interaction.
- Prepare roughly four to six frames for run and hop, and fewer for effort/
  press, then refine from actual pixels. SVG can be the source asset, but runtime
  should use validated, prebuilt cursor frames rather than decoding SVG per tick.
- Provide a static rabbit/reduced-motion mode and an explicit conventional
  cursor fallback. Missing/malformed theme data must produce visible diagnostics.

## Effort and staged delivery

Overall assessment: **medium difficulty** for a polished PollyOS default, not
a kernel or GUI rewrite. Static rabbit plus native resize/text fallbacks is
low-to-medium difficulty. Action-dependent animation with correct client
overrides, cancellation and mixed-DPI qualification is medium-to-high within
this feature; ownership/compatibility and small-scale artwork are the hardest
parts, not frame playback.

For planning only, allow approximately **10-15 focused engineering days** for
the default/shape bridge, action state machine, packaging and native acceptance,
plus **3-5 artwork days** that may overlap. This is an estimate, not a delivery
commitment: it excludes arbitrary user cursor uploads, animated cursors for
Windows/macOS, a broad theme editor, touch/pen and a full hardware matrix.

Suggested sequence:

1. Ship and verify a static rabbit theme plus standard shape overrides,
   focused-client authorization, scale/hotspot behavior and fallback.
2. Add movement, press, hop and effort state transitions using native input;
   reuse existing Xcursor loops and compositor deadlines for one-shot completion.
3. Qualify cancellation, hidden/custom/legacy client cursors, role transitions,
   mixed scales, software cursor paths and actual ISO resources. Then expose
   size/static-mode preferences without blocking the core mechanism.

Acceptance should check native cursor frames, hotspots and input timing, not
only compositor screenshots: hardware cursor planes may not appear in a normal
framebuffer capture. Measure cursor updates and output damage; hardware cursor
use is backend-dependent, so software fallback must also be covered. Idle state
must not run a continuous desktop animation loop. Pointer events must remain
immediate and not wait for an animation to finish.

No runtime code, asset pack, new version bump or ISO was created by this assessment.
