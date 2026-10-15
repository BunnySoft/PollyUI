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
