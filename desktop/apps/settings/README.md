# Settings 0.1 (development)

`polly-settings [appearance|about|displays|network|audio|keyboard]` asks the running
Shell to launch or present its single owned Settings process. The wrapper resolves
the installed runtime/data paths relative to its own binary directory. Settings
runs with `--app-id org.pollyui.settings`, without `--desktop`, in its own process,
QuickJS realm and GUI event loop. It uses its own application directories; it does
not read or migrate Shell localStorage, theme files or management connections.

All six pages and their controllers/rendering live inside this one Settings
window/document/realm. They use fixed `org.pollyui.Settings1` scalar RPCs and strict
version-1 business JSON, not Shell-private JS objects or management connections.
Business page source lives in `desktop/apps/settings/ui` and `logic`.
Genuinely shared themes, presentation, button, typography and wallpaper helpers
live in `desktop/shared/ui`; old Shell exports are source-compatibility aliases.
Settings production modules have no business-rendering imports from
`desktop/shell`. The Shell retains service policy, launch ownership and the two
small trusted safety surfaces below; there is no full Shell settings window.

| Page | Fixed methods / identity binding | Owner and detach behavior |
| --- | --- | --- |
| Appearance / About | Existing theme/catalog revisions, build and strict service snapshots | Existing Shell theme transaction and JSON writer; Settings owns the page |
| Displays | `GetDisplays`, `ApplyDisplays(s)` complete serial + head ID/name/make/model/serial identity and bounded geometry, `ForgetDisplayProfile(u serial)` | Native output manager/compositor watchdog remains authoritative. Hotplug discards stale draft. Only the small trusted token-bound Keep/Revert layer confirms; Keep saves, navigation/close never silently confirms or restarts its 15-second deadline |
| Network | Existing revision/operation ID/authentication token methods | Single Shell-owned iwd agent; detach cancels only its own pending connection, not an established one |
| Audio | `GetAudio`, explicit `RefreshAudio`, `AudioAction(s)` fixed volume/mute/default + generation/node ID/revision/instance, `ForgetAudio(s {generation,revision})` | One `audio-policy.mjs` owner subscribes, restores and saves only echoed acknowledgments. Page close does not stop routing or pending persistence; device/service loss and unknown controls stay explicit |
| Keyboard | `GetKeyboard`, `KeyboardAction(s)` fixed catalog revision/action + record/disable/reset, `CancelShortcutRecording(u token)`, `DetachPage(s page)` | Fixed catalog/config transaction stays with Shell. Record creates only the token/owner-bound trusted prompt, activates capture only on actual focus, and releases on focus loss/lock, Escape, timeout, page detach or actual owned exit |

Displays offers per-monitor **100%**, **150%** and **200%** scale shortcuts
(factors 1, 1.5 and 2). The Custom field still accepts factors from 0.25 to 4,
and `+` still increments by 0.25. Shortcuts reflect the current draft field:
a custom 1.25 does not select 100%, and typing or incrementing updates selection.
The three presets are a named, per-display themed radio group: Space or
arrow/Home/End navigation selects a draft value, while Enter does not select a
radio. Busy pages disable the actual radio/checkbox factories. Preset IDs stay
the same; radio truth is `aria-checked`, not a toggle button's `aria-pressed`.
Composing keys are left to the input method without selecting a preset.
The Settings window also leaves composing Escape untouched rather than closing.
These are output scales for desktop, decorations and application buffers, not
an app-only font zoom. Choosing a scale only edits that monitor's draft; Apply
uses the existing native transaction and trusted 15-second Keep/Revert prompt.
Only Keep saves the confirmed layout; hotplug discards the stale draft.
Display headings, ordinary labels, status messages and page spacing follow the
existing theme tokens. Display headers and action rows wrap in narrow content
areas without resizing the retained numeric fields or changing their draft values.
Displays' head list, Keyboard's binding list and Audio's existing content pane
use the shared bounded viewport with its themed overlay scrollbar and focus
reveal. Dragging, track paging and keyboard scrolling do not invoke service
commands; Displays' Apply/header and Keyboard's reset/footer remain outside
their scrolling lists. These embedded panes add no second window frame.
The page-navigation sidebar uses the same bounded themed scrollbar and focus
reveal, so all six page commands remain reachable in low windows. Its header
scrolls with the commands; ordinary repaints retain an intentional wheel position.

Every mutation rechecks the daemon-supplied UID/PID and current owned generation
after asynchronous authorization. Page detach invalidates pending domain writes;
monotonic execution-order guards prevent an older authorization result or detach
from affecting a newer action. Recording tokens are never adopted across owners.
No-reply requests do nothing, and writes are never automatically retried/replayed.
The recording layer uses existing `window.active/onactivate/ondeactivate` and
native focus-bound shortcut suppression, not a new hook or C management bridge.
Audio remains the existing private PipeWire policy, not WirePlumber or a host core.

