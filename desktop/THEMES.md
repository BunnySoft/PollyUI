# Runtime desktop themes

PollyShell JavaScript owns theme loading, schema validation, user overrides and
UI rendering, including the pixels of server-side window decorations. PollyWM
accepts geometry and complete immutable GUI-rendered frame strips from the trusted
Shell. It does not interpret theme files or execute theme code.
File traversal, ownership checks and resource limits are implemented in
`shared/theme-resources.mjs` over the native FileSystem SDK; the old theme-file
C bridge is removed. Every service operation still checks the authorized Shell
connection. Native file mappings themselves have no theme policy.

## Data and ownership

`resources/themes/builtin.json` contains **Polly / Modern** and five retained
classic presets. Modern now targets Windows 11 24H2 light geometry, not Windows
10. Modern is the default only for fresh or
unavailable configuration; saved classic choices and user overrides are not
silently rewritten. It uses a solid 48px taskbar, centered icon tasks, a 32px
caption content band with 46x32px controls, and original Polly artwork.
No platform logos/assets, Mica or blur are shipped.
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
  stripe treatment, hover/inactive mixing, gradient direction, generic caption
  font family, size, weight and alignment. Text and controls must fit their
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
Private appearance protocol v3 uses geometry-only numeric schema 4. Previous
private Shell/WM combinations are explicitly rejected; public JSON schema 1 and
the read-only application theme subscription remain unchanged. This paired
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
Before the GUI publishes a validated layout, it negotiates client-side decoration.

`shared/ui/caption-paint.mjs` uses the existing GUI's detached Canvas2D and text
shaping. `shell/decorations.mjs` services the trusted render queue. Neither
creating canvases nor pattern tiles creates native windows. PollyWM contains
no JavaScript engine, GUI instance, theme-specific painter or second font cache.
No application content is sent to the renderer.

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
Shell queue is bounded to 128. There is no palette map, per-frame timer loop
or per-title native surface.

Non-reused window tokens and frame revisions bind theme generation, geometry,
scale, state and layout rectangles. Stale/duplicate frames are rejected.
Invalid/partial data cannot replace any strip or hitbox. A complete scene and its
layout switch together, after the applicable client configure acknowledgement;
unchanged client buffers retain their idle-reuse path. Individual windows may
retain an earlier complete snapshot while their new geometry/frame is pending.
This is not a global barrier that freezes every application's content.

No renderer at startup negotiates standard client-side decorations. A failed or
unresponsive renderer (1000ms without a complete requested frame) logs/reports
failure and requests client-side decoration; WM input never waits for JavaScript.
The last complete frame remains until that negotiation is committed.
Shell disconnect/restart, unmap and destruction cancel requests and reclaim
owned scenes/FDs; a new theme commit can retry the GUI renderer. There is no
hidden C style fallback. Frame rejection is distinct from ordinary obsolete
replies, which return `false` rather than pretending a new frame was displayed.

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
categories, pinned history or nonfunctional search. Classic cascading Programs
menus, true user account/profile art, and Win11 recommendation/account features
are not reproduced. Existing application launch, desktop shortcut, keyboard and
logout actions remain connected.

Mac menu-bar commands keep their existing explicit square-corner treatment
through pointer, focus and reconciliation states. A component-local button
radius of zero is shared by their factory and state painter; ordinary buttons
still consume the original theme radius. A menu-only `WeakMap` reuses that derived
object for each immutable source theme, so clock-driven reconstruction does not
reset hover/held state on the retained menu node. A new source theme gets a new
derived object and palette rather than retaining the old input state.
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
Slots currently represent windows, not macOS application grouping. The
window strip scrolls horizontally when clamped; fixed Apps/Settings/About slots
do not shrink, and focusing an offscreen window reveals it. The pure
`dockSurfaceWidth`/`applicationMenuPlacement`/`applicationMenuHeight` functions are the Shell consumer
seam; they do not create surfaces or change state by themselves.

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

An additional actual-GUI check found that the current fixed Classic focus-dot
grid truncates on wide/tall controls: a 420x80 control misses 47/47/5/5 dots
along its four full edges, while 120x22 is complete. This is **not fixed**.
A paint-only Canvas replacement must also follow child-window host resizing
without a vnode update. The existing window state event has size/scale data,
but Document currently exposes no owner-window association. An onUpdate/rAF-only
replacement would regress that case, so it is not shipped; a minimal read-only
owner association is a separate mechanism decision. E22.7 remains partial.

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

Main Shell surfaces reconcile when their geometry changes. Other service panels
repaint immediately; their preferred sizes apply when opened. Retheming existing
credential controls preserves their values, selection and focus. Theme data does
not include application or credential content.

The standalone appearance preview is still a simulated sample. Its samples use
the same data but do not certify every compositor effect. `window.shadow` and
`unifiedToolbar` retain their preview meaning; real client clipping, compositor
shadows/blur and arbitrary font-file loading are not added by this theme
system. Captions now reuse the GUI text backend, but font equivalence,
grapheme-safe ellipsis and full platform/state qualification remain incomplete.

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
| Server 2003 Classic remaining | E22.14: residual raw border/menu/taskbar color errors; E22.15: cascading Programs, profile and content-density/layout choices |
| Server 2003 Classic corrected records | E22.16: bevel/outline ownership; E22.17: flat state, stipple, focus and icon spacing; E22.18: caption glyph size/offset and gradient span; E22.19: native menu/taskbar gap; E22.20: outside-menu caption input, linked to the existing functional task; E22.35: base frame metrics, solid desktop and gray two-column default with single-column override |
| Windows 11 24H2 light | E22.21: caption backplates/glyphs/states; E22.22: centered taskbar, running markers, Start search/grid/footer; E22.23: full-client corner clipping/shadows; E22.24: Mica-like versus Acrylic backdrop mechanisms |
| OS X 10.4 Tiger | E22.25: caption/traffic lights/menu bar; E22.26: 2D Dock rim/slots/separator/black triangles; E22.27: genuine glass transparency rather than an opaque approximation |
| OS X 10.7 Lion | E22.28: caption/traffic lights/menu bar; E22.29: perspective shelf/spacing/luminous indicators; E22.30: glass, shadow and actual reflection |
| macOS 11 Big Sur light | E22.31: caption/traffic lights/menu bar and toolbar boundary; E22.32: floating Dock rim/radius/inset/separator/dots; E22.33: wallpaper tint, vibrancy, blur and transparency |
| Shared Mac Dock semantics | E22.34: per-application grouping/pinning versus the current per-window slots, minimized/running behavior and unimplemented magnification |

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
v3 with geometry-only numeric schema 4. Prepare validates the bounded
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
