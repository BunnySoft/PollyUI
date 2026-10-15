# System cursor themes

PollyWM uses **PollyClassic (conventional cursors) by default**. The original
PollyRabbit theme remains an explicit option, including running, click-hop and
held-movement effort animation. These are native wlroots cursor themes, not a
hidden pointer plus an application overlay. The 2026-10-15 default change does
not alter historical Alpha.8 rabbit-default media, qualification or
`desktop/VERSION`.

## Resources and configuration

The installed layout is a conventional flat Xcursor theme:

```text
usr\share\icons\PollyRabbit\
  index.theme
  cursors\
    default
    motion
    press
    click
    drag
    drag-copy
    drag-move
    drag-no-drop
    text
    ew-resize
    ns-resize
    ...
usr\share\icons\PollyClassic\
  index.theme
  cursors\...
```

All 34 cursor-shape-v1 semantic names have resources. `motion`, `press`, `click`,
`drag` and the three native drag feedback variants are theme resource names,
**not new protocol enum values**. PollyClassic contains conventional precision
and status shapes and a classic default arrow.

The baseline is 32 logical pixels, with prebuilt 24/32/48/64/96 pixel images.
Output scale loading selects the closest available size through the native
manager. 1x, 1.5x, 2x and 3x are covered by the fixture; other scales use the
closest resource, not a claimed arbitrary-DPI hardware qualification.
Every rabbit frame uses the same hotspot, `(2,18)` in the 32px master. The body
can jump while the high-contrast input tip stays fixed. Fractional-scale
hotspots follow the public wlroots integer normalization; they never change
with animation frames.

Startup environment configuration:

