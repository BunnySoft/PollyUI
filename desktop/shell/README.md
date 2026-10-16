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

# Local session display profile

The production Shell entry reads one local display snapshot at startup from real
uid/euid and the fixed, trusted `/etc/passwd` record. Classic/XP two-column Start
headers can show that record's display name and actual username/UID inside their
existing 40px/64px header. Names use the shared theme font projection and retain
their complete accessible labels; long Unicode text is clipped, not rewritten or
shrunk. The existing original generic avatar is not a claimed account photograph.
A zero-height header override or a non-two-column menu does not create a profile
area. Older view/Shell callers that do not explicitly supply a profile keep the
original PollyDesktop brand and header markup.

The immutable snapshot is display metadata only, not authentication, NSS/directory
service authority, an account-management capability or a login-session claim.
No environment username/home guess, password action, account switcher, Recent
history or new preference/IPC is added. Root/mixed-ID sessions and unsafe, absent,
ambiguous or malformed local records remain explicitly unavailable under the
existing filesystem restrictions. A known numeric ID displays **User &lt;uid&gt;**;
otherwise the label is **User unavailable**, with **Local name unavailable** below.
The sanitized diagnostic is reported once when the Shell is created, without
overwriting service/action errors or rereading passwd on every clock/menu update.
It does not block desktop startup, change window/launcher authority or replace
Search, Programs/source folders, either pin domain or logout.

# Classic All Programs

The Classic applications menu adds an All Programs submenu inside the existing
RootMenu window. The normal two-column menu and explicit legacy single-column
layout retain their application list, Search, Pin/Unpin, available Files/Settings
links, Refresh, Close menu and logout actions.

The submenu defaults to the actual flat Shell desktop catalog and uses the existing
launch and desktop shortcut services. Its optional **Categories** header entry
browses exact, non-exclusive `entry.categories` metadata tags; the same application
can appear under several tags. Entries without tags appear in **Uncategorized
(no tags)**, distinct from a literal category tag named `Uncategorized`. Only
categories with current catalog members are listed. All apps is always available
from the category index or a leaf, and root Search/Pin/Refresh/logout are unchanged.
This does not manufacture Windows programs, accounts, recent documents or paths,
or implement an installed directory hierarchy or XDG menu XML tree.

When the final catalog includes qualified nested desktop-entry sources, the
category index also offers **Source folders >**, separate from any identically
named metadata tag. This is a merged tree of the actual recursive registration
sources, not a filesystem browser or a Windows Programs directory. A source
qualifies only when its absolute `entry.path` has valid nonempty path segments
(no dot/dot-dot segments, backslashes, controls or invalid Unicode), and the
tail of exactly `entry.id.length` characters starts after a slash and produces
that exact `.desktop` ID when its slashes are replaced by dashes. This follows
the native scanner's length-preserving ID projection; it never splits a
hyphenated ID to guess folders or assumes a particular XDG installation root.
Only the final override winner's path is used. Virtual Settings entries, managed
bundles and any unverifiable sources stay available in All apps but do not gain
invented source paths. No nested qualified sources means no Source folders entry.

Each source view shows direct subfolders and directly registered applications;
identical relative folders from different actual roots merge. Enter/Right opens
a subfolder. Back/Left/Escape walks its parent folders, then the merged source
root, category index, flat All Programs and finally the Start trigger. Every
level retains All apps. Folder state is menu-local and separate from category
tags; transitions change the existing navigation epoch. Entry/folder activation
requires a successful fresh catalog read and rechecks the exact current folder
or direct membership, so moving the same ID across a slash/hyphen boundary does
not preserve an old leaf's authority. A removed directory can remain as an empty
view with Back/All apps rather than redirecting a held action. Returning to an
already-owned direct parent needs no new catalog read, so Back/Left/Escape remain
safe exits during an I/O failure. That retained display does not clear the error
or authorize launch/Pin; entering a new folder and every application action still
require a successful fresh membership check. This does not scan
directories, expose empty/unregistered filesystem folders, add XDG menu XML,
change application identity/launch routing, or persist another preference.

When space permits the submenu occupies the right-hand area beside its trigger.
Otherwise it overlays existing content below the trigger, bounded by the same
window's actual client viewport. At the flat root, Back, Left and Escape return
to the trigger.
Right opens it; Up/Down and Home/End keep navigating enabled list commands.
Tab/Shift+Tab also include the compact, single-row Back and Categories/All apps
header controls, rather than trapping focus in the application rows. In a
category leaf, Back/Left/Escape returns to its category; from the category index
they return to flat All Programs; from flat All Programs they return to the
Start trigger. Enter or Right opens a focused category. Long lists
scroll, and keyboard focus reveals the actual command. Hover can open the submenu
without crossing an unowned popup surface. In a viewport too small for one command
and its header, content remains clipped rather than claiming a fully usable fit.

