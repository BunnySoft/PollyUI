# PollyDesktop

An experimental Linux desktop subproject. **PollyWM** is our own C11 Wayland
compositor built on **wlroots 0.19.3 or newer 0.19.x**, not labwc, GNOME or KDE.
It includes a native development **PollyShell** with themed wallpaper, panels,
Dock and appearance settings. An unsigned, memory-only x86_64 UEFI development
ISO now boots this desktop in a disposable VM. It is **not yet a complete,
production-qualified desktop distribution**; see **[Live image](./LIVE.md)**.

## Architecture and implementation plan

Keep three boundaries:

- `compositor/`: PollyWM owns outputs, seats, window geometry, focus and
  composition. wlroots supplies device/rendering/protocol infrastructure.
- `shell/`: shared appearance presets, the native multi-surface PollyShell and
  a separate simulated appearance preview. The real shell runs in its own
  process; a shell crash must not terminate other applications.
- Session/system integration: native application launching, private D-Bus session and notifications; future system services,
  permissions, persistence and distribution packaging.

The compositor does not link QuickJS, Yoga, Skia or SDL. The generic PollyUI
engine must not depend on the desktop. Use wlroots' scene graph for external
applications rather than importing their buffers into the PollyUI DOM.

| Stage | Scope and acceptance gate |
|---|---|
| 1 - implemented here | Standalone compositor, two real xdg-shell clients, rendering/frame callbacks, focus, move/resize, close, lifecycle and nested WSLg execution. |
| 2a - implemented here | Maximize/fullscreen/restore, output-aware placement and migration, logical output geometry, and popup constraints. Independent clients exercise delayed/skipped configures, nested menus and simulated output changes. |
| 2b - remaining window policy | Tiling/overview and advanced window rules, startup display profiles and real-hardware hotplug qualification. |
| Display settings - implemented | Native resolution/refresh, scaling, rotation, placement and enable/disable controls, complete-snapshot validation, and compositor-owned keep/revert watchdog with Shell-loss/topology recovery. |
| Clipboard and pointer drag transport | Native UTF-8/MIME clipboard, primary selection, validated Wayland pointer drags and icons, cancellation/focus recovery, and incoming PollyUI text/file drops. PollyUI outgoing drag-source and full DataTransfer APIs remain deferred. |
| Native input method | Separately trusted Rime service, public text-input-v3 relay, compositor-positioned PollyUI candidates, inline preedit, click-to-commit, cancellation, sensitive-field isolation and service-loss typing recovery. |
| Linux Unicode text | HarfBuzz shaping, ICU bidi and grapheme/line boundaries, shared measurement/drawing, whole-grapheme editor movement/deletion, RTL hit testing and selection. Compositor title captions still use their separate simple FreeType path. |
| Session bus and notifications | Owned private D-Bus daemon per development session; validated app inheritance, bus-loss cleanup, standard notifications with native themed toasts/center/actions and bounded sender-owned state. |
| Status tray | Sender-owned asynchronous StatusNotifier watcher/host, native memory icons, status changes, pointer/scroll actions and themed DBusMenu submenus with stale/disabled-action protection. Icon-name-only items use labels; legacy XEmbed remains deferred. |
| Wi-Fi client | Native iwd settings for discovery/RSSI, scanning, radio power, connection, bounded interactive authentication and forgetting profiles, with root-owner verification and service-restart recovery. Isolated protocol/UI fixtures pass; real radios and DHCP/DNS need hardware qualification. |
| Audio policy and controls | Opt-in private PipeWire core, own routing/default-device policy, volume/mute UI and validated socket connection, without WirePlumber. Real virtual playback/capture, manual routing and device-loss coverage; physical audio and Pulse/ALSA client compatibility remain separate. |
| Workspaces - implemented | Four initial, globally synchronized manual workspaces; create/switch/remove, safe window-family migration, current-workspace taskbar/Dock filtering, keyboard switching and Shell reconnect. Empty workspaces remain; cross-login restoration is deferred. |
| Switcher and shortcuts - implemented | Native recent-use window list with forward/reverse cycling, cancellation and release/click acceptance; editable, conflict-checked, disableable shortcuts with restart persistence. |
| Window decorations - implemented | Negotiated server-side titlebars/borders, title text, controls, drag/resize, maximize/fullscreen geometry and live five-theme integration, while honoring client-side decoration requests. |
| Appearance - implemented preview | Switchable XP, Server 2003 Classic, OS X Aqua, Lion and Big Sur-inspired original themes. The preview remains simulated; the native Shell and negotiated PollyWM frames reuse the same tokens. |
| Linux runtime - raster/GLES milestone | Native Alpine/musl Skia build, Fontconfig/FreeType fonts, SDL3 EGL/GLES with explicit raster fallback and runtime error handling. Software GL is validated; physical GPU acceleration is not yet qualified. |
| Runtime services - implemented | Linux HTTP/HTTPS with certificate checks, XDG app namespaces, atomic storage and joined request/worker/task shutdown. No sandbox, secret store or full browser Fetch API is implied. |
| CI - definitions and local checks | Alpine ordinary/sanitizer builds with real clients on headless PollyWM, Windows core/WinHTTP and macOS raster jobs. Hosted execution requires pushing the workflow; local Linux/Windows results do not verify macOS. |
| Shell boundary and development session | Optional explicitly spawned shell with a private Wayland connection, bounded opt-in restart/backoff, and an isolated session launcher. Login, authentication and production session policy remain separate. |
| 3a - compositor layer-shell | Four layers, committed placement, exclusive work areas, keyboard modes, per-output lifecycle and nested popups. Real protocol clients exercise rendering and shell-crash isolation. |
| 3b - PollyUI layer host | Native layer roles on a shared trusted connection, output selection, raster/GLES rendering, input, fractional scaling and output-loss cleanup. Actual native clients cover these paths. |
| 3c - native development PollyShell | Real per-output wallpaper, taskbar/menu bar, floating Dock, appearance/about overlays, searchable native application launcher, live window buttons/actions and persistent five-theme selection. System services remain separate steps. |
| Multi-window runtime - implemented | A shared JS realm with per-window documents, input, rendering and close lifecycle. PollyShell can own multiple native surfaces without creating a process per surface. |
| 4 - usable session | Outgoing PollyUI drags, advanced text, power and remaining audio/network integration, secure session lock, restricted management commands where standard protocols are insufficient. |
| Runtime packaging | Relocatable Alpine x86_64 installation, private patched SDL, pinned runtime package list, dependency inventory, licenses and SHA-256 checksums. This is a development runtime bundle, not an ISO or a qualified distribution release. |
| UEFI Live development image | Memory-only root, Alpine/OpenRC + PAM/elogind session, temporary ordinary-user automatic login, guest DRM/libinput desktop and keyboard workspace switching. OVMF/KVM verified; no disk installer, protected login, secure lock, signing trust or physical hardware qualification. |
| Authentication and lock mechanism | Ordinary-user PAM helper, separately trusted standard session-lock client, native password UI and crash/output-loss black-cover protection. Real masked typing/PAM unlock verified; protected-session/power integration remains incomplete and the passwordless Live keeps locking disabled. See `SESSION.md`. |
| Power controls - authorization deferred | Native login1 capability checks and themed confirmation/cancellation; actual Live elogind denies shutdown/restart, so both remain disabled. No polkit or privileged authorization proxy. Suspend/hibernate remain unavailable. See `SESSION.md`. |
| 5 - system image | Alpine boot/login/session integration, non-root seat access, installation, persistent user data, signed updates/recovery and real hardware qualification. |

