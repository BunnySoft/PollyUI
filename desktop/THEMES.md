# Runtime desktop themes

PollyShell JavaScript owns theme loading, schema validation, user overrides and
UI rendering. PollyWM accepts only bounded decoration parameters from the trusted
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
The same C button-box function drives raster placement and compositor hit tests.
Native Luna captions use numeric schema 2 (original word count). Classic,
Fluent or explicit rectangular geometry use schema 3: the original fields,
then width and top inset, with an exact checked word count. Actual schema 1/2
messages remain readable. New data is never silently dropped to negotiate an
older server. Shell and compositor use the
current configuration API together; there is no legacy theme-ID selection or
automatic schema downgrade. Rejected startup fails explicitly. Rejected theme
changes retain the live snapshot and saved preference; transport loss and
uncertain commits are reported rather than treated as success. Reference scope, original-art
rights and outstanding native acceptance are documented in
[Blue Luna](resources/themes/XP-LUNA.md).

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
Only actual installed entries/actions are shown: no fake recommendations,
categories, pinned history or nonfunctional search. Classic cascading Programs
menus, true user account/profile art, and Win11 recommendation/account features
are not reproduced. Existing application launch, desktop shortcut, keyboard and
logout actions remain connected.

The three Dock painters have real icon slots, separators and running indicators:
Tiger has triangles and a 2D rim, Lion has a perspective shelf and luminous
indicators, Big Sur a floating rounded rectangle and dark dots. Minimized windows
are still running. These are **opaque material approximations**, without
compositor blur, reflection, wallpaper tint, magnification or authentic OS icons.
Slots currently represent windows, not macOS application grouping. The
window strip scrolls horizontally when clamped; fixed Apps/Settings/About slots
do not shrink, and focusing an offscreen window reveals it. The pure
`dockSurfaceWidth`/`applicationMenuPlacement`/`applicationMenuHeight` functions are the Shell consumer
seam; they do not create surfaces or change state by themselves.

`tests/theme-alignment-render.mjs` paints the actual Shell component functions
through PollyUI at 1280x900, scale 1, and records physical geometry. It is not a
simulated appearance preview, but also **not a Linux compositor desktop capture**.
`tests/caption-alignment.c` checks/rasterizes the actual shared C primitives and
hitboxes; it does not draw FreeType caption text or certify a full window.
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
shadows/blur, caption shaping and arbitrary font-file loading are not added by
this theme system.

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

`desktop.configureAppearance(theme)` uses private appearance protocol v2:
prepare validates a fixed numeric layout and an immutable descriptor; commit
applies it. Each window owns current and pending value snapshots so a delayed
configure acknowledgment cannot mutate an older frame. Three-second transport
deadlines report lost or uncertain acknowledgment explicitly; a transport loss
is not reported as a successful rollback.

The document is carried in a size-checked, sealed memfd, avoiding Wayland's
small individual-message limit. It is capped at 32 KiB after serialization.
PollyWM checks descriptor size, readability and sealing but does not parse JSON.
The generated C schema lists supported fields and bounds. Generated presets
provide the compositor bootstrap appearance and native test oracles, not a
runtime theme-ID registry. Runtime theme IDs and values do not require recompilation.

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