Open state belongs to the current Shell menu, not the theme object. Reconciliation
and appearance repaint retain its state and scroll. A live catalog update leaves
removed rows inert until the submenu closes, because the small reconciler is
positional: a pressed row must never become a different application. Reopening
releases those vacant slots. Callback generations and current-menu/catalog guards
reject stale launches, shortcut actions and deferred focus. Category navigation
is scoped to this RootMenu only, with a new epoch on every view transition and
reset on close. Launch/Pin callbacks recheck current catalog membership in that
exact leaf (including untagged membership), not just global application existence.
Metadata changes can leave an empty leaf with Back/All apps instead of redirecting
a held command to a different category or silently launching a removed member.

No new native window, popup grab, permission, namespace or input routing is added.
The existing `PollyShell.menu` outside-dismiss, exclusive-zone and session-lock
guards remain authoritative. Component host input is not evidence of compositor
outside-dismiss behavior; the native bounds fixture separately measures the
submenu against a real child window's client input document.

Long All Programs/category lists and window-group/launcher management lists
opt into the shared themed 10px vertical overlay scrollbar. Their original
list IDs and direct command slots remain unchanged inside a flex scroll area;
the scrollbar is a passive-layout sibling, so it does not reduce command widths
or move the menu's header/Close slots. Wheel and command focus reveal synchronize
the same thumb, while the SDK owns page clicks, drag capture, arrow/keyboard
scrolling and theme appearance. Tab includes an enabled scrollbar; list arrows
retain their existing command-navigation path. Short lists hide/disable the bar.
Same-DOM retheming keeps the controller and current drag, and leaving cancels
pending bounded layout work, capture and listeners. This does not add a popup,
new input authority or an idle animation/observer loop.
Composing keyboard events remain untouched throughout the ancestor chain:
desktop selection, menu navigation/dismissal and trusted display Keep/Revert
shortcuts do not reinterpret them after a child control returns. Ordinary
navigation and token-bound confirmation retain their existing behavior.

`desktop/tests/classic-programs-render.mjs` exports the bounded actual GUI and
native-client geometry fixtures. `desktop/tests/menu-host.mjs` covers the real
Shell controller's callback lifetime, launch and existing menu authority seams.

# Application tasks and Dock groups

The Tiger, Lion and Big Sur Dock presets use `panel.materialOpacityPercent: 88`
for their passive bottom material only. This is a configurable Polly default,
not a measured OS opacity. The optional schema-version-1 field accepts integer
percentages 0..100; missing or 100 preserves the original opaque colors and
rendering path, and an override of 100 restores solid material. At 0 the bottom
material is transparent while icons, registered bitmaps, focus, running markers,
badges and separators retain their own original colors and opacity.

The existing transparent Dock layer can show the scene behind these RGBA fills.
The Dock parent is not faded, geometry/input are unchanged, and no background
pixels are sampled. This is alpha composition, not Acrylic, vibrancy or blur;
Lion reflection/Dock shadow and Big Sur wallpaper tint/live blur remain absent.

Big Sur also selects `panel.menuBarOpacityPercent: 88` for the menu bar's passive
background gradient. This separate optional integer 0..100 field defaults to 100;
missing/100 retains the old opaque panel surface, and an override of 100 restores
it through the existing surface replacement lifecycle. Dock-kind panels below
100 request the existing transparent surface option so their RGBA background can
actually reveal the scene behind it. At 0 the background is clear; text, clock,
tray, buttons, focus, the existing bottom edge and all hitboxes are unchanged.
Tiger/Lion have no default menu-bar override and retain their old opaque path.
This is customizable Polly alpha policy, not measured macOS opacity, wallpaper
tint, vibrancy or backdrop blur.
Fixed panel/Dock actions also recheck their live surface and output before
dispatch, so callbacks retained from an opaque/transparent surface replacement
cannot reopen menus or act through a retired panel.

`panel.taskGrouping` is optional schema-version-1 theme data: missing or `windows`
retains the original per-window task API and active-click minimize behavior.
The packaged and recovery Modern, Aqua/Tiger, Lion and Big Sur presets explicitly
select `applications`; XP explicitly selects `windows-launchers` and Classic
remains per-window. Custom themes do not
infer grouping from their ID, styling or panel kind.

## XP Quick Launch

Explicit `windows-launchers` mode prepends the saved ordered catalog pins as
compact icon-only Quick Launch buttons, then keeps every real window task in its
original order and original Window.id interface. The XP packaged/recovery preset
opts in; missing or `windows` custom/Classic themes do not. Empty pins add no
placeholder slot or separator. The existing horizontal task viewport and wheel
scrolling remain in use; focusing a Quick Launch button or a later real window
reveals that target without adding a second scrolling controller or an idle loop.

Quick Launch is always a launcher, including when that application already has
windows. It does not merge those windows or turn a launcher click into activation.
Its accessible label says "pinned launcher", not "not running". Available artwork
uses the same retained registered bitmap cache at 16px; missing artwork uses the
original generic fallback. Real window buttons retain their original dimensions,
active-click minimize/otherwise activate behavior and window actions.