Prefer standard Wayland protocols. Workspaces/window management may later
require a narrowly scoped private protocol or socket, with an explicit trust
boundary. **There is no custom management socket or test-control protocol in
the production compositor.** Virtual-keyboard access is limited to the
separately spawned input-method connection, not public applications or the Shell.

### Trusted shell connection

`pollywm --shell PROGRAM [ARG...]` starts exactly the chosen executable without
an intermediate command shell. This must be the last compositor option; later
arguments belong to the child. Nothing is started implicitly. For example,
with a private runtime directory and backend configured as below:

```sh
./build/desktop/pollywm --socket pollywm-0 --shell \
    ./build/linux-sdl/pollyui --app-id org.pollyui.shell desktop/shell/preview.mjs
```

This still displays the **simulated preview**, not an actual panel. PollyWM
passes one socketpair endpoint as `WAYLAND_SOCKET=3`, and sets the child's
`WAYLAND_DISPLAY` to its own public socket instead of the parent compositor.
Only that exact live `wl_client` receives reserved shell globals. The
`zwlr_layer_shell_v1` version 4 global is filtered on both advertisement and
binding. Fixtures verify that guessing a known global ID does not bypass the
filter; ordinary xdg clients do not receive layer-shell privilege.
The standard `zwlr_foreign_toplevel_manager_v1` window-management global is
restricted to that same live shell connection. Public clients cannot enumerate
or control other windows through it, even when they know its global ID.
`polly_appearance_v1` is similarly restricted: v1 selects a known decoration
theme; v2 validates and commits bounded runtime decoration snapshots. Its
read-only companion, `polly_theme_manager_v1`, is public but grants no management
or filesystem access. Neither is a general window-management socket,
input-injection interface or arbitrary rendering API.
Workspace globals `ext_workspace_manager_v1` and
`polly_workspace_toplevel_manager_v1` have the same connection-bound restriction.
The standard protocol handles workspace operations; the private extension only
adds window membership and moves that the standard protocol does not provide.
`polly_shortcuts_v1` uses the same boundary for a fixed action catalog and
switcher presentation. It cannot run arbitrary command strings, and recording
suppression is only effective while a trusted Shell layer has keyboard focus.
`zwlr_output_manager_v1` and `polly_output_guard_v1` are also restricted. The
first carries standard output state/configuration; the second confirms or
reverts the current provisional transaction. Ordinary clients still receive
read-only `xdg-output` logical geometry.

Trust is **not** derived from UID, PID, `app_id`, executable name, or arbitrary
environment values. Even a new public connection from the shell's own process
has no shell privilege. libwayland consumes/unsets `WAYLAND_SOCKET` and marks
its connected descriptor close-on-exec. Shell code must use that connection for
its privileged surfaces; it must not deliberately copy the descriptor or
`WAYLAND_SOCKET` into launched applications. New application processes use the
public `WAYLAND_DISPLAY` connection.

On disconnect or shell process exit, the capability is revoked. Existing
ordinary windows retain their geometry, focus and connections. A nonzero exit
is reported without stopping PollyWM; initial exec failure instead fails
startup. The compositor reaps only its own shell child. Shutdown disconnects it,
tries SIGTERM, then escalates to SIGKILL after a bounded grace period. Child
signal masks are reset rather than inheriting the compositor's blocked signals.
Plain `--shell` still does not respawn automatically. `--shell-restarts N`
explicitly allows at most N additional attempts after nonzero exit or a signal,
with exponential backoff from 100 ms to 1600 ms. The lifetime budget is not reset
automatically. Normal exit status zero is never retried; exhausting the budget
leaves ordinary applications running and logs the failure. A new connection is
created for every attempt. Pending restarts are cancelled on shutdown.

`--exit-with-shell` additionally terminates PollyWM when the shell exits normally.
It does not terminate the session on a shell crash. Use this only when the shell's
normal exit is intended to end the session: remaining clients will disconnect.
There is no process-tree supervisor, login/authentication service, or production
logout/save protocol yet.

This is a compositor protocol boundary, **not an OS sandbox**: hostile processes
with ptrace/root access, a compromised trusted shell, or deliberate capability
delegation are outside it. Future privileged protocols must extend this filter
and validate the ownership and arguments of their requests. No management
protocol is promised by reserving a connection.

## Display configuration

The native **Appearance > Displays** panel changes real output state. It offers
advertised/custom resolutions, refresh rate, scale, rotation, logical placement
and enable/disable controls. Native fields are owned by the panel's document;
they do not use the original application's document accidentally.

Every apply is backend-tested and requires all current heads. Disabling every
output, stale snapshots and invalid geometry are rejected. Successful changes
remain provisional for 15 seconds; Keep/Revert and Enter/Escape decide the result.
The saved state and timer are in PollyWM, so a frozen or crashed Shell cannot
leave an unconfirmed setting indefinitely. Output loss aborts confirmation and
restores surviving outputs where possible. A failed recovery is an explicit
error, not a claim that the previous state was restored.

Logical geometry is advertised through `xdg-output`, which is necessary for
SDL clients to agree with fractional scales and output positions. Temporarily
disabled outputs regain their compositor work-area owner when re-enabled.
Settings currently persist within the running compositor session; startup
profiles remain a later persistence task. Physical GPU/DRM and HDR/VRR support
still require dedicated hardware qualification.

## Server-side window decorations

PollyWM supports `zxdg_decoration_manager_v1` and prefers server-side decoration
when a negotiating client has no explicit preference. Explicit client-side
requests are honored. A client which does not implement this protocol retains
its own header; PollyWM does not guess whether an application has painted one
or place a second titlebar over it.

The compositor draws caption text, active/inactive titlebars, borders and
minimize/maximize/close controls. Titlebar double-click toggles maximize; drag
moves floating windows and edges/corners resize them. Releases outside the
pressed control cancel the action. Fullscreen hides the frame, and maximized
client geometry excludes both Shell reservations and decoration extents.
Negotiation and theme geometry changes use the normal configure/ack/commit
path, so an older client buffer does not acquire a newer frame layout.

Shell appearance selection calls `desktop.configureAppearance(theme)` on the
private connection. JS reads and validates versioned JSON, then prepares and
commits bounded numeric decoration data and a sealed snapshot descriptor.
Custom IDs and same-ID edits apply without rebuilding the compositor.
`desktop.setAppearance(id)` remains a legacy compatibility API. The generated
C presets are retained for legacy/bootstrap use; generated schema fields keep
native bounds consistent with the JS validator.