| Variable | Values | Behavior |
|---|---|---|
| `POLLY_CURSOR_THEME` | unset, empty, or `classic` | Packaged conventional theme; no input-action animation |
| `POLLY_CURSOR_THEME` | `PollyRabbit` | Explicitly opt into the packaged original rabbit theme |
| `POLLY_CURSOR_THEME` | absolute theme directory | Read known flat `cursors\` names from that directory |
| `POLLY_CURSOR_STATIC` | unset/`0`, or `1` | Enable animation, or static rabbit/reduced motion |

Invalid settings fail startup explicitly. The packaged root is executable-relative,
so a relocated installation works without a source checkout. Only executables
inside the configured build directory use source-tree resources. No global
`XCURSOR_PATH`, host Xcursor configuration, or client environment is overwritten.
Explicit environment choices are preserved; this is not a saved GUI cursor
preference. There is no Appearance cursor selector. Settings theme editors,
upload UI, size preferences and a live configuration protocol remain deferred.

`desktop\tools\generate-cursors.py` is the original procedural pixel master.
It uses only Python's standard library. `--write` deterministically regenerates
the committed Xcursor files and `cursor-manifest.json`; without that switch it
checks exact bytes. Runtime never runs the generator or decodes SVG.
The artwork is original MIT-licensed repository work, not downloaded assets.

## Selection and animation

`desktop\compositor\cursor.c` owns native input feedback, owner state, resource
loading and completion deadlines. wlroots advances Xcursor frames. Re-selecting
the same manager/name does not restart playback on every mouse motion.

| State | Resource and lifetime |
|---|---|
| Idle | `default`, one static image; no armed action or frame-animation timer |
| Motion | Four distinct `motion` poses at 70ms/frame; stop after 120ms without motion |
| Primary button held | Static crouched `press` |
| Primary release below 5px click slop | Five-frame, 200ms `click`; one hop, no queue or delayed input |
| Held movement beyond slop | Four `drag` effort poses at 80ms/frame; no file-operation badge |
| Compositor window move | Effort pose for the actual grab lifetime |
| Compositor resize | The corresponding conventional directional cursor, not a rabbit pose |
| Confirmed native data drag | Actual origin ownership; copy/move/no-drop feedback when native source negotiation supplies it |
| Wheel | Does not start a run or hop |

Repeated clicks replace, rather than queue, a hop. Other mouse buttons still
show press/effort feedback but do not trigger the primary hop. Completion
recomputes the current owner/action, never restores a cached stale cursor.
These are input feedback animations, not proof that an application operation
succeeded. Native drag action is sampled at 80ms intervals **only during the
confirmed drag**, because wlroots exposes the action as source state rather
than an action-change signal. No idle or global JS polling is used.

Reduced motion keeps the resting rabbit and still supplies static native drag
status indicators. Classic mode uses conventional status shapes. Lock surfaces
do not receive mouse-action animations. Input isolation, last-pointer loss,
cancelled native drag, client/image destruction and grab teardown retire pending
feedback. Shutdown unsets the cursor image before freeing themes, removing both
compositor deadlines and wlroots frame timers.

## Ownership and compatibility

The standard `cursor-shape-v1` manager is advertised to ordinary pointer clients.
The pinned SDL backend already negotiates it; wlroots/SDL themselves are not
patched. A request must come from the current seat's focused pointer owner or
actual native drag origin, with that owner's current enter serial (or the
authorized drag serial). Foreign, zero, stale and unsupported-device requests
are rejected. Protected lock roles retain their existing admission boundary.

Priority is compositor resize/move and protection, then the current authorized
client's explicit semantic/custom/hidden cursor, then the system default.
Text, directional resize, crosshair, permission and other non-default semantics
do not acquire rabbit mouse-action animation. Each live surface's requested
state is retained and restored when that surface becomes current again;
destruction removes it. The drag source owns its cursor, not the hovered drop
target.

An authorized `wl_pointer.set_cursor(NULL)` means **intentional hiding**, not
inheritance. An arbitrary legacy image/hotspot is respected and not inspected
for image recognition. Destroying an explicit image leaves that owner's cursor
hidden until another request. Legacy image clients cannot be promised
compositor-owned rabbit action animation.

The existing `window.setCursor('arrow')` maps through SDL to semantic DEFAULT,
so it selects the **current theme default**: normally Classic, or the rabbit
when `POLLY_CURSOR_THEME=PollyRabbit` was explicitly selected.
The protocol cannot recover a distinct classic-arrow intent that the SDK did
not send. Choose `POLLY_CURSOR_THEME=classic` for that system theme instead;
no new GUI API or per-window classic-arrow override is introduced here.

## Fallback and packaging

The small directory loader bounds file size, TOC and selected frame counts,
dimensions, chunk versions/lengths, hotspots, delays and premultiplied ARGB.
It reads resources only on startup or first use of an output scale, never on
each mouse event. It installs owned image buffers into public wlroots theme/
manager objects and uses their normal destruction APIs.

A missing or invalid action falls back to that scale's theme `default`, with
a diagnostic. A missing default disables that scale's rabbit action resources
and uses the packaged conventional default. Missing precision shapes use their
matching PollyClassic resource, never a rabbit. If even packaged conventional
resources are unavailable, matching standard wlroots conventional fallback
families are attempted; absence of a usable matching shape fails explicitly.
Malformed, missing and conventional-fallback cases are not silent successes.

CMake installs both themes and metadata. Package required-file inventories
include every shipped cursor name; source-to-install hash checks explicitly
map `usr\share\icons\PollyRabbit` and `PollyClassic` to their original source
resources. Cursor sources, generator and metadata enter runtime source hashes.
No ISO rebuild or receipt mutation is required by this source change.

## Native checks and evidence

The bounded `desktop-cursor-native` fixture reuses the real Wayland test client
and physical-style native pointer events. It reads **actual
`wlr_output_cursor` textures** through the public texture readback API and
compares their pixels/hotspots with loaded Xcursor frames. It covers movement
without playback resets, the hop and completion, effort, semantic and legacy/
hidden overrides, invalid owner/serial admission, native copy/move/no-drop
negotiation, cancellation, current-owner restoration, scale changes and input
isolation. Existing integration/session-lock fixtures cover grab and protected
role lifetimes; cursor-specific lock assertions check timer retirement and
the native cursor.

`desktop-cursor-resources` independently parses committed Xcursor files,
checks all frames/scale metadata and original hashes, then compares actual C
loader/output texture bytes for unset/empty Classic defaults, explicit rabbit,
static rabbit, explicit classic, missing and malformed themes.
`desktop-cursor-assets` checks deterministic regeneration.
`desktop-cursor-choice` directly checks the native default-selection helper.
Animation and cursor-related lock tests explicitly select PollyRabbit; run
direct animation fixtures with `POLLY_CURSOR_THEME=PollyRabbit` as well.

For persistent evidence, set the **test-only fixture**
`POLLY_CURSOR_EVIDENCE` to an existing output directory, run the native fixture,
then use `cursor-resources.py ... --render-only <directory>` to produce PNGs
and `native-frames.json` from recorded ARGB bytes. Contact sheets identify
cursor-plane/source-asset evidence, not framebuffer screenshots.
Normal framebuffer captures may omit a hardware cursor. Headless Pixman
software-cursor checks do not qualify hardware cursor planes, a real machine,
all platforms, or an ISO. Touch, pen and multi-pointer behavior remain deferred.