Apps pin controls and Quick Launch context/keyboard management reuse the same
independent v3 launcher list, canonical Settings identity, atomic write/error
handling and Earlier/Later ordering described below. Unavailable entries remain
focusable and manageable without executing stored argv. Settings uses the
existing bridge, not a duplicate process. This is functional Quick Launch, not
certification of a complete external XP profile, system tray or reference pixels.

The Luna/XP Start menu also reuses the existing All Programs/Categories surface:
the actual catalog defaults to a flat list, with optional exact metadata tags,
desktop Pin and the shared long-list scrollbar. Back/Left/Escape and navigation
epochs follow the same rules as Classic above. Root search, desktop Pin and
Quick+/Quick- remain independent. This does not add an installed-directory
backend, account profile, Recent list or another popup window, and does not
enable Programs for Modern or Mac-style menus.

## Independent taskbar and Dock pins

In explicit `applications` or `windows-launchers` mode, each Apps entry has a separate Taskbar+/Taskbar-
or Dock+/Dock- control. Its accessible name says which application and destination
it changes. This is independent of the existing desktop Pin/Unpin control: removing
a taskbar or Dock launcher never deletes a desktop shortcut. The ordered list of
at most 32 unique catalog IDs persists in Shell configuration v3's version-1
`launchers` domain. Existing v1/v2 configurations migrate atomically without losing
their other domains; see `desktop/SHELL-CONFIGURATION.md`.

Pins occupy the first display slots in saved order. In `applications` mode a uniquely associated running
application uses that same slot with its real window count; other running tasks
follow in their existing order. The model also supplies Dock surface sizing.
Idle launchers have no running marker and invoke the existing catalog-rechecking
launch path. Settings' synthetic and registered menu entries manage the same pin,
and its launcher uses the existing Settings bridge rather than another process.
Running pins keep the existing single-window/multi-window behavior below.

Missing or unavailable registrations are retained, visibly labeled unavailable
and remain keyboard focusable. Primary click or ContextMenu/Shift+F10 opens the
existing RootMenu with the reason and Unpin; it never uses old argv or a fabricated
window handle. Its pinned-app controls also offer **Earlier / Later** to move one
position in the existing saved list, including unavailable entries. The first
item omits Earlier and the last omits Later; an unpinned group has no order
controls. These commands use the same atomic publication and error reporting as
Pin/Unpin, never alter desktop shortcuts, and reject callbacks for a closed menu,
removed output/pin or changed expected position. Keyboard traversal and focused
command reveal stay inside the existing menu. This is explicit one-step ordering,
not drag-and-drop reordering or animation. A running group's chooser also provides
Pin/Unpin when its real
catalog association is unambiguous. Held launcher-to-running transitions and
changed membership/workspaces invalidate the old gesture. Pin write errors are
reported and the UI follows the actually committed configuration snapshot,
including durability failures. There is no drag ordering, MRU,
process-wide close, new native API or extra bitmap cache. Classic and custom
`windows` mode keep the original per-window behavior and do not display launchers.

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

## Bounded Dock distance magnification

Mac-style `tiger`, `lion` and `bigsur` Dock surfaces emphasize glyphs and registered
bitmaps without moving their slots. Optional schema-version-1 theme
`icons.dockHoverPercent` still accepts integer 100-125; missing or 100 disables
enlargement. Optional `icons.dockMagnificationRadius` accepts integer 0-3:
missing/0 retains the exact previous single-hover behavior, while a positive
radius weights visible neighbors continuously by pointer distance. The three
packaged/recovery Mac presets select peak 120 and radius 2. Fixed Apps/Settings/
About and the visible window strip form one adjacent sequence; the separator
does not become an action or interrupt that sequence.

Scaling is center-based paint only, limited by the actual slot, clipping
ancestors and the native client body's visible viewport. A normally 40px
artwork can paint at 48px with enough room, less when space is restricted,
or remain unscaled if it is already clipped. Slot/tile sizes, hit testing,
running indicators, counts, fixed actions and window dimensions never expand;
bitmaps retain their original color. Entry, movement and leave use a 140ms
smoothstep transition with a finite 24-callback safety bound; settled state has
no animation frames. Leave or pointer cancellation restores every affected icon
exactly to scale 1. Clock reconciliation and immutable retheming preserve the
physical pointer and per-instance state without restarting unchanged transitions.
Wheel/focus/layout settling recomputes actual clipping bounds; clipped artwork
cannot magnify. Retirement cancels pending layout and animation work through
the existing owner checks, including ownerless ancestor removal.
Keyboard focus keeps its existing outline and does not trigger magnification.
This is bounded artwork magnification, not neighboring-slot displacement, a
larger native input/surface region, or full commercial macOS magnification/MRU
qualification. It adds no compositor, animation framework or preference service.

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