Caption rasterization uses Fontconfig and FreeType with a bounded face cache
and scale-aware CPU buffers. This adds neither Skia/SDL/QuickJS/Yoga nor
GLib/GIO to PollyWM. Basic Unicode fallback is supported; shaping, bidi,
grapheme-aware ellipsis and complete accessibility remain later work.
The current frames have rounded titlebar tops, not rounded clipping of client
content, blur or shadows. Input bounds remain rectangular. Restore a maximized
window before dragging it; drag-to-restore and tiling gestures remain deferred.

## Appearance direction and native preview

The native entry is `shell/main.mjs`. Run it through the development session
launcher shown below. `shell/shell.mjs` owns the live surface set; `shell/views.mjs`
renders its controls, reusing the preview's original wallpaper artwork and
immutable theme tokens. The following preview documentation describes the
separate `shell/preview.mjs`, not the native Shell.

The desktop will offer multiple selectable appearances rather than hard-code a
single era. Appearance is separate from window-management policy: the compositor
remains floating, and no workspace/tiling policy was selected by choosing these
visual styles.

| Theme ID | Inspiration | Current visual treatment |
|---|---|---|
| `xp` | Windows XP / Luna | Blue rounded frames, green launcher, soft controls, original vector hills |
| `server2003` | Windows Server 2003 / Classic | Square gray frames, configurable blue title gradient, beveled buttons, solid desktop |
| `aqua` | OS X / Aqua | Pinstriped chrome, glossy pill controls, left-side circular captions, menu bar and dock |
| `lion` | OS X / Lion | Gray chrome, graphite woven-grid background, left-side captions, compact gray dock |
| `bigsur` | macOS / Big Sur | Larger rounded frames, unified light title/toolbar, blue accents, rounded-square dock tiles and original colorful bands |

`shell/themes.mjs` loads deeply immutable data from `themes/builtin.json`.
Every preset has the same desktop, color, window, icon, button, panel and layout groups.
`getDesktopTheme(id)` rejects unknown IDs rather than silently choosing a
different appearance. The Server 2003 preset intentionally represents its
Classic look, not another Luna color variant.

User JSON themes, limited overrides, local PNG/JPEG wallpaper resources,
explicit reload/restore and opt-in application subscriptions are described in
**[Runtime desktop themes](./THEMES.md)**. Layout and wallpaper parameters are
data-driven; configuration still cannot alter window-management behavior.

`shell/appearance.mjs` draws the preview using the **actual PollyUI reconciler
and native renderer**, not browser HTML or screenshots of another desktop.
The theme picker and launcher menu work with pointer, Enter and Space.
Minimize/maximize/close/reopen operate on the **sample window inside the
preview**; folder and sample-action controls update local demo state only.
Switching themes preserves this state. The outer native window keeps its
normal host decorations.

The window-frame, taskbar/dock and menu designs are original implementations
inspired by these eras. No Microsoft/Apple logos, wallpaper photographs, OS
fonts, copied assets or system binaries are bundled. Aqua and Big Sur's glass-like gradients
are opaque drawing, not compositor transparency/blur. The preview is explicitly
labeled **SIMULATED SHELL**; it does not launch applications, modify files or
OS settings, provide real window decorations, or manage PollyWM's other windows.
Theme selection currently lasts for the preview process only.
Big Sur currently provides the light appearance; a dark variant, actual
transparency and live background blur are not implemented. The larger floating
dock has reserved space in both normal and maximized sample-window layouts.

Run from the repository root with an already built PollyUI runtime:

```powershell
.\build\win-clang\pollyui.exe .\desktop\shell\preview.mjs

# Native rendering, layout, input and pixel assertions; failures exit nonzero:
.\build\win-clang\pollyui.exe --test .\tests\desktop-appearance.mjs
```

The existing root README describes the Windows/macOS runtime build. If Skia
has not been fetched, use `tools/fetch_skia.ps1` before `tools/build.ps1`.
The same `.mjs` entry is portable to the macOS and Linux runtimes. Linux now has
a separate native raster-runtime image; the compositor-only image does not
include PollyUI. See the root README's Linux build instructions or run:

```powershell
.\desktop\tools\test-linux-runtime.ps1 -Nested
```

This runs the actual PollyUI appearance code under WSLg and then PollyWM.
Linux has a Skia GLES path and structured input with separate text commits;
The native Shell uses separate layer windows rather than embedding this preview
as its desktop. IME preedit now has a separate native service and editor path.

The appearance test saves `build/appearance-<id>-<width>x<height>.png` for each
theme. It covers token shape/immutability, native layout and color rendering,
caption positions, menus, keyboard activation, preview window lifecycle,
state-preserving theme switches and mount/unmount. Use `PU_TEST_W` and
`PU_TEST_H` for different viewports; 640x480 is the preview's minimum target.
These appearance tests run separately from the WSL compositor suite.

The real Shell now has running-window buttons and a shared decoration policy.
Window-manager state remains owned by PollyWM; theme code must not become an
alternate window manager.

## Implemented behavior

- xdg-shell toplevels and parented popups; wl_shm clients and wlroots rendering.
- Viewporter and fractional-scale globals, with wlroots scene-managed preferred
  scale notifications for native clients.
- Click-to-focus and raise; activation and keyboard/pointer event forwarding,
  including implicit pointer grabs for drags outside a window.
- Cascaded initial placement on the output nearest the pointer, with the window
  origin kept accessible on small displays; interactive move/resize and client min/max sizes.
  Top/left resize anchors use the geometry actually committed by the client.
- Maximize/fullscreen and restore, including requests before the initial map.
  Floating geometry survives repeated state changes and fullscreen over maximized
  windows. Restoring floating mode uses the saved geometry's nearest live output;
  leaving fullscreen while still maximized fills the current output.
- Placement follows configure acknowledgement **and buffer commit**, not merely
  the request. Late buffers do not receive newer positions. Smaller fullscreen
  content is centered over an opaque black backdrop, and content is clipped to
  its output in fullscreen/maximized mode (including client-side shadows).
- Existing windows select the output with the greatest overlap (nearest output
  if offscreen). Fullscreen honors an explicit live output requested by the client.
  Output mode, scale, transform, disable and removal update affected placements.
  Windows migrate to an enabled output when their target disappears, including
  configured windows that have not mapped yet.
- Popups and nested menus honor positioner constraint adjustments at creation
  and reposition. Reactive popups are reconstrained when parent/output geometry
  changes; non-reactive popups retain their requested parent-relative placement.
- Client-side move/resize requests require a matching seat, client and pointer
  grab serial. Forged, cross-client and expired requests are ignored.
