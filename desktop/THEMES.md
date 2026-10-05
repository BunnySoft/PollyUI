# Runtime desktop themes

PollyShell JavaScript owns theme loading, schema validation, user overrides and
UI rendering. PollyWM accepts only bounded decoration parameters from the trusted
Shell. It does not interpret theme files or execute theme code.

## Data and ownership

`themes/builtin.json` contains the five shipped presets. `themes/fallback.json`
is a packaged recovery catalog. `shell/theme-schema.mjs` defines schema version
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

In **Appearance**, choose **Reload and apply theme files** to load changes and
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
  configured titlebar. Fractional decoration parameters use 0.001 precision.
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
The generated C schema lists supported fields and bounds. The generated five
legacy presets remain for protocol-v1 compatibility and bootstrap only; runtime
theme IDs and values do not require recompilation.

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
