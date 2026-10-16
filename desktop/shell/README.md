# Power panel

Power uses the existing theme typography and bounded, wheel-scrollable client
area. Application-close coordination, cancellation, permission checks and the
explicit final shutdown/restart confirmation remain unchanged.

# Notifications

Toast and notification-center lists use bounded client viewports with wheel
scrolling. Long message bodies scroll vertically; action strips scroll
horizontally without consuming an application's notification action. Available
width is shared with the application label so Dismiss remains accessible.
Notification identities, revisions, expiry and action dispatch remain unchanged.

# Desktop popup menus

Window actions, workspace management, desktop-shortcut management and the window
switcher share the existing fixed-frame, scrollable-content panel helper and
theme typography. Workspace action rows wrap on narrow surfaces; the native
name field and all management callbacks retain their existing ownership.
Tray menus use the same scrolling surface and shared enabled/selection-ink
commands. Tray item wheel events still go to the offering application.

# Classic All Programs

The Classic applications menu adds an All Programs submenu inside the existing
RootMenu window. The normal two-column menu and explicit legacy single-column
layout retain their application list, Search, Pin/Unpin, available Files/Settings
links, Refresh, Close menu and logout actions.

The submenu lists the actual Shell desktop catalog and uses the existing launch
and desktop shortcut services. It does not manufacture Windows programs, accounts,
recent documents or directory paths. Desktop-entry categories are non-exclusive
tags, not an installed Programs directory hierarchy; this implementation is a
flat All Programs submenu, not a complete multi-level Programs tree.

When space permits the submenu occupies the right-hand area beside its trigger.
Otherwise it overlays existing content below the trigger, bounded by the same
window's actual client viewport. Back, Left and Escape return to the trigger.
Right opens it; Up/Down, Home/End and Tab navigate enabled commands. Long lists
scroll, and keyboard focus reveals the actual command. Hover can open the submenu
without crossing an unowned popup surface. In a viewport too small for one command
and its header, content remains clipped rather than claiming a fully usable fit.

Open state belongs to the current Shell menu, not the theme object. Reconciliation
and appearance repaint retain its state and scroll. A live catalog update leaves
removed rows inert until the submenu closes, because the small reconciler is
positional: a pressed row must never become a different application. Reopening
releases those vacant slots. Callback generations and current-menu/catalog guards
reject stale launches, shortcut actions and deferred focus.

No new native window, popup grab, permission, namespace or input routing is added.
The existing `PollyShell.menu` outside-dismiss, exclusive-zone and session-lock
guards remain authoritative. Component host input is not evidence of compositor
outside-dismiss behavior; the native bounds fixture separately measures the
submenu against a real child window's client input document.

`desktop/tests/classic-programs-render.mjs` exports the bounded actual GUI and
native-client geometry fixtures. `desktop/tests/menu-host.mjs` covers the real
Shell controller's callback lifetime, launch and existing menu authority seams.

# Application tasks and Dock groups

`panel.taskGrouping` is optional schema-version-1 theme data: missing or `windows`
retains the original per-window task API and active-click minimize behavior.
The packaged and recovery Modern, Aqua/Tiger, Lion and Big Sur presets explicitly
select `applications`; XP and Classic remain per-window. Custom themes do not
infer grouping from their ID, styling or panel kind.

One pure `windowTasks` model feeds both the panel/Dock and the native Dock width
calculation. It groups only exact, nonempty real `appId` values on the current
workspace; an unknown ID leaves each original Window.id independent. Names come
from an exact catalog ID or a unique explicitly registered `X-Polly-AppId`
(validated manifest ID for bundles), otherwise the actual app ID. Exact catalog
IDs take precedence; conflicting registrations do not depend on catalog order.
No executable/title/desktop-file-suffix guesses or launchability assumptions are
made. Windows stay running while
minimized; labels distinguish all versus some minimized, and multi-window groups
show their count. In applications mode, stable numeric window order is independent
of active/clock changes; per-window mode preserves its input order. Catalog/model
work is cached between actual snapshot changes.