- Focus falls back to another mapped window on unmap, close or disconnect.
- Real minimized state hides a mapped window without destroying its surface or
  saved maximize/fullscreen geometry. Focus falls back only to visible windows;
  Alt+Tab restores its selected window, including when every window is minimized.
  Minimize dismisses existing popups and rejects new popups from a minimized
  parent. Clients may request minimization before their initial map.
- Shell-only foreign-toplevel handles expose live titles/app IDs, state, parent
  handles and output membership. Activate restores and focuses through the real
  seat; minimize/restore, maximize/fullscreen and close use the compositor's normal
  policy. Unmapping destroys the handle; close requests do not forcibly kill apps.
- Basic selection forwarding through `wl_data_device_manager`.
- XKB keymaps (standard `XKB_DEFAULT_*` environment settings), input-device
  lifecycle, frame scheduling via wlroots, signal-driven clean shutdown.
- Auto-selected wlroots backends; tested with headless and nested Wayland using
  the Pixman software renderer. No Skia GPU support is implied by these results.

| Binding | Action |
|---|---|
| Alt + left-button drag | Move the window |
| Alt + right-button drag | Resize from the bottom-right |
| Alt + Tab / Alt + Shift + Tab | Preview next/previous window; release Alt to activate |
| Ctrl + Super + Left / Right | Switch to previous/next workspace without wrapping |
| Alt + F4 | Ask the focused client to close |
| Alt + F9 | Minimize the focused window |
| Alt + F10 | Toggle maximize |
| Alt + F11 | Toggle fullscreen |
| Alt + Escape | Exit PollyWM |

Alt+Tab is scoped to the current workspace, including restoration of minimized
windows there. Inactive workspaces do not receive pointer/keyboard input.
The real Shell displays a recent-use picker without activating previews.
Escape cancels it, and clicking a row accepts it. Standalone PollyWM without
an opted-in Shell presenter retains immediate switching. The picker uses text
labels rather than live window thumbnails, and appears on the first display.

**Appearance > Keyboard shortcuts** records, disables and resets the seven
window/workspace bindings above, except the fixed development exit.
Conflicting bindings are rejected as a whole, including collisions with reverse
window switching. Preferences survive a full compositor restart through the
Shell's app-scoped storage. Binding-recording mode and picker cancellation do
not invoke the Alt+Escape session exit.
The parent desktop may intercept shortcuts in nested mode. Negotiating clients
can use PollyWM titlebars; clients requesting self-drawn headers retain them.
Maximize/fullscreen capabilities are advertised. Restore a maximized/fullscreen
window before dragging it; interactive move/resize is ignored while in those
states or while a state/placement configure is outstanding. State requests during
an existing interactive drag end that drag. Maximized/fullscreen sizes follow the
output rather than floating min/max size hints. Floating windows whose minimum
size exceeds an output may extend beyond it, but their top-left remains reachable.
Maximized windows use the output's unreserved work area; fullscreen windows use
the full output. Without panels these bounds are identical.

### Layer-shell policy

Only the explicitly spawned trusted shell connection can create layer surfaces.
This is intentionally not permission for arbitrary same-user clients such as
third-party panel programs connected to the public socket.

- Scene order is background, bottom, ordinary windows, top, overlay. Within a
  layer, newly created or reassigned surfaces are above older ones. A focused fullscreen
  window hides top surfaces on its output; overlay surfaces remain visible.
  Switching back to an ordinary window restores that output's top surfaces.
- An omitted output selects the enabled output nearest the pointer. Explicit
  output requests are honored. Disable/removal sends `closed` and destroys the
  affected layer surfaces/popups; the shell must recreate them on a suitable
  output. Layers are not silently migrated to a different monitor.
- Positive exclusive zones are applied in overlay-to-background order, newest
  first within a layer, and only while mapped. Anchors and edge margins determine
  the reserved edge. Zone zero uses the remaining area; zone -1 uses the entire
  output. Even if zones exhaust an output, the work area retains one logical
  pixel in each dimension so xdg size hints never ambiguously become zero.
- New sizes are configured once, and placement waits for the corresponding
  configure **and buffer commit**. Old/skipped acknowledgements do not acquire a
  newer placement; a first map awaiting a newer configure stays hidden. Unmap
  releases reserved space and resets initial-configure state. Calculations use
  wide intermediates; unusable/overflowing geometry closes the surface with a
  diagnostic rather than wrapping dimensions.
- Keyboard `none` leaves application focus unchanged. `on_demand` focuses on
  pointer click. Mapped, visible top/overlay `exclusive` surfaces take priority,
  with application focus restored when they close, unmap, or relinquish focus.
  WM shortcuts other than the development Alt+Escape escape hatch are forwarded
  while a layer owns keyboard focus. This is **not** a secure session-lock API.
- Layer popups may extend outside the panel, are constrained to its output, and
  support nested/repositioned/reactive xdg popups. Layer content is clipped to
  the output separately from the popup tree. A shell crash releases its layer
  surfaces, popups, focus and reservations without destroying ordinary windows.

Layer geometry is compositor-owned policy, not a second PollyUI window manager.
The scene helper's eager placement/unconditional configure behavior is not used:
size deduplication and commit-matched placement follow the existing xdg policy.
The generic wlroots subsurface scene helper still owns buffer rendering.

The root README's **Wayland shell surfaces** section documents the native
PollyUI API. Its raster/GLES fixtures verify actual Wayland buffer dimensions and
pixels, pointer/keyboard delivery, two outputs, 125%/200% scaling, mode/rotation,
removal, reservations, role replacement and rejection on public connections.

PollyWM routes the public `wl_data_device_manager` clipboard and pointer-drag
protocol and `zwp_primary_selection_device_manager_v1` primary selection.
Drag requests require a visible origin and the owning client's current pointer
grab serial. Icons and their subsurfaces render above Shell layers without
intercepting input. Escape, source destruction, a hidden/unmapped origin,
workspace changes and output-layout changes cancel the drag. Keyboard focus is
cleared during the drag and restored on completion/cancellation. Touch drags
are not implemented. Clipboard ownership is not persisted after the source exits.

Not implemented: tiling/overview, Xwayland, full session recovery,
PollyUI outgoing drag sources, screen capture/portals, advanced typography,
secure lock, full desktop services or installer. Display settings
are available, but startup display profiles are not persisted yet.
Popup constraints follow the adjustments allowed by the client (not arbitrary
forced clipping). Multi-output/HiDPI and DRM/seat access still need real-hardware
qualification; **WSLg is not evidence of native GPU/DRM or boot readiness**.

## Native input-method service