Network mounts the existing network controller/view in the Settings document,
using `network-client.mjs`, not a second system-bus connection or iwd agent.
`GetNetwork` returns a strict version-1 business snapshot; `NetworkAction(s)`
accepts only `{revision,target,action}` with the six existing Wi-Fi actions.
`RefreshNetwork`, `CancelNetworkConnection` and `DetachNetwork` take no arguments;
`ReplyNetworkAuthentication(s)` accepts only `{token,user,password}`. JSON is a
bounded business payload, never a command, path to execute or claimed identity.
The same daemon PID/UID and current owned-generation checks guard every method.
Detaching invalidates in-flight page mutations at their final dispatch gate.
The Shell retains the service's `operationId` for a Settings-started connection:
only that still-current pending Connect may be answered/cancelled, including on
actual Settings process exit. Another Shell-panel connection is never adopted.
Closing/reopening reads the actual radio/connection state from iwd, not AppData.
Already-established connections survive page close. iwd retains credential and
installed/Live persistence authority; no reboot-persistence guarantee is added.
Failures and uncertain delivery remain visible, writes are never replayed, and
credential fields are wiped on prompt change, service failure, navigation or close.
Credential/confirmation content and network entries consume the shared passive
card surface. Embedded Settings content does not add a second window frame;
only the existing independently owned network layer uses the shared dialog
frame. Native credential inputs retain their objects and wrappers across
retheme and live status changes, with `100%` available width capped at the
previous 420px size. A new authentication ID/kind still clears credentials and
resets the content mode. The shared `panel-viewport.mjs` keeps the outer surface
fixed while only an inner bounded viewport uses `scrollDesktop`. Current
keyboard/programmatic focus is revealed after at most two coalesced layout
frames; pending work/listeners are released on leave. Cancellation therefore
stays reachable without moving the outer frame. No iwd/RPC,
revision, prompt-token, credential or connection policy changes are implied.

The original Windows-11-inspired presentation uses a persistent sidebar,
grouped surface cards and illustrated theme previews, rather than full-width
theme buttons. Theme previews are native primitive artwork, not screenshots
of hardware. Packaged Settings explicitly enables the wallpaper-derived opaque
client material described below; it is not Windows DWM Mica or live Acrylic.
About keeps system/session information separate from expandable technical paths,
storage identities and Settings's own application version.

## Opaque wallpaper-derived client base

The managed production runtime calls `createSettingsApp({optInMaterial:true})`.
The direct app API still defaults to `false` and its original solid path.
Schema-1 themes may explicitly select `window.clientMaterial:"solid"|"wallpaper"`;
missing means solid. Only the built-in/recovery Modern preset selects wallpaper.
An explicit solid override disables it, including for a bitmap theme. No theme-ID
or color heuristic, new preference service, extra window/frame, whole-window
alpha or native caption change is involved.

Ready material is one `aria-hidden`, pointer-inert Canvas at the bottom of the
existing Settings document. Only the root's body-color fill becomes transparent
to that **opaque** sibling; cards, sidebar, right-content mount, text, inputs,
selection/caret and actions retain their existing DOM and paint policy.
Loading, solid and error states use the original solid root fill. The existing
`createWallpaperMaterial` owns decoding, Gaussian blur, padding/pixel budgets,
source/tint caches and disposal. `window.observeState` updates logical size,
scale and activation; activation reuses the blurred image. Existing unchanged
appearance refreshes do not read/encode/decode/blur/composite again. There is no
new polling timer, frame loop, background sampling or implicit retry.

Procedural wallpaper uses the existing validated desktop gradient/layers.
Bitmap paths in theme JSON are **not** filesystem permissions for Settings.
For bitmap themes only, the fixed, argument-free `GetMaterialSource() -> s`
uses the existing current Shell-owned Settings PID/UID/generation authorization
and rejects no-reply requests. Shell projects its already-held, committed asset
through a small offscreen Canvas in a live wallpaper document, preserving alpha,
and caches the PNG until the theme/owned asset changes. It neither reads the
filesystem again nor captures the desktop, a window or other applications.
The trusted `getThemeAssetBitmap(key)` seam uses the same native authority as
theme asset load/release; the actual Bitmap/close capability never crosses RPC.