Modern single-window groups retain active-click minimize/otherwise activate.
Mac-style single-window groups activate/restore rather than minimize an active
application. For clarity and access to every real window, **all multi-window
groups open a window chooser on primary click**, including Mac-style Docks; this
is Polly's explicit behavior, not a claim of exact commercial macOS behavior or
an invented native MRU API. ContextMenu/right-click also opens that chooser, even
for a single known application. Unknown windows and explicit per-window mode keep
the old actions. The three fixed Dock entries, running markers, icon sizing,
natural gap/fitting math and inner/outer scrolling are unchanged.

The chooser occupies the existing bounded RootMenu client window, not Alt+Tab or
a native popup. Its passive outer chrome consumes the shared `panelAppearance`
and `panelDetail` menu policy; only its bounded geometry belongs to this consumer.
Its live rows activate, minimize/restore or close only that real
window. No launch, pinning, process-wide close, new preferences, native protocol
or management authority is added. Tab/arrows/Home/End navigate bounded commands;
focus reveals long-list rows. Escape/Close menu returns to the opener when it is
still live. Stable vacant row slots and gesture identities prevent a held row
from becoming a different target; current-menu, application membership and live
workspace checks reject obsolete callbacks.

`desktop/tests/window-groups.mjs` covers the pure model, theme-file/catalog/override
contract and count-based Dock width. The application-task cases in
`desktop/tests/menu-host.mjs` exercise the real Shell controller on two outputs,
including notification-before/after workspace and membership guards. The exported
`checkWindowGroups(directory)` and `checkNativeWindowGroupBounds()` fixtures in
`desktop/tests/window-group-render.mjs` cover actual renderer/input and native
client geometry respectively. They use explicitly nonempty app-ID fixture
snapshots, not evidence of compositor permissions, physical DPI or native MRU.

Start and generic Apps menus reuse the same bounded bitmap cache as desktop
shortcuts and taskbar/Dock tasks. Only the current filtered list (up to 100
entries) adds menu-specific resources; closing the menu releases that extra
retention. Available registered PNG/JPEG artwork replaces the existing glyph
in the same box without theme recoloring. Missing or unsupported artwork keeps
the original fallback. Classic All Programs retains its existing text layout.

Production Start/Apps search mounts one real SDK text input owned by the current
menu window. Caret movement, selection replacement, Delete, clipboard editing and
IME use the existing input implementation; committed search is bounded to 128
code points without discarding an unselected suffix. Repainting retains the input
and does not assign an unchanged value. Enter launches the first available match
only outside composition; Escape/Tab keep their existing menu routes. Closing
cancels composition, clears and retires the input, and rejects its old callbacks.
Pure view-only callers retain their compatible fallback search rendering.

# Trusted display and logout confirmation surfaces

The existing token-bound display Keep/Revert layer and save-before-logout layer
consume the shared passive dialog appearance/detail. Their outer frame remains
fixed; `panel-viewport.mjs` gives only the inner content bounded scrolling.
Logout buttons use the shared primary/nonrepeating/noncomposing activation and
theme typography rather than another button painter. Their content is already
an undecorated Shell layer; this does not add a second frame to ordinary
WM-decorated applications.

These are view changes only: the display token, deadline and Enter/Escape
routes, and logout close-request, cancellation, pending-app/save wait, fresh
inventory/seal and explicit final action remain owned by the original
controllers. `desktop/tests/transient-panel-render.mjs` uses real GUI consumers
with inert bounded service dependencies; it neither connects a network,
transmits real credentials, changes displays nor ends an actual session.
`desktop/tests/panel-viewport-render.mjs` additionally checks real wheel pixels,
Tab/programmatic focus visibility and bounded reveal cancellation. The helper
observes only the current actual focus, never changes focus or stores a stale
target, and uses no polling or ongoing frame loop. Unchanged content repaints
do not undo a manual scroll; another focus/Tab change or actual layout change
is required to reveal again.
