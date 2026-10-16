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
from an exact current catalog match or the actual app ID, not guessed executable
aliases, installation status or launchability. Windows stay running while
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