The input-method architecture deliberately avoids GLib/GIO and desktop-toolkit
candidate windows: a custom service and PollyUI candidate UI reuse an input
engine library. The adapter is `input-method/engine.c`, using the
librime C API (`rime>=1.7`; Alpine 3.24's 1.17.0 is exercised). Its runtime
dependency closure does not include GLib/GIO, GTK, Qt, GNOME or KDE.

`-DPU_BUILD_IME_ENGINE=ON` builds `polly-ime-engine` independently of the
compositor library. The Linux runtime checker enables it; the standalone
compositor build leaves it off. The adapter accepts an absolute shared-data
directory, an existing private user-owned 0700 directory, and a schema ID from
the configured schema list. Deployment/schema errors are explicit. One owning
thread/process handles the engine; maintenance is joined before use and exit.

Snapshots copy preedit, commit and candidate text into bounded C storage and use
UTF-8 byte offsets. They carry revisions so stale candidate clicks cannot act on
changed composition. Reset discards preedit without committing; ASCII mode
returns unhandled keys for the service to forward. Learning follows
the selected Rime schema, not an invented runtime privacy option. The small
original test schema disables its user dictionary and uses isolated temporary
data; it is not a distribution dictionary or a production configuration.

`pollywm --input-method PROGRAM` explicitly starts a separate trusted process;
place this option before `--shell`. Its inherited `WAYLAND_SOCKET=3` connection
alone may bind `zwp_input_method_manager_v2` and
`zwp_virtual_keyboard_manager_v1`. It cannot bind Shell management globals;
the Shell cannot bind the IME globals. Public text-input-v3 clients receive only
their own focused input. Guessed global IDs do not bypass these checks.
An IME crash does not close applications: preedit/popups are cleared and
ordinary keyboard delivery resumes. Automatic IME restart is not implemented.

The relay validates surrounding-text offsets and output bounds, rejects stale
commits, and requires a valid commit in the current focus epoch before accepting
virtual-keyboard forwarding. Background text-input requests do not invalidate
the active context. Forwarded held keys are released when an input session
changes. Password, PIN, hidden-text and sensitive-data contexts are not sent to
the service. This is a connection-bound capability model, not a sandbox for
an untrusted IME executable or schema/plugin.

`pollyui --input-method --app-id org.pollyui.ime desktop/input-method/main.mjs`
runs the candidate UI. It uses `inputMethod.start(sharedDirectory, userDirectory,
schema)`, `state()`, `choose(revision, index)` and `onchange`. Revisions are
strings; candidate indices are zero-based integers. `state()` includes active/
ASCII state, preedit, selected candidate, last-page status, and candidate
text/comments. This mode is exclusive with `--desktop`, keeps its event loop
alive without visible windows, and does not initialize Rime in ordinary apps.
Only an initialized, authorized service can create
`window.create({inputPopup: true, width, height, title})`.

Candidate surfaces use the standard input-popup role, not layer-shell or
ordinary toplevels. PollyWM positions them at the editor caret, constrains them
to the output, and preserves editor keyboard focus during clicks. Empty or
cancelled composition closes the candidate surface. The current candidate UI
has a fixed-size scrollable list and neutral appearance; theme following and
other input engines remain future work.

The runtime image includes Alpine's `rime-plum-data`; the default schema is
`luna_pinyin_simp`. Its data and engine licenses remain separate dependencies
for packaging review. Enable it in the development session with `--ime`:

```sh
sh desktop/tools/run-session.sh --nested --ime --restarts 3 \
    ./build/desktop/pollywm ./build/linux-sdl/pollyui ./desktop/shell/main.mjs
```

Set `POLLY_IME_DATA` to another absolute shared-data directory and
`POLLY_IME_SCHEMA` to a configured schema ID. User deployment/learning data
lives in the `org.pollyui.ime` XDG data namespace. The launcher checks service
support and dictionary availability; a default session without `--ime` is
unchanged. `run-input-method.sh` receives the chosen runtime via
`POLLY_IME_RUNTIME`.

The vendored input-method-v2 and virtual-keyboard-v1 XML files preserve their
upstream notices and come from the `swaywm/wlroots` 0.14.1 source mirror; their
version-1 wire interfaces are used with the supported wlroots 0.19.3 API.
Text-input-v3 comes from installed `wayland-protocols`.

The Linux text shim now includes direct HarfBuzz shaping and ICU bidi,
grapheme segmentation and line opportunities. Editor pointer geometry and
selection share the shaped text. The HarfBuzz build deliberately disables
GLib/GObject/Cairo rather than using Alpine's GLib-linked binary; the full
runtime dependency closure is checked. See the root README's Unicode layout
contract for ligature-caret and paragraph-direction limitations.

Remaining text work includes broader engine/hardware qualification and
advanced typography. SDL 3.4 exposes caret/purpose and preedit but no
surrounding-text setter; PollyUI does not implement delete-surrounding edits.
Numeric/phone purposes temporarily force the service into ASCII mode and
restore the preceding mode on the next ordinary text field. Display settings
mark their numeric inputs accordingly.

### SDL disconnect hardening

The runtime image builds SDL 3.4.10 at commit
`8e37db5e797b6167f3a00d697d816a684bd259c7`, applying
`patches/sdl-wayland-sync-lifetime.patch`. Stock SDL allocates an untracked
show/hide `wl_callback` during window teardown even after its Wayland
connection has failed; the callback can never receive its completion event.
Valgrind traced the forced-session-exit leak to this path.

The patch makes the window own its show/hide callback, clears the pointer on
completion and destroys an outstanding callback during window teardown.
It does not suppress leak reports, touch SDL internals from PollyUI, or
replace the host event loop with polling. The source notices are retained,
and this is an explicitly modified SDL build, not an upstream release fix.
The build disables IBus/libdecor integration; input methods and decorations
are supplied by PollyIME/PollyWM instead.

`tools/build-sdl-linux.sh SOURCE_DIRECTORY [INSTALL_PREFIX]` reproduces the
build; the default prefix is `/usr/local`. It checks the exact source revision
and refuses mismatching patches. Configure PollyUI with
`-DSDL3_DIR=INSTALL_PREFIX/lib/cmake/SDL3` when switching an existing build
from system SDL. The runtime checker sets this to the image's patched build.
HarfBuzz's toolkit-free source build is installed separately as a static library
at `/opt/pollyui-text`; the image sets `PKG_CONFIG_PATH` for its `harfbuzz.pc`.
It must not replace the distribution's shared HarfBuzz, whose optional ABI is
required by independent applications such as `foot`/libfcft.

## Build independently on Linux

wlroots has an unstable API: this target deliberately accepts **0.19.3 <= version
< 0.20**. Alpine 3.24 provides the tested `wlroots0.19` package. Earlier 0.19
versions omit `wlr_buffer_finish()` in the SHM allocator destructor, causing
use-after-free during nested/Pixman teardown. Upstream 0.19.3 fixes this; do not
lower the minimum or work around it by changing teardown timing.
Other wlroots API series need an explicit port, not an unbounded dependency change.
The installed `wayland-protocols` must also include
`staging/ext-workspace/ext-workspace-v1.xml`; the Alpine development image does.

```sh
# Alpine 3.24, as root only for package installation:
apk add build-base cmake ninja pkgconf wlroots0.19-dev wlr-protocols wayland-dev \
    wayland-protocols libxkbcommon-dev xkeyboard-config capitaine-cursors \
    fontconfig-dev freetype-dev font-dejavu

# From the repository root, as a normal user:
cmake -S desktop -B build/desktop -G Ninja -DCMAKE_BUILD_TYPE=Debug
cmake --build build/desktop
ctest --test-dir build/desktop --output-on-failure
```

This standalone build does not fetch or build Skia, SDL, QuickJS or Yoga.
The root project also exposes `-DPU_BUILD_DESKTOP=ON` for a combined build;
it remains **OFF by default**, so normal Windows/macOS builds do not acquire
Linux dependencies. A combined build still needs the normal PollyUI dependencies.
Use `-DBUILD_TESTING=OFF` when only the compositor is needed.

## Install and package the development runtime

A combined desktop build installs the `PollyDesktop` CMake component:

```sh
cmake --build build/linux-sdl -j 2
DESTDIR="$PWD/build/install-root" cmake --install build/linux-sdl \
    --prefix /usr --component PollyDesktop
build/install-root/usr/bin/polly-desktop --headless --audio --ime --check
```

The installation includes PollyWM, PollyUI, its adjacent application-launch
helper, runtime JS modules and session scripts. `polly-desktop` locates its
resources relative to its installed binary directory, not the source checkout.
The patched SDL is private under `lib/pollyui`; the installed executable uses
an origin-relative loader path and does not replace the system SDL.
`--check` starts the real session and exits after its Shell/audio startup check,
with an outer 30-second deadline and termination cleanup. It is not hardware,
input-method candidate interaction or complete desktop acceptance testing.
Normal operation omits `--check`; `--help` lists wrapper options.

On Alpine 3.24 x86_64, create a versioned package with the matching SDK sources:

```sh
node desktop/tools/package-linux.mjs build/linux-sdl dist/pollydesktop \
    /opt/pollyui-sdl /opt/pollyui-harfbuzz
podman build -t localhost/pollydesktop-alpha \
    -f dist/pollydesktop/Containerfile dist/pollydesktop
podman run --rm --network=none localhost/pollydesktop-alpha
```

The packager refuses existing output directories, sanitizer builds, incomplete
desktop builds and mismatched pinned dependency sources. It resolves both ELF
dependencies and explicitly required dynamically loaded Wayland/Mesa modules.
The clean runtime image runs as an unprivileged user without the checkout, SDK,
build tools or a host audio server. This does not add a production seat/login
policy or grant host device access.

Outputs include the installable `.tar.gz`, `rootfs/`, exact Alpine runtime
package versions, a file/hash/source manifest, an SPDX 2.3 dependency inventory,
license notices, the SDL patch and `SHA256SUMS`. Libraries normally supplied by
Alpine are not bundled in the tarball; the supplied Containerfile installs them.
The tarball explicitly records root ownership, 0755 directories/executables and
0644 data/configuration. The runtime Containerfile extracts this archive instead
of copying a Windows-backed staging tree, whose mode bits may not preserve POSIX
permissions. Treat `rootfs/` as inspection/staging data; deploy the archive or
perform a native CMake install.
The package list can contain dependencies of independent applications such as
foot, including distro HarfBuzz/GLib; our own ELF dependency check still rejects
GLib/GIO/GObject and shared HarfBuzz. Artifact checksums are not update signatures.

The source revision and dirty-worktree flag are recorded. A Windows worktree
whose Git metadata is unreadable inside the container must supply
`POLLY_SOURCE_REVISION` and `POLLY_SOURCE_DIRTY=0` or `1` from the host; the tool
never assumes that such a checkout is clean. Exact package versions depend on
their continued availability in Alpine repositories: an archived APK mirror
and bit-for-bit reproducible build are not provided yet.

This artifact is explicitly a **development runtime bundle, not itself an ISO**.
The separate [Live image builder](./LIVE.md) adds a kernel, UEFI boot and
temporary ordinary-user PAM/elogind session. Protected login/authentication, secure
lock, installer/persistence/recovery, update trust and hardware qualification
remain separate release gates. The dependency
inventory is not a completed third-party source/license-compliance audit.

## Run nested in an existing Wayland session

The development launcher provides a private runtime directory, shell identity,
an owned D-Bus daemon, signal forwarding and cleanup. It keeps application configuration/data outside
the temporary runtime directory and changes to the repository root for module
loading. Paths supplied to it are resolved relative to the invoking directory.

```sh
sh desktop/tools/run-session.sh --nested --restarts 3 \
    ./build/desktop/pollywm ./build/linux-sdl/pollyui ./desktop/shell/main.mjs
```

This starts the real development Shell. `--headless` needs no parent display;
omitting both flags preserves wlroots backend selection. Restart is opt-in
(`--restarts` defaults to zero). The launcher uses `--exit-with-shell`, so closing
the shell normally ends this development session. It prints the absolute public
Wayland socket path for independently launched clients.

The bus socket is `bus` inside that same owned 0700 runtime directory.
`session-bus.sh` percent-encodes the socket path, waits for actual readiness and
publishes `DBUS_SESSION_BUS_ADDRESS` plus the matching
`POLLY_SESSION_BUS_ADDRESS` marker. The marker is not a security capability;
native code also validates the address, runtime directory and socket ownership.
The parent bus and starter variables are removed. D-Bus service activation
receives this session's public Wayland display, not the parent's X11 display,
Shell private socket or capture/debug variables.

Concurrent sessions have separate bus IDs and namespaces. Bus loss terminates
the development session with an explicit error; compositor exit/signals stop
and reap only its owned daemon and remove known runtime socket/activation
directories. `dbus-daemon` is a required launcher dependency; this does not
start a system bus, network/power daemons or a production login manager. Audio
is a separate opt-in service described below.

PollyShell acquires the standard Notifications name only on this private bus,
never on an ambient parent session. Native toasts and a panel-accessible center
share the current theme; actions are unicast back to their sender and never
executed as commands by the Shell. Sender ownership, stale UI revisions,
expiry/close reasons and queue limits are enforced natively. Markup, external
images, sound and persisted history are not advertised or implemented. See the
root README for exact API fields and limits. The separate StatusNotifier
watcher/host also runs on this bus. Desktop-entry D-Bus-only activation remains
unsupported.

Tray item registration verifies well-known-name ownership asynchronously;
requests are pinned to the sender's unique bus name and object path.
Name-owner changes remove stale items and in-flight registrations. Icons are
copied ARGB pixmaps in process-local Skia assets, never remote-supplied file
paths. Passive items are hidden and attention status is emphasized.
Icon-name-only items currently use a readable label fallback.

For exported application menus, the Shell requests bounded DBusMenu layouts
and AboutToShow lazily, tracks revisions and invalidates old UI actions on
updates. Native menus include submenus, separators, visibility/enabled state
and check/radio indicators; a click sends a fixed DBusMenu Event rather than
executing arbitrary text. Providers without an exported menu receive
ContextMenu requests. All item/menu requests have native two-second deadlines.
No Qt/KDE/GLib library is used by these implementations; `org.kde` is a protocol
namespace, not a desktop dependency.

Native fixtures register independent providers, inspect rendered icon pixels,
click all three pointer actions, send scrolling, toggle passive/active/attention
status, reject registration by a different owner and verify owner-loss cleanup.
They also exercise hung providers, live submenu changes, disabled/stale menu
rejection and exact clicked-event delivery in raster and GLES modes.

### PipeWire audio backend

The selected backend is PipeWire core with our own native policy and PollyUI
controls, not WirePlumber. Enable it explicitly:

```sh
sh desktop/tools/run-session.sh --nested --ime --audio \
    ./build/desktop/pollywm ./build/linux-sdl/pollyui ./desktop/shell/main.mjs
```

`session-audio.sh` starts the daemon from `system/pipewire.conf`, waits for its
private `polly-audio` socket and exports the session remote to child apps.
It never starts a host audio service. The Shell validates the owned runtime,
socket and peer UID, then passes the connected FD to PipeWire rather than
allowing ambient runtime-directory/socket fallback. Concurrent sessions use
separate cores. Daemon loss, normal exit and termination signals have explicit
owned-process cleanup.

The native main loop discovers bounded nodes/ports/links and default metadata.
Policy respects stream autoconnect and explicit targets, preserves manual links,
negotiates raw DSP ports and manages only its tagged routes. A supported mono
stream can be adapted to a stereo endpoint. Missing explicit targets remain
unrouted; default-device loss selects a fallback without discarding the preferred
name. Lingering links and metadata survive a policy/Shell reconnect, but
cross-login settings are not yet persisted. Audio settings expose native
volume/mute/default controls and unavailable-device errors.

The default config uses ALSA enumeration and ACP auto-profile/auto-port support.
Actual cards, jack changes, profiles and realtime latency need hardware
qualification. The tests use their own virtual sinks and synthetic source,
check nonzero captured samples and exact route endpoints, and cover manual/
missing-target behavior, stale controls, public-API denial and service cleanup.
They do not access speakers or microphones. PulseAudio emulation, ALSA-client
redirection, Bluetooth audio and portal capture permissions remain separate.
Setting up a private server and restricting Shell APIs is not an application
audio sandbox. See the root README for the API and model limits.

### iwd network backend

The selected Wi-Fi backend is iwd, with its own built-in network configuration
and PollyUI-owned UI. The Shell opens the system-bus client only when Wi-Fi
settings are requested. It never treats the private session bus as a production
system bus, starts iwd implicitly, edits `/etc`, or changes group/policy rights.

Before use, the bus must resolve `net.connman.iwd` to a root-owned unique
connection. All replies, signals and credential requests are associated with
that owner and an epoch; a replacement daemon cannot inherit stale actions or
prompts. Only the trusted Wayland Shell can start these APIs. Unknown/removed
object paths and stale snapshot revisions are rejected. Limits are 16 devices,
256 networks, bounded object/property/message sizes and 32 outstanding requests.
Connect/authentication have 120-second limits; ordinary operations and discovery
have shorter deadlines. Only one interactive mutation is outstanding at a time.

The UI provides radio power, scan, ordered SSIDs/RSSI, connect/disconnect, and
confirmed forgetting of discovered saved networks. It warns that iwd may save
credentials and enable autoconnection; there is no false "never save" checkbox.
PSK and pre-provisioned EAP agent prompts use native masked fields. EAP
certificate policy stays with iwd's administrator-provisioned profile, not a
Shell certificate-bypass dialog. Neither password snapshots nor payload logs
are produced. On daemon loss, credentials and stale models are discarded.

`system/iwd-main.conf` is an image template, not an installed host change:

```ini
[General]
EnableNetworkConfiguration=true

[Network]
NameResolvingService=resolvconf
```

An Alpine deployment needs iwd, its OpenRC integration, the system D-Bus daemon,
openresolv and the distribution's authorized access policy. Do not run the
desktop as root to work around permissions. `Daemon.GetInfo` is experimental
in iwd; an unavailable configuration-status query is represented as unknown,
and disabled configuration is visibly distinguished from Internet connectivity.

The test runner's `--iwd` mode points `DBUS_SYSTEM_BUS_ADDRESS` at its own
temporary test bus and starts an independent API fixture. This checks real
native UI/control flow without touching the host network. It does not certify
wireless hardware, real DHCP/DNS, static-IP provisioning, hidden networks,
enterprise certificate configuration, Ethernet or VPNs. Those remain explicit
follow-up/qualification work.

PollyShell stores `desktop.theme` in its app-scoped localStorage. Unknown stored
IDs produce a visible warning and a logged fallback without overwriting the
saved value. Failed display setup is not retried on every timer tick for the
same output configuration; the appearance menu offers an explicit retry.
Output removal retires only its Shell surfaces. Geometry changes recreate the
affected panel/Dock; unchanged surfaces are reused. Clock updates and menus
share the one UI runtime. Menu overlays close with their Close button or Escape;
click-outside dismissal is not implemented yet.

The session enables the in-house `.desktop` launcher with `--desktop`; no
GLib/GIO dependency is introduced. The root README documents its compatibility
scope, private bus inheritance, and intentionally unavailable D-Bus-only
desktop-entry/X11 paths.

Floating Dock corners use actual alpha composition. Blur, polished animation,
dark variants and shaped click-through regions are still outstanding. The Dock
exposes Apps, Appearance, About and real running-window buttons driven by
foreign-toplevel state. Taskbars and Docks list current-workspace windows on
every output, rather than filtering by a window's physical output. Click an active
window to minimize, or another/minimized window to activate and restore. Right
click opens maximize, fullscreen and graceful-close controls. Window-list
overflow scrolls horizontally with the wheel. Buttons are currently text-based,
without app grouping, icons or pinning.

The workspace menu manually adds/removes workspaces and switches every output
together. Four are created at compositor startup. Empty workspaces are never
automatically removed, fullscreen does not create a new Space, and themes do
not change workspace behavior. New workspaces append; moving a window does not
follow it. Window activation explicitly switches to its owning workspace.
Transient families stay together, including when a child appears on an inactive
parent's workspace.

Deleting a workspace moves its windows to the previous workspace, or the next
when deleting the first; the final workspace cannot be removed. These operations
do not close applications or discard their minimize/maximize/fullscreen state.
The compositor owns this session state independently of Shell restart.
Cross-login persistence, renaming/reordering UI and full session restoration are
not included in this milestone; compositor restart recreates the initial four.
The root README documents the native workspace API and ID lifetime.

Keep the parent's socket separate from the new compositor's socket:

```sh
parent="$WAYLAND_DISPLAY"
case "$parent" in /*) ;; *) parent="$XDG_RUNTIME_DIR/$parent" ;; esac
export XDG_RUNTIME_DIR="$(mktemp -d)"
printf 'Use this runtime directory for clients: %s\n' "$XDG_RUNTIME_DIR"
WAYLAND_DISPLAY="$parent" WLR_BACKENDS=wayland WLR_RENDERER=pixman \
    ./build/desktop/pollywm --socket pollywm-0
```

From a second terminal, use the printed directory:

```sh
XDG_RUNTIME_DIR=<printed-directory> WAYLAND_DISPLAY=pollywm-0 foot
```

Launch a second client the same way. Exit with Alt+Escape or SIGTERM, then remove
the now-empty temporary runtime directory. PollyWM requires an absolute,
user-owned, mode-0700 runtime directory. Do not reuse WSLg's world-accessible
runtime directory as PollyWM's runtime, and do not run a real desktop as root.

## Windows / WSL validation

The helper uses Podman **inside WSL** and the checked-in Alpine development
`Containerfile`. It does not install packages into the WSL distribution or need
privileged containers/device passthrough. It leaves a reusable development image
and build artifacts, but removes test containers and terminates their processes.
The development image includes Valgrind and wlroots debug symbols to diagnose
code inside the uninstrumented distribution libraries as well.

```powershell
# From the repository root; defaults to the Podman WSL distribution:
.\desktop\tools\test-wsl.ps1

# Also check a real WSLg output under Valgrind and launch two foot terminals:
.\desktop\tools\test-wsl.ps1 -Nested

# Clang AddressSanitizer + UndefinedBehaviorSanitizer, including nested checks:
.\desktop\tools\test-wsl.ps1 -Nested -Sanitize
```

Use `-Distro <name>` for another WSL distro with Podman installed. Nested checks
require the WSLg socket at `/mnt/wslg/runtime-dir/wayland-0` and briefly display
test windows. The default suite does not require a display or GPU. Sanitizers
instrument our code/fixtures, not the distribution's prebuilt wlroots library.

The integration suite runs independent Wayland client processes with shared
memory buffers, xdg configure/ack/commit and frame callbacks. It checks focus,
input, move/resize including geometry offsets and min/max sizes, shortcut
consumption, invalid/cross-client/stale grab serials, popup lifecycle, unmap/remap,
client crashes and destruction of a role before its surface. Synthetic input is
injected in the **test process**, not through a production protocol; nested
tests exclude physical input to avoid racing the fixture or the user's mouse.
The native window-Shell fixture injects real pointer events into taskbar, Dock
and context-menu surfaces and observes independent `foot` clients. It also
checks metadata, stale IDs, public-client rejection and a fresh Shell connection
enumerating an application that survived the previous Shell's exit.
Decoration coverage includes explicit/default negotiation, deferred mode and
theme commits, title/palette pixel changes, controls and drag cancellation,
floating drag/resize, fullscreen, fractional scale and destruction during a
pressed control. Public forced-bind attempts cannot change appearance.
Workspace coverage uses standard protocol transactions and real Shell clicks
on both taskbars and Docks. It checks atomic commit, hidden-window input and
popup isolation, transient families, stale map epochs, deletion migration,
the final-workspace guard, fullscreen preservation and Shell reconnect.
Public clients cannot bind either workspace global even with a known global ID.
Switcher coverage exercises modifier-held previews, release/click activation,
reverse cycling, cancellation, stale candidates, workspace isolation, recorded
and disabled bindings, conflicts, and settings restored into a fresh compositor.
Output coverage changes actual headless modes, rotation, scale and positions,
edits fields through native input, and exercises explicit keep/revert, watchdog
timeout, Shell crash, output removal, stale snapshots and final-output safety.
Data-device coverage uses independent clients for invalid/foreign serials,
source-less cancellation, drag-icon/subsurface hit testing, icon/source loss,
workspace switching, origin unmap and minimize. Native raster/GLES peers transfer
Unicode, empty text, MIME bytes and independent primary selection; fixture
data sources deliver real Wayland text and URI-list drops into the recipient
document. SDL adapter tests cover aggregation, cancellation and limit errors;
headless tests use an isolated clipboard and exercise input shortcuts.
Non-sanitized `-Nested` runs the fixture under Valgrind to cover library-level
buffer lifetime errors; `-Sanitize` uses ASan/UBSan instead, not simultaneously.
CLI tests cover invalid arguments, runtime permissions, socket collisions,
startup failures and shutdown/socket cleanup.

Window-policy coverage also includes repeated and pre-map state requests,
fullscreen over maximized windows, delayed/older/skipped buffer commits, restore
geometry, centered fullscreen pixel readback, popup/submenu constraints and
reposition tokens. The headless suite additionally creates/removes real wlroots
headless outputs and checks negative coordinates, gaps, 125% scale, rotation,
output disable/re-enable, small outputs and migration before a client maps.
These are protocol/geometry checks, not a claim of physical monitor validation.

The optional `runtime` container stage builds pinned Skia from source using
native Clang 18 and system font/codec libraries. `test-linux-runtime.ps1` builds
PollyUI and PollyWM together without replacing the Windows/macOS dependencies.
Its headless suite covers text/font fallback, rendering, JS/DOM, workers,
file-based fetch/storage and the five appearances, plus explicit startup failure
cases, keyboard/text/pointer/wheel contracts and detached DOM callback teardown.
The SDL adapter fixture exercises actual host translation with synthetic SDL
events, including modifier/repeat/code fields, text suppression, right-click
mapping and fractional two-axis scroll. `-Nested` checks a real SDL3 Wayland
client on WSLg and inside PollyWM; local HTTP/TLS fixtures also exercise headers,
redirect policy, request cancellation alongside busy workers/compute, and XDG
persistence/error handling. Add `-Sanitize` for ASan/UBSan in PollyUI,
QuickJS, Yoga and the compositor (not the prebuilt Skia/wlroots libraries).
All nested processes are bounded and cleaned up. Nested rendering checks run
raster, required GLES and automatic selection through resize/restore. PNG
readback verifies fills, gradients, opacity, rounded clipping and text. CI forces
Mesa llvmpipe; this validates GLES code, not physical GPU/DRM acceleration,
physical keyboards/keymaps or a bootable session. Separate native IME fixtures
exercise real Rime composition, inline preedit, candidate clicks, password
bypass, cancellation and service-loss recovery in both raster and GLES modes.

For Linux-native nested validation after building (install `foot` first):

```sh
# Resolve the parent socket before the fixture creates its own runtime:
parent="$WAYLAND_DISPLAY"
case "$parent" in /*) ;; *) parent="$XDG_RUNTIME_DIR/$parent" ;; esac
WAYLAND_DISPLAY="$parent" \
    ./build/desktop/tests/pollywm-integration \
    "$PWD/build/desktop/tests/pollywm-test-client" --nested
sh desktop/tests/nested.sh "$PWD/build/desktop/pollywm"
```

## Attribution

The wlroots tinywl example informed the Wayland lifecycle and scene integration.
Its MIT license notice is retained in `LICENSE.wlroots`. Project-owned PollyUI
and PollyDesktop code uses the root `LICENSE` (MIT); dependencies, fonts and
input-method data retain their separate licenses.