The strict DTO is `{version:1,revision,generation,themeId,width,height,dataURL}`:
1..128 pixels per axis, at most 128 KiB for a canonical PNG data URL, bounded
exact fields and matching PNG header dimensions. Native decoding still validates
the complete PNG. GetAppearance/GetAbout shapes and all mutation permissions
remain unchanged. After the existing authenticated Connect handshake, the client
pins this read to the verified unique Shell bus owner and owned generation.
Replies must also match the displayed theme and appearance revision; superseded
replies/decodes cannot publish, including after solid switch, owner loss or stop.
Failed material has its own visible status and report, never overwrites a
service/page error and is not retried by clock/resize/focus activity. Its stable,
themed status row lives in normal layout immediately before the permanent build
footer, not over the window bottom. Long error text scrolls within a bounded row;
showing/hiding it preserves the version/footer DOM and visibility. A new
appearance or explicit solid selection is needed to recover. Stop unsubscribes
and disposes all material backing/source ownership.

This is a client-local wallpaper-derived Mica-like **opaque** base, not
desktop-coordinate alignment, DWM Mica, MT01 transparent window presentation,
live cross-application Acrylic or MT03 compositor blur. Node contracts reuse
the existing Settings/material suites; the existing material-render and
settings-card-render GUI entries check real bitmap projection, opaque pixels,
actual composed underlay, unchanged foreground/input and idle work counters.
Software-raster/test-scale-1 checks do not qualify Linux's live bus/compositor,
physical DPI, GPU, original-OS reference pixels or the entire E22.24 task.

The Settings frame, About and Keyboard text/spacing consume the existing theme
typography and layout tokens; Audio action rows wrap within the available width.
This is client presentation, not certification of original operating-system fonts.
The Keyboard shortcut list reuses the shared frameless focus viewport: Tab to
Change/Off reveals the focused command in short windows, while ordinary repaint
preserves intentional wheel scrolling. Recording still uses the same trusted
focus-bound capture path.

Every page, including loading, unavailable and failed states, retains the
system release and short build revision/source marker in its footer. Both strict
snapshots include `build:{version,revision,sourceDirty}` generated from the
trusted Shell's `application.runtimeVersion/runtimeRevision/runtimeSourceDirty`.
Unknown revisions and source state remain explicit. About shows the full revision.
Settings uses its own compiled metadata before the first snapshot, and explicitly
labels any mismatch between its runtime and the Shell; this is information,
never an authorization credential or a caller-provided release claim.

Both endpoints require the qualified owned private session bus:
`POLLY_SESSION_BUS_ADDRESS == DBUS_SESSION_BUS_ADDRESS`, one `unix:path` address
for the same-UID socket at `$XDG_RUNTIME_DIR/bus`, with a same-UID mode-0700 runtime
directory. There is no ambient/system-bus fallback. Startup failure is visible.
The Shell records its spawned PID and generation; daemon-supplied PID/UID checks
admit only that process to snapshots and changes, and bind its presentation service
to a unique owner of the same PID. The unprivileged `Open(page)` method can only
launch/present this fixed application, never caller-supplied commands or paths.
No-reply requests perform no effects. `--managed`, app IDs, unique/well-known names,
client-provided PIDs and same UID alone are not management authorization.

This is an owned-process capability boundary, **not a security sandbox against
an attacker already controlling the same UID or ptrace**. Root/system services,
passwords, accounts and a general RPC/authentication framework are out of scope.
Timeout, cancellation, disconnect and accepted-send do not prove rollback or
delivery; writes are never automatically retried, reconnected or replayed.
Closing Settings closes only its SDK endpoints/application. SDK module references
remain until exit; neither Shell nor Settings calls process-wide `dbus_shutdown`,
which would require exclusive ownership of every libdbus user.

The targeted Node suite includes actual reconciler mounting, masked prompt/focus
retention and independent navigation in a host DOM fixture. The registered
`desktop-settings-network-api` fixture uses real SysRT/libdbus scalar calls and
the existing root-owned synthetic iwd on private buses, as UID1000, without GUI,
host radios or user credentials. Its endpoints share a fixture process; it does
not prove native two-process rendering/input. The existing native wrapper's
bounded `--mode migration` flow separately runs real independent Settings and
Shell PIDs with two private headless outputs and private PipeWire fixtures:
native Apply/Keep, volume/mute/default, focus-bound actual-key recording/reset,
close/new-PID reopen and eight app-buffer captures. Its software-native result
does not qualify physical hardware, theme pixel matching, persistent reboot or
an ISO. Existing network/full UI modes keep their separate evidence boundaries.

Appearance status/error surfaces and Keyboard shortcut cards consume the shared
passive `desktop/shared/ui/panel-appearance.mjs` card policy. Theme tokens select
their shape, spacing and surface; Classic reuses the existing inset bevel without
a second generic border. Status text uses the selection foreground when supplied.
Decorations are non-interactive and add no focus stops, recording lifecycle,
subscription or RPC behavior. Other page/control migrations remain independently
owned; this contract is not a claim of original-OS pixel certification.
Appearance gallery headings, labels, status and spacing follow the same existing
theme typography/layout tokens; preview illustrations and selection behavior
retain their original geometry and lifecycle.
