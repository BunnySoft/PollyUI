# Runtime desktop themes

PollyShell JavaScript owns theme selection, user overrides, preference writes
and its desktop UI. A separate windowless PollyUI decorator paints server-side
window decorations in JavaScript. PollyWM accepts geometry from the private
Shell publisher and complete immutable frame strips from the private decorator
renderer; those roles cannot be exchanged. It does not interpret theme files
or execute theme code.
File traversal, ownership checks and resource limits are implemented in
`shared/theme-resources.mjs` over the native FileSystem SDK; the old theme-file
C bridge is removed. Each service operation checks its compositor-owned
connection and fixed role. Native file mappings themselves have no theme policy.

## Data and ownership

`resources/themes/builtin.json` contains **Polly / Modern** and five retained
classic presets. Modern now targets Windows 11 24H2 light geometry, not Windows
10. Modern is the default only for fresh or
unavailable configuration; saved classic choices and user overrides are not
silently rewritten. It uses a solid 48px taskbar, centered icon tasks, a 32px
caption content band with 46x32px controls, and original Polly artwork.
No proprietary platform logos/assets are bundled. This preset does not
automatically enable a material or blur; the separate
[opt-in wallpaper-derived client helper](../gui/sdk/CANVAS.md#opt-in-wallpaper-derived-client-base)
is not native DWM Mica or compositor Acrylic.
`resources/themes/fallback.json` is a packaged recovery catalog.
`shared/ui/theme-schema.mjs` defines JSON schema version
1 and validates every supported field. Accepted snapshots are deeply frozen.
The catalog has `{schemaVersion, default, themes}`; a single user theme has
`{schemaVersion, theme}`.

A theme contains `id`, `name`, `era`, `desktop`, `colors`, `window`, `icons`,
`button`, `panel` and `layout`. Copy a complete preset object from the shipped
catalog when authoring a new theme; do not omit required fields. Its ID must
match `[a-z][a-z0-9_-]{0,63}`.

User themes are read from:

```text
$XDG_DATA_HOME/pollyui/themes/<id>/theme.json
```

The data-home fallback is `$HOME/.local/share`. A user theme cannot replace a
shipped ID; use the override file instead. Directories and files must be owned
by the session user and not group/world writable. Path traversal and symbolic
links are rejected. Missing optional user directories are normal; malformed,
inaccessible or unsafe entries produce an explicit error.

## Limited overrides

Save this example as `$XDG_CONFIG_HOME/pollyui/theme-overrides.json`
(`$HOME/.config` when the XDG variable is unset):

```json
{
  "schemaVersion": 1,
  "themes": {
    "bigsur": {
      "colors": {
        "accent": "#6750a4",
        "focus": "#e1b740"
      },
      "window": {
        "titleFrom": "#34495e",
        "titleTo": "#34495e",
        "titleText": "#ffffff",
        "fontSize": 18,
        "fontWeight": 700
      },
      "layout": {
        "menuBarHeight": 30,
        "dockBaseWidth": 360
      }
    }
  }
}
```

Overrides replace selected fields in visual groups; other values stay with the
base theme. Arrays replace whole arrays. Unknown fields, IDs, schema versions,
prototype keys, invalid colors and unsupported geometry are rejected. There are
no executable hooks, imports, conditionals or recursive inheritance rules.

Scalar ranges alone do not guarantee a usable combination. For `panel.kind`
`dock` with `surfaceStyle` `tiger`, `lion` or `bigsur`, the explicit icon size
`I = layout.dockIconSize ?? 48` must not exceed
`Math.min(layout.dockTileWidth, layout.dockWindowWidth, panel.height - 12, panel.height + 2 - 2 * M)`.
`M` is the running marker height: 4 for Tiger, 3 for Lion, otherwise
`layout.dockIndicatorSize ?? 4`. This follows the existing slot height
`panel.height - 4`, 8px bottom padding and marker bottom offset 1px. Icon and
marker may touch; no extra blank pixel or automatic shrinking is required.
Generic Docks and taskbars do not acquire this styled-Dock constraint.

This is an intentional compatibility tightening: previously accepted non-fit
files and overrides now raise
`RangeError: Dock icons and running indicators do not fit the configured slot/panel geometry`
through the existing rejection path. For example, height40/icon48,
icon96/default58px slots, and Big Sur height69/icon48/marker12 reject.
Defaults, Lion's icon48/window48 custom geometry and Big Sur's
height88/icon64/slot72/marker12 remain valid. Explicit icon96 remains supported
with both slots96 and height108 (marker4); height70/icon48/marker12 is also
valid at the touching boundary. There is no forced global icon size.

In **Appearance**, choose **Reload theme files** to load changes and
apply them to the selected theme, including changes under the same ID. There is
no file watcher. **Use packaged themes** restores a shipped appearance and
persists the choice to ignore user files; it does not delete those files.
Reloading enables user files again.

A rejected reload keeps the current catalog, native decoration state and live
bitmap. If the selected theme was removed, restore a packaged theme before
reloading. On cold startup, invalid user files recover to packaged themes with
a visible warning rather than claiming that the requested files were applied.

## Supported appearance parameters

- `window`: active/inactive colors, border/title dimensions, control size,
  spacing, inset and radius, control gradients, glyph dimensions/visibility,
  stripe treatment, hover/inactive mixing, gradient direction, caption font
  family, size, weight and alignment. `fontFamily` accepts the three existing
  generic names or a bounded literal installed family name, not a path, URL,
  font resource or comma-separated list. No font is downloaded or bundled,
  and a missing family still uses the GUI backend's existing fallback.
  Text and controls must fit their
  configured titlebar. Optional `controlWidth` (8-96) and `controlTop` (0-64)
  give genuinely rectangular buttons; `controlSize` remains their height.
  Absent fields preserve the old square/centered geometry. Round controls must
  be square. Fractional decoration parameters use 0.001 precision.
- `layout`: typography roles, panel/menu-bar geometry, Dock tiles/window
  buttons, popup preferred dimensions, spacing, borders, tray layout,
  notification layout and switcher capacity. Existing layout kinds remain
  taskbar or menu-bar/Dock; configuration does not add arbitrary UI templates.
- `desktop`: base gradient, bounded rectangle/rounded-rectangle layers, and an
  optional local bitmap. Wallpaper primitives are data, not preset-specific
  JavaScript drawing branches. Layers specify geometry, radius, rotation,
  opacity, border and gradient colors; at most 128 are accepted.
- `colors`, `button`, `icons`, `panel`: shared palette and component treatments.
  Actions, focus policy, keyboard bindings and workspaces remain code-owned.

### Desktop shortcut labels

Optional `icons.desktopLabelStyle` accepts only `capsule` or `shadow`. Omitting
it, including in existing schema-1 user themes, preserves the original dark
unselected capsule. An explicit `capsule` override restores that appearance
on any preset. `shadow` gives unselected labels a transparent background and
white native text with a black copy offset down one logical pixel. This is a
JS text-layer treatment, not native CSS `textShadow`, a blurred shadow, or
bitmap text. It does not change the 12px font, padding, native line wrapping,
86px maximum label width, 44px clipping height, or 36px bitmap/fallback icons.
The decorative copy is absolutely positioned, pointer-inert and `aria-hidden`;
the real option retains its single `aria-label`. Selected labels retain the
existing selection/text colors without a shadow. Hover/focus borders,
unavailable descriptions, launch policy and persisted icon coordinates remain
unchanged.

Only shipped Tiger/Aqua and Big Sur opt into `shadow`, in both catalogs. The
downloaded Tiger desktop and Big Sur desktop references show white shadowed
labels without a filled capsule. Big Sur's companion About image identifies
an 11.0 beta; neither reference certifies exact fonts, shadow pixels or
selection/hover states. The Lion desktop reference has no visible desktop
icons, so its shipped label appearance stays unchanged pending qualified
evidence. Finder and Dock icons are not desktop-icon references. No Apple
icons, fonts, wallpaper or new application-menu business are introduced.

`tests/desktop-labels.mjs` checks optional-field validation through file,
catalog and override parsers, old-theme compatibility, and label/option
structure. `tests/desktop-label-render.mjs` exercises actual 640x320 GUI
rendering for the three Mac presets and an unchanged XP control: short,
long/clipped, explicit multiline, Unicode and unavailable labels, a registered
original bitmap and procedural fallback, selection, native hover/focus,
label single/double-click, Enter, drag persistence and marquee selection.
Main label boxes and wrapping are unchanged; decorative text shares the main
native line width and metrics.

A bounded private Wayland run also exercised Tiger/Big Sur at real virtual
output scales 1, 1.5 and 2, with 1280x720 physical captures, native seat selection
and Enter at each scale. The current JS ran on the existing cached compositor
fixture and generic GUI runner; this is not a current full-native rebuild,
physical-monitor or macOS certification. DOM roles, names and hidden-copy
attributes are checked, but platform accessibility-tree/screen-reader
verification remains unavailable and is not inferred from `textContent`.

Optional `surfaceStyle` selects a bounded painter, not executable theme code:
window supports `generic`, `luna`, `classic`, `fluent`; button supports `generic`,
`luna`, `classic`, `aqua`, `fluent`; panel supports `generic`, `luna`, `classic`,
`fluent`, `tiger`, `lion`, `bigsur`. Absence preserves the generic path.
Classic paints raised/sunken frame edges and a horizontal caption gradient.
Fluent paints full-bleed caption button backplates, including close hover/press.
Its inactive caption glyphs consume `window.inactiveText`; active glyphs retain
`controlText`, and close hover/held glyphs remain white at either activation
state. This restores the state/color selection from the removed C painter
(`5bb181c^`), without changing button geometry or backplates. The actual GUI
fixture `tests/fluent-caption-inactive.mjs` covers inactive normal/hover/held/
restore, active-state invariance, custom inactive ink, narrow windows and 1.25
scaling. This verifies the existing theme contract, not build-tagged Windows
11 24H2 raw pixels or native compositor input.
GUI captions consume the exact button/text rectangles used by compositor hit
testing, rather than recomputing them from style names.
Private appearance protocol v6 uses bounded numeric geometry schema 6 and separates
the publisher and renderer roles. Previous private Shell/WM/decorator combinations
are explicitly rejected; public JSON schema 1 and the read-only application
theme subscription remain unchanged. This paired
upgrade/removal of the C painters follows the user's explicit choice:
“接受同版本成套升级，移除旧 C 主题绘制路径（推荐）”.
There is no legacy theme-ID selection or automatic schema downgrade.
Rejected startup fails explicitly. Rejected theme
changes retain the live snapshot and saved preference; transport loss and
uncertain commits are reported rather than treated as success. Reference scope, original-art
rights and outstanding native acceptance are documented in
[Blue Luna](resources/themes/XP-LUNA.md).

## Decoration execution boundary

`shared/ui/caption-layout.mjs` compiles visual layout choices into bounded
geometry. C validates those dimensions and owns window management, input,
hit testing, DPI conversion, configure/ack fencing, lifecycle and buffer
composition. Generated C fixtures are test-only: no preset catalog, colors,
font families, glyph rules or style/painter IDs are compiled into the WM.
An explicitly client-decorated or frameless application keeps that contract.
Bare WM operation without a configured service or a published theme can negotiate
client-side decoration; it does not claim independent server-side frames.

`shared/ui/caption-paint.mjs` uses the existing GUI's detached Canvas2D and text
shaping. `shared/ui/decoration-renderer.mjs`, called by `decorator/main.mjs`,
services the private render queue in a separately supervised `pollyui --decorator`
process. Its unowned Document has `defaultView === null`: it creates no SDL
window, hidden Wayland surface or test-host canvas. Wayland, dispatcher, timer
deadlines and shutdown wakeups drive a blocking event wait, not a fixed frame
tick. Neither detached canvases nor pattern tiles create native windows.
PollyWM contains no JavaScript engine, GUI instance, theme-specific painter or
second font cache. No application content is sent to the renderer.

The Shell remains the only preference writer and may publish a new theme at any
time. A WM-session latch permits the decorator to bootstrap only before any
legal theme commit and while no valid Shell transaction is staged. The decorator
reads existing Shell preferences and user theme files without creating storage,
taking writer locks or migrating data. Missing data uses the packaged default;
invalid/unsafe data reports an error before an explicitly qualified default.
An existing valid WM snapshot is never replaced by that fallback. Shell prepare
takes priority, and prepare/commit both recheck authority; the first legal commit
permanently consumes bootstrap authority, including across renderer reconnects.

Active Luna caption text has a hard shadow using the current title text color
mixed 70% toward black, drawn before the foreground at a one-logical-pixel
right/down offset. This restores the design from `draw_text` in the removed C
painter (`5bb181c^`), not a new XP pixel oracle. Both passes share ellipsis,
alignment, baseline and the native text rectangle clip. Existing Canvas scaling
scales that logical offset; unlike the old C loop, fractional offsets are not
rounded up to whole backing pixels. This increment deliberately leaves inactive
Luna and non-Luna text unchanged; the old C loop also shadowed inactive Luna.
`tests/luna-caption-shadow.mjs` checks actual GUI strip pixels, clipped long and
empty/narrow titles, 1/1.25 scaling and unchanged inactive/non-Luna output.
It does not certify XP SP3 fonts, native compositor input or OS-exact pixels.

One response contains top, left, right and bottom strips in a single sealed
memfd. Logical strip dimensions are `(clientWidth+2*border,titleHeight)`,
`(border,clientHeight)` twice, and `(clientWidth+2*border,border)`.
Backing dimensions are the ceiling of logical dimensions times output scale;
zero-border strips have zero bytes. The native codec validates exact width,
height, stride, offsets, total size and immutable regular-file seals. It converts
GUI straight-alpha RGBA into premultiplied ARGB; it does not choose colors.
Frames are limited to 16,777,216 total pixels and 32,768 pixels per axis, with
a 128MiB aggregate live-mapping budget. Requests coalesce per window; the native
renderer queue is bounded to 128. There is no palette map, per-frame timer loop
or per-title native surface.

Non-reused window tokens and frame revisions bind theme generation, geometry,
scale, state and layout rectangles. Stale/duplicate frames are rejected.
Invalid/partial data cannot replace any strip or hitbox. A complete scene and its
layout switch together, after the applicable client configure acknowledgement;
unchanged client buffers retain their idle-reuse path. Individual windows may
retain an earlier complete snapshot while their new geometry/frame is pending.
This is not a global barrier that freezes every application's content.

Shell disconnect/restart does not stop the decorator or remove the current
theme, unless the explicit session-exit policy also terminates the WM. A failed
or unresponsive renderer (1000ms without a complete requested
frame) reports failure, cancels pending requests and retains the last complete
presented frame. New geometry/revisions remain pending rather than stretching
old strips, silently switching to CSD or claiming success. WM input never waits
for JavaScript.

The WM supervises the renderer independently, with three bounded automatic
restart attempts. A new private renderer clears obsolete requests and reissues
fresh revisions against the current snapshot; only complete matching frames
advance presentation. Exhaustion is an explicit failed service, not logout or
an instruction for ordinary applications to draw missing frames. Unmap,
destruction and actual session shutdown reclaim owned requests/scenes/FDs.
There is no hidden C style fallback. Frame rejection is distinct from ordinary
obsolete replies, which return `false` rather than pretending a new frame was
displayed. See [session startup and supervision](SESSION.md).

## Alignment scope and evidence

The fixed targets are XP SP3 Luna, Server 2003 SP2 Classic, Windows 11 24H2
light, OS X 10.4/10.7 and macOS 11 at 100% scale. The bounded component list,
reading sources, font references and **uncertified version/DPI/rights gaps** are
in `resources/themes/alignment-reference.json`. Its geometry is an implementation
target, not an assertion that an untagged public screenshot proves a service pack.

XP Start uses a two-column header/link layout; Server 2003 uses a gray two-column
menu with a horizontal caption-colored header and bevels; Modern uses a centered,
searchable application grid and footer. Visual Classic and legacy single-column
Start are not synonyms. Optional `panel.menuStyle` (`legacy`, `two-column`, `grid`)
selects structure independently of its painter/palette. Omission retains the
previous style-derived defaults, and `server2003` explicitly selects `two-column`.
Set its `panel.menuStyle` override to `legacy` to retain the compact single column.
Optional `layout.menuSideWidth` and `menuIconSize` control side/app geometry.
`menuVerticalInset` applies only to menu sizing; absence uses `overlayInset`,
so changing the Server menu fit does not alter other panel margins.

### XP taskbar and Start surface coverage

The bounded E22.13 surface uses [XP-LUNA](resources/themes/XP-LUNA.md),
`xp-reference.json` and `alignment-reference.json` as design/geometry references,
not certified SP3/DPI raw-pixel oracles. Existing colors and artwork are unchanged.

| Surface | Verified existing contract / correction | Remaining boundary |
|---|---|---|
| Taskbar and green launcher | Actual 30px bar, default 97px launcher, band/tint hover/held/cancel; `layout.launcherWidth` now controls actual launcher layout and hitbox (tested 123px) | Reference lacks certified launcher hover/held state crops; original Polly mark is not Windows art |
| Active/inactive tasks and compact tools | Actual 26px tasks, single activation, keyboard focus; overflowing task strip remains wheel-accessible at narrow width | Settings/workspace shortcuts are real actions, not a full configurable historical Quick Launch implementation |
| Cyan notification area and clock | Actual 30px area and visible clock; existing tray/notification paths retained | No full SNI external-icon/state or original-font pixel certification |
| Start header, left apps and Search/Pin | Actual 64px header, 380x480 default menu; left list scroll, disabled app, single launch/Pin and text search retained | Header is original Polly identity, not a real account/profile; Programs cascade is absent |
| Right links and column separator | Existing Settings/Refresh/Close rows and palette/border retained; XP right column now independently scrolls and locally reveals focused commands using existing unscrolled offset/scroll metrics | No invented categories/group dividers without backend groups or qualified state references; Classic and other preset paths unchanged |
| Footer and low-height fit | Actual 42px footer stays fixed with header while either column scrolls; logout remains reachable at 360x260 local layout | Below the combined fixed header/footer/Search minimum, fitting all content requires a separate layout policy; this batch does not change menu preferred height or global insets |

`tests/xp-shell-surface-render.mjs` exercises actual `panelView`/`applicationsView`
and host input. At 800x600 the default before/after PNG bytes match. In a 360x260
layout inside the same 800x600 GUI surface, the 206px menu has a 100px right
viewport: Close previously extended below it, and now wheel/focus scroll 20px
to reveal the full command. Header/footer rectangles do not move; reverse wheel
clamps at zero and repeated focus does not jitter. This is actual component
layout/input evidence, not a native compositor output resize or XP fidelity score.

### Fluent taskbar and Start surface coverage

The bounded E22.22 correction follows the existing Modern/Fluent design and
catalog, not a certified Windows 11 24H2 raw screenshot. Palette, fonts, theme
schema, caption painting and application/backend actions are unchanged.

| Surface | Verified contract / correction | Remaining boundary |
|---|---|---|
| Icon task states and focus | A Fluent-only task variant supplies both initial and event paint: active uses `button.from`, inactive is transparent, hover uses `colors.selection`, held uses `button.to`, with transparent gradients. Leave/cancel/blur restore the original face. Existing stretch focus detail is retained alongside the 16px/6px running markers. Shared physical-state tracking preserves current hover/held/focus through clock reconciliation and immutable retheme, applying the new palette; cancellation and disabling clear obsolete gestures | These are existing theme design colors, not measured Windows state-color errors |
| Centered group and notification area | Measure actual fixed slot, task and notification-area widths after layout; keep the full group centered when it fits before the tray, otherwise retreat into the available interval. The 800px default remains at x280/width240. At 360px it is x12/width226; at 260px x12/width126. Notification/clock remain outside it. The task strip retains at least one configured task width; when fixed actions also overflow, the group independently scrolls and local focus reveals the inner viewport. Inner task wheel does not scroll the outer group | A tray consuming almost the entire output can leave less than one full configured slot; this is a physical layout boundary, not a claim of complete fit at arbitrary width/item count |
| Nested Start app and Pin focus | Chain the existing focus handler through inner and outer viewports. At 640px/available660 the last app/Pin scrolls 46/68px and Search/footer stay fixed. The follow-up fixes the former collapsed 180px menu: its app/Pin body is now 118px, with outer maximum146. The full 80px app and 20px Pin, Search, Refresh, Close and logout have real pointer/keyboard access without shrinking fonts or controls. Inner wheel consumes movement before chaining at its boundary. Filtering and retained growth clamp stale scroll; unchanged reconciliation does not undo manual scrolling | Whole-menu scrolling intentionally moves Search/header/footer only when their existing chrome and one card cannot fit. A 40px root exposes at most 40px of an 80px app, not full fit. Initial pre-layout Search focus does reveal all 32px in that root, using outer16. This is not certification at arbitrary geometry or a new native popup/input mechanism |
| Native owner sizing/lifetime | Subscribe after attachment, not the earlier ownerless mount. Actual host-only 240→680→240→680 resize completes in three bounded layout/reveal frames; later business `onstatechange` remains intact. Leave cancels pending frames and unsubscribes. A closed subscribed panel, its Document and handle all collect after GC | Uses generic owner/state APIs, weak remover values and owner-free finalizer tokens; no C theme painting or periodic layout polling |

`tests/fluent-shell-surface-render.mjs` exercises actual views and host input in
an unscaled 800x700 raster fixture, with local 800/360/260px taskbar layouts,
an existing tray item, and legal unequal launcher/task widths (60/52px).
The local placement uses `L = panelPaddingLeft`, `R = actualTrayLeft - panelGap`,
and `width = min(desiredGroupWidth, R - L)`; its left edge clamps the preferred
screen-centered position into that interval. Owner-state observation and bounded
post-layout frames remeasure geometry; no polling or native appearance branch is
added. The complete default 800x48 taskbar pixels are unchanged before interaction.
The normal 640x580 menu's complete fixture PNG is unchanged. Its two-frame
layout synchronizer also handles initial pre-layout focus and safely ignores
a root reused as another scroll view. Component rendering/input and the
separate native owner probe are not native output-resize, Windows pixel or
arbitrary-geometry accessibility certification.

True recommendation/account history still needs backend/design decisions.
Application grouping and independent persistent pins are described below.
Full-window corners/shadows use the separate native-effects contract;
solid/gradient painting is not represented as Mica/Acrylic.
E22.22 remains partial.

Classic follows the supplied Windows Server 2003 references: flat faces and real
pixel bevel layers, not simulated blur or a modern gradient. Standard WinForms
controls in that system theme share this appearance; WinForms is not a separate
theme or a runtime dependency here. Menu frames use three layers;
buttons use raised/sunken two-layer edges and the tray a single inset edge.
Those painters own their edges: a generic one-pixel outline must not paint over
the light/shadow layers. Optional `panel.taskTexture` is `flat` by default or
`stipple`; only the Server preset opts into stipple. Selected tasks use the
theme's body/light colors in an original procedural 2x2 repeat. Temporarily
pressing an inactive task does not select that texture. Focus uses a paint-only
one-pixel repeat outline; cancellation, selection loss and retheming clear stale
pixels without changing pointer, hitbox or accessibility ownership.
Task content shifts by one pixel when active/pressed, without moving its hitbox;
pointer cancellation restores inactive content. `taskIconSize`/`taskPaddingX`
control Classic task slots. The 28px bar retains its measured 2px top chrome,
22px controls and 2px inner top/bottom gaps.
Optional `menuLeftInset` and `menuBottomOverlap` refine only menu placement;
omission preserves the existing left inset and zero overlap. The existing
placement helper can take available width to clamp against those margins.
The supplied lossless WebP's face/shadow colors match RGB565 quantization of
the canonical Classic palette. That is not verified display-depth metadata:
the product keeps canonical 24-bit colors, and raw comparison error is not
normalized or forced to zero.
Only actual installed entries/actions are shown: no fake recommendations,
account history or nonfunctional search. Classic's All Programs defaults to a
flat list inside its existing RootMenu client. An optional Categories entry
derives nonexclusive exact tags from the actual catalog, including a distinct
no-tags group; it is not an installed-directory hierarchy. It uses real catalog
IDs and existing launch/Pin services, preserves two-column and legacy layouts,
and supports hierarchical Back/Left/Escape, header/list Tab navigation and bounded
scrolling. Stable per-view row slots and menu epochs prevent a held or retired
row from activating another application. Category actions require successful
catalog refresh and current membership; discovery failure reports an error and
retains the previous visible catalog without authorizing an action from stale
data. The submenu stays inside the existing input viewport; no native popup or
new authority is added.
See [the Shell contract](shell/README.md). Multi-level directory menus, true user
account/profile art, and Win11 recommendation/account features are not reproduced.
Existing application launch, desktop shortcut, keyboard and logout actions remain
connected. E22.15 therefore remains partial.

Mac menu-bar commands keep their existing explicit square-corner treatment
through pointer, focus and reconciliation states. A component-local button
radius of zero is shared by their factory and state painter; ordinary buttons
still consume the original theme radius. A menu-only `WeakMap` reuses that derived
object for each immutable source theme, so clock-driven reconstruction does not
reset hover/held state on the retained menu node. A new source theme gets a new
derived object and palette while the shared control-state cache preserves only
the live physical gesture/focus. Actual cancel, capture loss or disabling clears
that gesture instead of treating theme identity as a cancellation event.
Previously the default Tiger/Aqua
surface painter changed the menu-item radius from 0 to 8 after input. Default
Lion/Big Sur use the generic path and were not affected; their supported
`button.surfaceStyle: "aqua"` overrides exercised the same defect at radii 3/5.
`tests/mac-menubar-state-render.mjs` checks those positive/negative paths with
actual GUI pixels and one-click activation. This restores local override
consistency, not a claim about authentic OS menu highlight shapes or Mac input.

The three Dock painters have real icon slots, separators and running indicators:
Tiger has triangles and a 2D rim, Lion has a perspective shelf and luminous
indicators, Big Sur a floating rounded rectangle and dark dots. Minimized windows
are still running. These are **opaque material approximations**, without
compositor blur, reflection, wallpaper tint, magnification or authentic OS icons.
Tiger's four one-pixel triangle rows honor `layout.dockIndicatorSize` (2-12)
with centered integer insets, retaining the default 7x4 geometry. Very narrow
even widths degenerate to a symmetric bar rather than spilling outside the
configured container or introducing fractional-pixel blur. The width-only
increment preserved the default pixels. Its actual GUI evidence exposed the
fourth row being clipped by the bottom rim; a separate follow-up moves only
Tiger's indicator one pixel up, preserving the rim and showing all four rows.
The default two-window 400x100 fixture intentionally gains 14 black pixels;
this repairs the local 7x4 visibility contract, not OS-exact placement.
`tests/tiger-dock-indicator-render.mjs` records the actual visible rows at 7/2/12,
running/minimized state and narrow-Dock scroll/click/focus behavior. This is local
configuration consistency evidence, not a Tiger raw-reference or native Mac
platform acceptance.
Lion's existing `panel.from` controls the upper shelf face and `panel.to` the
four-pixel front face. The painter previously ignored both fields; their shipped
values already matched those two hardcoded colors, so consuming them preserves
default pixels. The neutral top highlight, lower shelf band and front-edge
declaration remain separate detail colors, not a promise that these two fields
tint every layer. Tiger/Big Sur keep their existing root-gradient consumers;
the Mac menu bar still uses `window.titleFrom/titleTo`.

The bounded Lion Dock coverage in `tests/lion-dock-surface-render.mjs` is local
design/field-consumption evidence on an actual Windows GUI raster surface:

| Area | Result and boundary |
| --- | --- |
| Palette entry points | Confirmed defect fixed: accepted `panel.from/to` overrides now affect the upper/front faces; default 400x120 PNG is byte-identical. Top/lower neutral bands stay unchanged. |
| Existing geometry | Pass: 24 perspective rows plus 4px front, separator, default 317x66 Dock and 56px window slots; one legal custom 289x74 Dock with 48px slots and 12x3 indicators. This is not every accepted size or a raw OS geometry oracle. |
| Running and input states | Pass: active/minimized remain running; normal/hover/held/focus, same-node reconstruction, single-click callbacks and fixed Apps/Settings/About work; narrow window strip scrolls and reveals the final minimized window on focus. Indicator antialiased edge pixels naturally blend with the newly configured front color. |
| Reference qualification | Partial: same-setting licensed OS X 10.7 raw captures and font/icon/scale metadata are still missing. 48px icons and no magnification are comparison conditions, not forced system defaults. |
| Mechanism/business gaps | This palette checkpoint did not implement real glass, shadow/reflection, application grouping, pinning or magnification. Grouping and independent persistent pins are now delivered separately below; glass/reflection, preset effect adoption and magnification remain separate work. |

The bounded Big Sur caption check in `tests/bigsur-caption-surface.mjs` found
**no confirmed product defect and makes no painter/preset change**:

| Area | Current coverage and remaining boundary |
| --- | --- |
| Geometry | Actual detached GUI Canvas uses supplied rectangles: default 12px round controls at close/minimize/maximize x=12/32/52, y=8 in a 28px title strip; one accepted custom 16px/34px allocation and widths 1/20/44/64/300 fit without stretching strips. The fixture mirrors the metadata grammar; it does not certify native hit testing or generate an OS oracle. |
| State/field consumption | Pass: active/inactive, each hovered control and valid held+hover pairs; group glyphs are hidden at rest, present in all three controls on hover. Recoloring glyphs and changing inactive opacity only affect their owning control rectangles; held changes stay in the pressed control. Custom always-visible glyphs use their configured ink. |
| Text/scale/isolation | Pass: empty/long/narrow titles stay inside supplied text clips and do not alter edge strips; custom 1.25 backing dimensions are ceiled. Five other presets retain byte-identical before/after probe strips. This is not a full DPI/font or compositor-input matrix. |
| Reference/behavior qualification | Partial: deleted C prior art (`5bb181c^`) showed hover glyphs per control, while current JS shows the group. Neither is a licensed Big Sur state oracle; this audit preserves current behavior rather than silently choosing a different default. Native macOS/Metal, exact inactive colors and authentic maximize/fullscreen glyph art are not certified. |
| Mechanism/content gaps | Unchanged: genuine window shadow/vibrancy/backdrop blur, unified client toolbars, proprietary font/icon resources and native macOS acceptance need separate evidence or implementation decisions. |

Modern and all three Mac presets now explicitly select optional
`panel.taskGrouping: "applications"`. One shared `windowTasks` model groups
nonempty exact native `appId` values; missing/empty IDs remain independent
`Window.id` tasks. Catalog names use an exact entry ID first, then a unique
explicit `X-Polly-AppId` (validated manifest ID for bundles); an ambiguous
registration keeps the real app ID. No title, PID or basename aliases are inferred.
Taskbar and Dock tasks now reuse the desktop's existing bounded bitmap resource
cache for registered PNG/JPEG artwork, retaining the union required by desktop
shortcuts and current tasks. Images keep their original colors and slot sizes;
missing, named, SVG or unsupported resources retain explicit fallback/reporting.
This does not add an icon-theme resolver or claim that unavailable artwork has
been rendered end to end.
Files, Settings, Processes and File Text now ship original Polly PNG tiles and
explicit runtime IDs, so their own registered resources can reach desktop,
menus and running groups. Installation resolves absolute icon paths against
the actual prefix, including packaging's `--prefix` override. The artwork is
Polly-owned, not commercial-OS icon replication.
Missing grouping or explicit `"windows"` preserves the original input order
and per-window interface; Classic and XP keep that mode.

The same display-task count drives rendering and Dock width. Multi-window
groups open the existing bounded RootMenu chooser, with real activate,
minimize/restore and close-window actions. Mac single-window clicks activate
or restore, not minimize the active application; Modern keeps its single-window
toggle behavior. Stable vacant row slots and workspace/member/action guards
reject stale held targets, including live native changes not yet notified to
the Shell. Keyboard focus and wheel scrolling reach the final command even
when the list is shorter than a complete member row. The chooser consumes the
same passive menu surface policy as other panels, without new native authority.

The task strip scrolls horizontally when clamped; fixed Apps/Settings/About slots
do not shrink, and focusing an offscreen task reveals it. The pure
`dockSurfaceWidth`/`applicationMenuPlacement`/`applicationMenuHeight` functions are the Shell consumer
seam; they do not create surfaces or change state by themselves.
`tests/window-groups.mjs`, `tests/menu-host.mjs` and
`tests/window-group-render.mjs` cover the model, live guards and actual GUI
input/native child bounds using nonempty-appId fixture snapshots. They do not
certify full-WM application enumeration, native MRU, magnification,
physical DPI or macOS pixel fidelity.
Passive menu details are appended after the stable header/list/close slots.
Actual custom Classic application grouping can retheme to Modern and back
without replacing the focused real-window command or changing its action.

Modern and the three Mac presets also display independent persistent application
pins. Apps menus distinguish taskbar/Dock pin controls from desktop shortcuts;
the window chooser can pin or unpin the corresponding registered application.
At most 32 ordered catalog IDs are saved in Shell configuration v3, with atomic
v1/v2 migration preserving every existing preference domain. Unpinning never
removes a desktop shortcut. The older reader cannot read v3 automatically.

An idle pin launches through the existing current-catalog policy, while a
uniquely associated running group occupies that same pinned slot with its real
window count. Missing or unavailable entries remain keyboard-manageable, with
their reason and Unpin action instead of stale launch arguments. Display slots,
Dock width, image retention and live callback guards share the same model.
Settings pins retain the existing owned Settings launch route. Repeated or
composing Dock activation does not launch; discrete activation still does.
The existing pin menu also offers Earlier/Later for one-step saved ordering,
including unavailable pins, omitting directions at the ends of the list.
These commands share Pin/Unpin's atomic publication and committed-error handling,
recheck the current menu/output/task and expected pin position, and do not alter
desktop shortcuts.
These are Polly launcher semantics, not native MRU, drag sorting or Dock
magnification, and do not alter Classic/XP per-window mode.

Mac-style Docks now also provide bounded pointer-hover emphasis through optional
`icons.dockHoverPercent` (integer 100-125, missing/100 disables; packaged presets
use 120). Only the passive glyph/bitmap scales about its center, limited by the
actual slot, clipping ancestors and client viewport. Slot/tile/hit geometry,
counts and running marks stay fixed. Leave/cancel restores the art; existing
weak control state and Dock settling handle retheme/scroll without a new frame
loop. This is not neighboring-icon displacement, animated magnification or
keyboard-focus enlargement.

The bounded gap-accounting follow-up in `tests/mac-dock-gap-render.mjs` corrects
the natural width of all three styled Docks. With windows, three fixed actions,
a separator and a window strip require four root gaps plus `count - 1` inner
gaps, not `count + 2` total. At two windows, default Tiger/Lion/Big Sur widths
intentionally change from 303/317/329 to 305/319/331px and recenter accordingly.
Big Sur with a legal 12px gap changes from 369 to 381px, exposing the previously
clipped final icon and removing unnecessary 12px scrolling. Palette, height,
slots, rim and indicators are unchanged. Earlier palette/triangle captures and
their hashes describe those checkpoints, not the new centered geometry.
Actual 400x140 GUI checks cover natural widths, zero gaps, empty Docks, exact
clamp boundaries, running/minimized truth and held reconstruction. The default
320px available-width window strip retains scroll/click/focus access to the
last window while the three fixed commands stay put. Node guards derive
natural widths from actual Dock child styles and retain the generic/non-Dock
helper branch. This is a local layout correction, not a macOS pixel-fidelity
score; that checkpoint excludes the separate icon-fit validation below,
extreme-width responsive policy, materials and desktop/menu-bar reference gaps.

The subsequent icon-fit checkpoint adds only the schema constraint described
above, not new rendering. `tests/theme-alignment.mjs` covers 20 combinations
through theme-file, catalog and override parsing (13 accepted, 7 rejected),
optional fallbacks, custom IDs and the generic/taskbar gate. Errors propagate
through the user-file reader and installation rejects before replacing the
active catalog/revision. `tests/mac-dock-icon-fit-render.mjs` checks real
560x160 slot/icon/marker boxes and marker ink, normal/focused boundary states,
16/48/64/96px icons and held-reconstruction single activation. The legal
half-pixel marker gap rounds at rasterization without overlap; negative
half-pixel overlap is rejected before rendering. All three default Dock
captures and the existing 320px narrow scroll/click/focus controls remain
byte-identical to the gap-fixed baseline. This does not certify rounded-rim
silhouettes, whole-Dock fit on extreme outputs or native macOS appearance.

The extreme-width follow-up keeps a stable `shell-dock-viewport` around the
original material/controls surface. Its minimum content width is the existing
`dockSurfaceWidth(theme, windows.length ? 1 : 0, Infinity)`: configured padding,
three fixed slots and their gaps, plus the separator and one window slot when
windows exist. Only below that threshold does the outer viewport clip/scroll
the complete surface. It never compresses gaps, padding, icons or unequal slot
widths. With no windows, the same rule keeps all three fixed actions reachable.
If even one control is physically wider than the viewport, focus exposes its
maximum visible portion rather than claiming that it fully fits.

Window focus reveals the inner strip before the outer viewport; fixed-action
focus reveals the outer viewport. Inner wheel movement stops propagation;
at its boundary the event can move the outer Dock. A bounded two-frame
mount/update layout check clamps stale inner/outer scroll after geometry
changes and reveals retained focus. Unchanged clock reconciliation does not
undo manual wheel scrolling. A fitting Dock adds no outer clip, preserving
the existing antialiased rim pixels and normal fixed-action positions.

`tests/mac-dock-extreme-render.mjs` covers real 560x180 rendering/input. With a
304px client, gap32 and 20 windows, the formerly zero-width Tiger/Lion/Big Sur
window strips become 54/56/58px inside 369/381/391px complete surfaces. Fixed
actions and first/last windows have real single callbacks; Lion's full-width
shelf remains under the last window. Big Sur wheel limits are inner1710 and
outer87. Widening to544 clears outer scroll and preserves last-window focus;
removing windows restores outer0 with Settings focus intact. Empty80px,
unequal64/80px slots at100px and explicit96px slots at40px cover smaller
outputs without silent resizing. The minimum-surface/client distinction also
applies one pixel below the exact-fit boundary. Thirty-one full before/after
PNG pairs for normal/default320/gap0/gap12 and legal icon configurations remain
byte-identical. These are local layout/input guarantees, not an OS-fidelity
claim; desktop icons, global menu-bar reference gaps and genuine materials
remain separate.

`tests/theme-alignment-render.mjs` paints the actual Shell component functions
through PollyUI at 1280x900, scale 1, and records physical geometry. It is not a
simulated appearance preview, but also **not a Linux compositor desktop capture**.

The bounded shared disabled-state checkpoint also exercises the real Settings
Audio view through `tests/disabled-button-render.mjs`. Surface and Luna visual
handlers honor the existing explicit disabled option or `aria-disabled="true"`;
reconciliation clears stale held/hot/focus paint without moving actual focus.
Paint does not replace caller opacity, including configured disabled opacity.
The shipped Classic/Luna value remains 1; a 0.37 override is a separate input
contract check, not a new OS appearance default. Disabled pointer pixels, retained
selection/node/focus, and re-enabled single activation are covered. This does
not certify all SDK widgets, fonts or OS control states.

Settings display fields also apply their existing appearance mapping at creation,
not only when a retained field is repainted. The bounded
`tests/display-field-render.mjs` check uses the actual Displays view and SDK input:
first-frame/same-theme border and radius pixels match, while value, caret,
selection, focus, padding and draft roundtrip survive a retheme. This does not
change theme tokens, SDK input defaults/focus color or display transaction policy,
and does not certify other input controls or scrollbars.

An additional actual-GUI check found that the former fixed Classic focus-dot
grid truncates on wide/tall controls: a 420x80 control misses 47/47/5/5 dots
along its four full edges, while 120x22 is complete. The original evidence and
unshipped candidate remain historical proof of the earlier deferral.
The subsequent bounded fix replaces only the ordinary Classic focus grid with
one paint-only Canvas, reusing the task painter's 2x2 repeat primitive but
preserving each ordinary edge's independent phase (task phase is unchanged).
Actual 800x600/scale-1 GUI output has zero missing dots on all four full edges
for 420x80 and 500x96; the complete 120x22 control crop differs by zero pixels
from the preserved before image, with no resize/mask/font exclusions.

The generic read-only `Document.defaultView` and independent
`Window.observeState` mechanisms associate the focused control with its real
owner, without wrapping the business `onstatechange`. Focused/enabled controls
use a weak cached painter and bounded two-rAF post-layout remeasurement, not a
frame loop. Blur/disabled/leave cancel frames and unsubscribe; detached Canvas
subscriptions do not retain the Canvas and have GC cleanup. Real Win32 child
host-only resize, with no VNode update or forced render, expands a 420x180
control to 640x290 and completes the 634x284 focus backing; its presented PNG has
zero wrong on/off pixels on every full edge. Business callback reassignment,
retained focus, caller opacity, selection truth, retheme, blur and single
activation are covered. A private WM_DPICHANGED 1.25 test checks adapter/backing
refresh only, not monitor-DPI qualification. No C theme rendering is added.
E22.7 remains partial: this does not certify every SDK widget/state, fonts or
full OS default-button behavior.

Desktop buttons and commands now accept an explicit `defaultAction` visual,
independent of selected/toggle truth. It adds passive theme-token outlines,
suppressed when disabled, without changing content geometry, caller opacity,
focus ownership or activation routing. Existing display Keep and Files confirm
opt in; no global Enter handler, platform focus migration or pulse animation is
introduced. Ordinary callers retain their prior appearance. This shared API
uses small additions to existing checks, not new application-style fixtures.

The native Canvas painter cache keeps its Document, window and remover weak;
the finalizer holds a weak remover and an owner-free unregister token. Real
focused/unfocused closed-window node/Document/handle references all collect,
and a detached Canvas actually unsubscribes while its owner remains open.
Live-owner GC still preserves the focus dot and subsequent two-frame host resize.

`tests/appearance-focus-render.mjs` covers a separate consumer omission:
Appearance cards replaced the command children and lost their focus detail.
They now retain only the original focus wrapper above the illustrations,
without restoring bevel/gloss or changing the unfocused gallery. Actual Classic
card focus changes 335 pixels; blur returns the full fixture to its original
bytes. Retained XP-to-Classic focus can produce a 175px ring clip around a 176px
Canvas; the painter uses their actual coordinate intersection for the outline,
keeping the 176px backing and independent edge phases. All four visible edges
are complete, and all six unfocused preset captures remain byte-identical.
These cards/navigation are selected command buttons, not proof of themed
checkbox/radio/switch/select/tab/list coverage. The later E22.8 work below adds
desktop-theme mapping to the existing SDK controls; broader bespoke-consumer
coverage and OS-state certification remain separate.

`tests/caption-alignment.c` now checks geometry-only layout, hitboxes and the
bounded frame codec. `tests/caption-gui.mjs` paints actual GUI caption strips;
the native window suite checks their composition/input. Historical C painter
crops retain their original scope and are not current full-window certification.
Compare same-size raw crops with no resizing, pixel masks, font exclusions or
invented pass thresholds. Before/after difference is change evidence, not OS
reference error. No full-scene OS MAE is available without qualified raw captures.

Shared button/command typography, Classic edges/focus/disabled painting and Aqua
button gloss are covered. SDK text-input caret/selection, every bespoke dialog,
global scrollbars and third-party clients are not certified as OS-identical.
Generic platform font fallback remains intentional: no forced aliases or
proprietary font files are installed. These missing pixels prevent a 1:1 claim.
Files list names now use the theme body size and metadata its status size;
Processes uses the existing body/status/heading and spacing tokens as well.
Both retain their fixed-row geometry, columns and data-operation controllers.
Processes also uses the shared 10px overlay scrollbar in its trailing padding.
Drag, paging and keyboard changes update its actual virtual PID rows through
the controller's optional scroll notification without another process sample;
retained observations remain scrollable during refresh and after a sample error.
File Text explicitly opts into the existing public theme helpers for the whole
app, sharing its subscription with the chooser and preserving text/selection
and every existing read/save consent rule. Its default API remains neutral;
the packaged wrapper selects `--theme`, with `--no-theme` as an explicit opt-out.
Settings frame/About/Keyboard and Displays titles, body/status text and spacing
also consume their existing semantic tokens. Displays headers and action rows
wrap in narrow content areas, while numeric input dimensions, draft values and
the trusted Apply/Keep/Revert transaction stay unchanged. Audio controls wrap
without changing acknowledgement behavior. Files Places/Properties/empty
states follow the same typography. Power uses an explicit bounded client area
and the existing wheel handler, with shutdown permissions and confirmation
coordination unchanged. These are application-style changes, not new font,
layout or test infrastructure.

The SDK light/dark switch, checkbox, radio, tabs, Select and menu now provide
keyboard navigation, disabled/controlled-value contracts and visible paint-only
focus. Mapped options cancel a pointer gesture if reconciliation changes its
identity. Open Select popups follow native owner geometry, remove their observer
on close and keep the existing window-local portal; a very short viewport can
show only part of a row. These are functional improvements, not six-theme
OS-exact glyphs or native accessibility-provider certification. See
[the SDK contract](../gui/README.md).

The six selection factories also accept strict per-instance
`appearance={colors,metrics,paint,decorate,revision}`. One desktop adapter maps
the existing theme tokens and passive surface primitives, without importing
desktop policy into the SDK or changing its global theme. Classic part bevels
own their outside pixels rather than sitting behind a second generic border;
radio circles keep their border. Default metrics are immutable. Actual
six-theme sheets cover palette/metric consumption, hover/press/cancel/disabled,
retained-instance retheming and keyboard navigation; the no-appearance
light/dark whole captures remain byte-identical.

The existing vertical scrollbar controller now accepts optional per-instance
appearance, with one desktop adapter rather than separate App drag/arrow
controllers. Track/thumb/end-arrow surfaces use theme tokens and existing
passive primitives; Classic parts do not nest behind another generic border.
The same controller owns measured travel, clamped page/42px step, keyboard,
capture and cancellation. Dragging uses a lane-relative anchor: no-motion
move/release and captured resize/retheme do not jump the value. Rejected
initial schema/paint/decoration rolls back owned nodes/listeners/styles/ARIA and
rethrows the original error. Surface opacity is independent of overflow
visibility. Actual rail-size changes refresh the existing focus painter;
unchanged updates do not repaint or rewrite properties.

Files explicitly uses the adapter's 10px `overlay` variant, preserving its
viewport, 42px rows and column geometry. Its markup leaves surface painting to
the controller; retained sort/refresh preserves valid focus/hover, while the
existing generation guard cancels held capture. Actual 800x600/640x480 checks
keep the complete `12.1 KiB` glyph crop identical with the rail shown or hidden
and to an unclipped native text reference. The adapter's default `full` variant
is available independently. SDK callers without appearance retain their
original styles and byte-identical whole resting/end/held captures; this is
not automatic theme adoption by every scrolling App, exact historical arrow
placement, physical/compositor input or original-OS pixel certification.

Displays now uses a named checkbox whose Space action changes only the draft;
Apply still submits the original output identity/serial and keeps its trusted
confirmation deadline. Audio uses a named mute switch and keeps its displayed
value until the existing generation/revision/instance policy acknowledges the
change; persistence happens after acknowledgement. Busy or unsupported values
cannot activate either control. These actual GUI/controller checks use bounded
native/domain fixtures, not hardware mutation or native screen-reader-provider
qualification.

Settings cards, Audio/Displays cards, Appearance/Keyboard panels, Files dialogs,
context menus and breadcrumbs, opt-in file choosers and application-window
choosers share `panel-appearance.mjs`. It is a passive token projection, not a
second controller: Classic transfers generic border space into padding so its
bevel alone owns the outside edge. Existing inputs, inline rename, controller
guards and chooser subscriptions remain intact. Read-only long paths/details
use raw-text horizontal viewports with wheel and Left/Right/Home/End access;
ordinary messages may wrap, but long-token wrapping is not claimed. Neutral
chooser whole-image bytes remain unchanged. This does not certify every
credential/trusted dialog or every bespoke application surface as OS-identical.

Existing Wi-Fi credentials/confirmation and network cards, display confirmation,
and logout views also reuse these surfaces and shared buttons. Embedded Settings
content does not acquire a second window frame. Narrow credential fields keep
their existing 420px upper bound while fitting the viewport; prompt ID/kind
changes still clear/recreate secrets, and retained fields keep native DOM,
masking, caret/selection and focus. Display token/deadline/revert and logout
inventory/wait/seal/explicit final commit remain controller-owned.

`panel-viewport.mjs` separates fixed outer chrome from the bounded inner scroll
region. Its default fixed sizing serves the credential/confirmation surfaces;
content sizing preserves Files' natural dialog/menu height under the caller's
existing maximum, and an explicit horizontal axis serves breadcrumbs.
Window actions, workspace/desktop management, the window switcher and tray
menus also consume the same helper instead of separate bare scroll frames.
Workspace actions wrap in narrow menus, and tray commands reuse the shared
enabled/selection-foreground/activation behavior. Their native identities,
management callbacks and application-owned tray scroll actions are unchanged.
Frame pixels stay fixed while content
scrolls; one weak, bounded post-layout helper reveals the current real focus,
including manually attached credential fields. Tab/focus requests coalesce,
leave cancels frames/listeners, unchanged repaint does not undo manual scroll,
and there is no idle frame loop or added service subscription. These checks
use inert authentication/display/session fixtures, never real credential
delivery, network changes or logout. A separately observed autoheight network
card bottom-edge rounding offset remains disclosed rather than described as
pixel-perfect or hidden by changing native geometry. At 640x480, an existing
78%-height Open With panel likewise reports 375px for 374.4 logical pixels and
already lacks the expected inside-bottom sample before scrolling in the
preserved baseline; the adoption fixes scroll-induced edge loss, not that
separate static rounding boundary.

Actual long Open With lists, short context menus and horizontally scrolled
breadcrumbs keep their outer frame fixed and reveal current focused commands.
The final real MIME handler still launches once through the existing controller;
retired callbacks stay inert. A short create dialog retains its original
118px/119px natural heights at 800x600/640x480 rather than collapsing or filling
the maximum. Native name-field identity/selection, inline rename's unframed
structure, the new table scrollbar, columns and 42px rows are unchanged.

Shared quiet commands and selected desktop captions consume the optional
selection foreground as well. Only explicitly tagged original monochrome icon
parts follow that ink; bitmap and fixed-color art are not recolored. Ordinary
nonquiet button faces and each missing-token legacy fallback are preserved.
The shared weak physical-state painter keeps ink aligned with the actual
selection/hover background across cancel, disabled state and retained retheme.
Files rows use that same ink-only painter for explicitly marked name/metadata
parts and original glyphs, restoring each original normal text/muted/folder
color on leave. Traversal stops at textbox roots, so inline rename fields are
not recolored; row height, column widths, selection identity and guarded file
actions are unchanged.

Desktop command and button consumers share primary-button, nonrepeating
Enter/Space activation. Recognized repeated activation keys are consumed rather
than leaking to ancestor menu handlers; composing keys are left to IME handling.
Surface and Luna painters share weak per-node physical state, so immutable
theme replacement preserves a real press with the new palette. Cancel, lost
capture, blur and disabled state clear the appropriate transient paint, without
changing caller opacity or the control's hitbox.

Settings display/credential inputs, Files, opt-in file dialogs and workspace
editors use `shared/ui/input-appearance.mjs` for the complete existing input
appearance: foreground, background, selection, border/focus colors, radius and
semantic font size. First paint and retained updates use the same contract.
The existing inputs remain attached: values, caret, selection, password masking,
composition and callback lifetimes are not replaced. Non-opt-in file dialogs
keep their explicit neutral appearance and do not acquire a theme subscription.

Optional RGB `colors.selectionText` supplies selected-glyph foreground separately
from the existing selection background. Missing values preserve the legacy
`colors.text` mapping. Classic, Tiger and Lion explicitly use white on their
existing blue selection; XP, Big Sur and Modern retain their original text ink.
Both SDK input paths reuse full-string native DOM rendering inside selection
clips, preserving shaping and available color glyphs rather than recoloring an
entire field or reshaping text slices. Decorations are noninteractive and hidden
from accessibility naming; the input API value remains authoritative. Neutral
SDK inputs without the option keep their previous painting.
Software-raster checks exercise both the Windows native text path and Linux's
ICU/bidi path, including available color glyphs; they are not OS screenshot or
physical display qualifications.

The Luna-only fixed 80-dot, two-edge focus approximation is replaced by the
same bounded owner-aware Canvas repeat painter already used by Classic.
Luna keeps its original inset and button/panel focus colors; all four edges now
follow the actual control bounds, including native host-only resize. This adds
no duplicate painter, owner observer or finalizer mechanism, and changes neither
unfocused pixels nor control geometry.

Main Shell surfaces reconcile when their geometry changes. Other service panels
repaint immediately; their preferred sizes apply when opened. Retheming existing
credential controls preserves their values, selection and focus. Theme data does
not include application or credential content.

The standalone appearance preview is still a simulated sample. Its samples use
the same data but do not certify every compositor effect. `unifiedToolbar`
retains its preview meaning. Existing radius/shadow values affect native windows
only through the explicit native-effects opt-in described below; this does not
add backdrop blur, default-app material adoption or arbitrary font-file loading.
Captions reuse the GUI text backend; on Linux, the existing ICU
boundaries now keep the 512-codepoint cap and measured ellipsis on complete
graphemes. Other platforms retain the SDK's existing code-point fallback.
Font equivalence and full platform/state qualification remain incomplete.

### Per-theme discrepancy tasks

Execution state and evidence live only in
[`docs/POLLYOS-PLAN.json`](../docs/POLLYOS-PLAN.json), under **E22 Windows/Mac
six-theme alignment**; its generated checklist is in
[`docs/POLLYOS-BACKLOG.md`](../docs/POLLYOS-BACKLOG.md). This is the index to the
specific task IDs, not another independently maintained status table.

| Target / surface | Individually tracked discrepancies |
|---|---|
| Reference provenance | E22.1 / E22.3: XP version/DPI and native comparison; E22.4: Classic, Win11 and Mac version/scale/interaction-state capture metadata |
| Shared typography and art | E22.5: font widths, weights, baselines and rasterization; E22.6: original Polly versus system/application/Start/tray/Dock artwork |
| Shared controls | E22.7: button borders, backgrounds and hover/press/disabled/default/focus; E22.8: checkbox/radio/switch/select/tabs/list selection; E22.9: text-box bevel/padding/caret/selection and scrollbars; E22.10: Settings/dialog/confirmation/authentication surfaces |
| Actual geometry and state | E22.11: bounded native active/inactive/press/cancel/maximize/restore, narrow/low-screen and supported DPI checks, not just component fixtures |
| XP SP3 Luna | E22.2: completed historical base-paint increment; E22.12: remaining caption bands, edges, text shadow and caption-control states; E22.13: taskbar/Start/quick-launch/tray/clock and two-column menu details |
| Server 2003 Classic remaining | E22.14: residual raw border/menu/taskbar color errors; E22.15: multi-level Programs directories beyond the delivered flat submenu, profile and content-density/layout choices |
| Server 2003 Classic corrected records | E22.16: bevel/outline ownership; E22.17: flat state, stipple, focus and icon spacing; E22.18: caption glyph size/offset and gradient span; E22.19: native menu/taskbar gap; E22.20: outside-menu caption input, linked to the existing functional task; E22.35: base frame metrics, solid desktop and gray two-column default with single-column override |
| Windows 11 24H2 light | E22.21: caption backplates/glyphs/states; E22.22: centered taskbar, running markers, Start search/grid/footer; E22.23: full-client corner clipping/shadows; E22.24: Mica-like versus Acrylic backdrop mechanisms |
| OS X 10.4 Tiger | E22.25: caption/traffic lights/menu bar; E22.26: 2D Dock rim/slots/separator/black triangles; E22.27: genuine glass transparency rather than an opaque approximation |
| OS X 10.7 Lion | E22.28: caption/traffic lights/menu bar; E22.29: perspective shelf/spacing/luminous indicators; E22.30: glass, shadow and actual reflection |
| macOS 11 Big Sur light | E22.31: caption/traffic lights/menu bar and toolbar boundary; E22.32: floating Dock rim/radius/inset/separator/dots; E22.33: wallpaper tint, vibrancy, blur and transparency |
| Shared Mac Dock semantics | E22.34: delivered grouping, window chooser, independent pins and bounded hover emphasis; native/reference qualification and full neighboring-icon animation remain |

The list distinguishes a measured defect, an explicit implementation gap and
missing reference/qualification evidence. Corrected defects are not reopened
as unfinished work. Existing native menus, application grouping and material
projects remain the owners of their mechanisms; an alignment task does not
duplicate them or authorize Mica/blur, a new renderer, proprietary assets or
fake OS actions. Preserve customization and request a decision before changes
that force fonts/resolution, remove search/actions or alter cross-theme policy.
No new screenshot campaign, six-theme test matrix or product changes are
started merely by recording these tasks.

## Bitmap resources

Set `desktop.asset` to a relative PNG/JPEG path such as `wallpaper.png`. It is
resolved below `$XDG_DATA_HOME/pollyui/themes/<theme-id>/`, including for a
shipped theme that uses a user override. Directory links, absolute paths,
hidden/relative components and non-bitmap content are rejected.

Bitmaps are decoded before committing the theme and retained in native memory,
not reopened by pathname during drawing. Limits are 4 MiB encoded bytes,
4096 pixels per dimension and 8 Mi pixels per bitmap, with 16 Mi pixels across
owned active/staged assets. Replacing or rejecting a staged image releases it.
Missing, malformed or oversized images leave the previous theme in place.
Decoding uses the GUI's generic owned
[`createBitmap`](../gui/sdk/BITMAPS.md) resource, independent of SysRT. Theme paths
and limits are desktop policy, not built into the decoder.

## Native and application boundary

Private `desktop.configureAppearance(theme, layout)` uses appearance protocol
v6 with bounded numeric geometry schema 6. Prepare validates the bounded
JS-compiled layout and an immutable descriptor; commit publishes the snapshot.
The existing GUI renders complete four-strip pixel responses, not C theme
commands. Each window owns current and pending snapshots so a delayed
configure acknowledgment cannot mutate an older frame. Three-second transport
deadlines report lost or uncertain acknowledgment explicitly; a transport loss
is not reported as a successful rollback.

The document is carried in a size-checked, sealed memfd, avoiding Wayland's
small individual-message limit. It is capped at 32 KiB after serialization.
PollyWM checks descriptor size, readability and sealing but does not parse JSON.
The generated C schema lists geometry fields and bounds. Generated preset
geometry is test-only; the compositor has no bootstrap style or theme-ID
registry. Runtime theme IDs and visual values do not require recompilation.
Old private versions are explicitly rejected; the public application theme
subscription and JSON schema remain unchanged.

### Opt-in native window effects

`window.nativeEffects` accepts `"none"`, `"rounded"` or `"rounded-shadow"`.
Missing or `"none"` preserves the previous native path; existing preview
radius/shadow values do not silently enable effects. `"rounded"` applies the
existing `window.radius`; `"rounded-shadow"` also uses `window.shadow` as the
blur-size input, with Gaussian sigma `ceil(shadow / 2)`. A zero shadow size
disables the shadow without disabling rounded clipping. Modern now explicitly
selects `rounded` at its existing 8px radius and zero shadow. Aqua, Lion and
Big Sur explicitly select `rounded-shadow`, retaining their respective 6/5/10px
radii and 20/18/24 shadow-size inputs. Classic and XP do not opt in.

Optional `nativeShadowColor` is an RGB color (default black);
`nativeShadowOpacity` and `nativeShadowInactiveOpacity` are integer percentages
0-100 (defaults 24/12). Integer `nativeShadowX` and `nativeShadowY` are logical
offsets -64..64; defaults are 0 and `round(shadow / 4)`. These are JS-owned
style choices compiled into validated numbers, not a native preset registry.
For example, an override may explicitly select:

```json
{
  "window": {
    "nativeEffects": "rounded-shadow",
    "radius": 8,
    "shadow": 20,
    "nativeShadowColor": "#000000",
    "nativeShadowOpacity": 24,
    "nativeShadowInactiveOpacity": 12
  }
}
```

The compositor groups the real client and frame descendants into a bounded
offscreen target, then applies one antialiased coverage to that group. Popups
remain separate. Opt-in GUI caption strips do not premask their outer corners:
the compositor owns that coverage once, including a square maximized frame.
Maximized/fullscreen, explicit client-side-decorated and frameless windows
do not acquire floating-window effects. Hit testing retains the existing
rectangular contract, including visually clipped corners.

The external shadow is a non-input, non-opaque sibling scene node. It computes
an analytic Gaussian-outline falloff, clips out the original window interior
and uses premultiplied color once. It does not sample application backgrounds,
expand the four-strip payload, or intercept input outside the original window.
This is neither exact Windows/macOS shadow reproduction nor live backdrop blur.

A pinned wlroots scene-effects patch supplies the generic composition mechanism;
the WM still does not interpret preset names or theme JSON. Each target is
bounded to 32768 pixels per axis and 16 megapixels; backing plus coverage
workspace shares a 128MiB scene-wide budget. Cache keys include output, scale and
physical pixel phase. Damage and visibility drive invalidation and sampling:
there is no periodic idle rendering loop. Budget/allocation failures explicitly
fail composition rather than producing an unreported square or missing shadow.

Runtime library identity, headers, effects ABI 2, distinct SONAME and the packaged
patch hash must match.
Stock SDKs are explicitly rejected rather than producing a square fallback.
Current desktop builds use the paired Debian SDK; historical Alpine build and
packaging entry points explicitly remain unsupported until that pairing is
ported. Public theme JSON stays version 1; old private WM/Shell/decorator
combinations fail rather than silently negotiating down.

Actual Pixman output checks cover overlapping real subsurfaces, alpha, source
crop, buffer/output rotation, fractional scale, phase-changing moves,
occlusion/reveal, cache reuse, budget refusal, locking and external shadow
lifecycle. Actual GUI strip pixels verify one outer-corner coverage rather than
its square. Software llvmpipe checks exercise the pinned GLSL primitives at
2048/4096/8192 widths; this is not a full WM GLES/DRM or physical-GPU qualification.
The complete WM GLES path remains unqualified without a usable DRM device.
Regional backdrop sampling remains separate work.
Those compositor results describe the frozen shared-mechanism qualification.
For the current preset-policy adoption, numeric compiler and production GUI
caption/legacy-none checks pass; the attempted paired-Linux rerun did not reach
its first execution marker, so no new live-compositor or GPU result is claimed.
That environment revalidation remains separately tracked rather than triggering
a new SDK/VM build or blocking unrelated interface work.

Ordinary Wayland clients may subscribe through `polly_theme_manager_v1`, which
only exposes the published visual document. Notifications coalesce until the
client requests a snapshot. This grants neither management nor theme-file access.
PollyUI applications opt in with `--desktop` and the client helper:

```js
import { subscribeDesktopTheme } from './desktop/client/theme.mjs';

const binding = subscribeDesktopTheme(({ theme }) => {
  if (theme) document.body.style.backgroundColor = theme.colors.body;
}, {
  overrides: { colors: { accent: '#ff00aa' } },
  onError: error => console.error(String(error)),
});

// Call binding.stop() when the owning UI is disposed.
```

The helper shares subscriptions, validates documents, retains the last valid
application theme on bad data and preserves explicit application overrides.
`setOverrides()` changes an application's local overrides only. Applications
choose which controls to repaint; third-party clients and client-drawn headers
are not forcibly restyled.
