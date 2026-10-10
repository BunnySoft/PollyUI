# System Settings

Open **Settings** using the taskbar button, Dock, the searchable **Settings**
entry in Applications, or the desktop background's context-menu gesture.
The six navigation entries share an ordinary decorated, resizable **independent
Settings application**. Appearance and About live in its own process/QuickJS
realm/event loop. Displays, Network, Audio and Keyboard explicitly offer
**Open in desktop control panel** and retain their actual controls in a separate
Shell-owned panel. Theme changes,
other application activity and launcher dismissal do not close it. **Close**,
Escape (unless consumed by an input), Alt+F4 and the window-frame close control
close only Settings. Use its normal taskbar/window-switcher entry to restore a
minimized Settings window. Launch buttons and `polly-settings` request the same
owned instance's navigation/presentation; Shell activates its current window.

## Available controls

| Page | User operation and authority |
| --- | --- |
| Appearance | Select a preset, reload user theme files or restore packaged themes. The existing Shell transaction updates wallpaper, panels and negotiated window frames; the current choice and file policy use the existing user preference keys. Selection keeps Settings open and shows application/save status or the original error. |
| Displays | Edit enabled outputs, resolution/refresh, scale, rotation and position using the existing display draft and native output manager. Apply opens the existing trusted-layer **Keep / Revert** confirmation. The compositor's 15-second watchdog remains authoritative; only Keep saves the exact-identity startup profile. Hotplug/serial changes discard the stale draft and visibly ask the user to review the replacement. |
| Network | The existing iwd controller shows actual adapters, radio/connection state, RSSI and IP-configuration status. Scan, radio power, connect, masked password/username prompts, disconnect and explicitly confirmed forgetting use the existing revision-bound native requests. An unprovisioned enterprise network remains disabled. The page does not add Bluetooth, VPN or an IP-address backend. |
| Audio | The existing private PipeWire policy provides endpoint volume, mute and default playback/recording devices. Requests show acknowledgment progress; existing name/class preferences are saved only after the actual service echoes them. Device loss, missing service, unavailable volume/mute and storage errors remain visible. No host audio daemon or WirePlumber is substituted. |
| Keyboard | Change, disable or reset the existing fixed shortcut catalog in the Shell control panel. Recording opens the existing trusted Shell layer: shortcut suppression is layer-focus-bound, not granted to the independent Settings window. Escape first cancels recording; closing/changing the owning control panel page releases capture. |
| About | Displays Settings's own development version/identity/directories, current appearance, display count, actual session-service status and existing profile information from a strict Shell snapshot. The runtime does not expose a release version, so the page says so instead of inventing one. Login/lock behavior is deployment-policy-dependent; account/password/administrator actions are explicitly unavailable here. |

Missing native APIs are visibly unavailable, not fake ready services. Existing
native APIs can still report an unavailable service, denied operation or missing
device; their real state/error remains on the corresponding page. Power keeps
its existing, separately confirmed authorization-aware panel, reachable from
the Shell control panel header and existing quick-appearance menu, without
changing suspend/lock policy. The header retains **Quick appearance** as well.

User theme/shortcut/display/audio preferences keep their existing persistence
contracts and keys. iwd, not Settings, owns saved network credentials and
connection policy. A memory-only Live session does not gain reboot persistence
from this window.

## Ownership and lifetime

`shell.showSystemSettings(outputId, page?)` asynchronously launches/presents the
owned app and returns its acknowledged PID (or a visibly reported failure); page IDs
are `appearance`, `displays`, `network`, `audio`, `keyboard`, `about`. The Shell
Applications action uses `org.pollyui.settings`; `polly-settings.desktop` and
its relocatable wrapper are real public launch entries. Settings runs without
`--desktop`, with its own application storage namespace, not Shell storage,
objects, native management connections or private Wayland descriptors.
No public appearance, output, audio-policy or Wi-Fi-agent privilege is added. Placement belongs to PollyWM;
ordinary `window.create` does not accept layer-only `output`/keyboard options.

The legacy `showSettings` quick-appearance overlay, `showDisplays`,
`showShortcuts`, `showNetwork` and `showAudio` APIs remain compatible with
existing menu/native fixtures. `showSettings(..., true)` delegates About to the
independent app. `showManagedSettings` mounts only the four retained Shell pages;
their Appearance/About navigation returns to the independent app.

The fixed `org.pollyui.Settings1` D-Bus service uses empty/scalar calls and
version-1 business JSON snapshots validated before rendering. Both endpoints
require the qualified owned private session bus, never an ambient/system-bus
fallback. Daemon-supplied PID/UID credentials bind snapshots/mutations to Shell's
spawned PID and current generation, and bind presentation to a unique owner of
that same PID. Limited unprivileged `Open(page)` accepts no commands, paths or
claimed identity. No-reply calls perform no effects. Timeout/cancel/disconnect
do not prove rollback; writes never reconnect, retry or replay automatically.
This is not a sandbox against an attacker already controlling the same UID or
ptrace. See `apps/settings/README.md` for the exact first-version boundaries.

Navigation **within the Shell control panel** detaches the previous service page
before mounting the next one. Independent Settings navigation/close does not
silently close a separately open control panel.
Network detach wipes credential fields, cancels a present authentication prompt
or still-pending connection, and retires its confirmations; it does not
disconnect an established connection. Audio page detach releases only its
document; routing, queued acknowledgments and persistence continue as Shell
policy. Subscriptions are shared by the existing controllers, chain earlier
callbacks and restore them when Shell stops. Closing Settings does not stop
those policies or other applications.

Every Settings callback is scoped to its live window, current page and rendered
revision. Embedded service buttons also bind their attachment and actual state
snapshot. Page transitions explicitly remount only this Settings document's
content because the existing reconciler is positional and ignores `key`.
Same-page repaints/retheming preserve mounted credential/display inputs. Network
content additionally remounts only on list/confirmation/authentication-token
transitions: an asynchronously arriving credential prompt cannot reuse a long
network-list card and silently skip the input's create-time mount. The same
authentication token and kind retain the field, entered value, selection and
focus. A changed kind rebuilds the corresponding username/password model and
wipes the old field even if a test reuses the token. Native display confirmation
owns its own token/lifetime and survives Settings close;
it cannot be silently kept or reverted by a stale Settings callback.

## Bounded checks and native acceptance

`desktop/tests/menu-host.mjs` exercises the injected narrow launch contract and
actual retained control-panel view/reconciler: entry points, page content, pointer/keyboard handlers,
theme changes, native request shapes, provisional display confirmation,
acknowledged audio persistence, masked Wi-Fi prompts, actual current-node
replacement, late service callbacks, unavailable controls and close/restart
cleanup. `apps/settings/tests/settings.mjs` separately checks the independent
controller, strict snapshots, credential checks, stale generations, no-reply
suppression and no mutation replay. These backends are synthetic and certify
no native rendering.

```powershell
node --test .\desktop\tests\menu-host.mjs .\desktop\apps\settings\tests\settings.mjs
node .\desktop\tests\xp-luna-unit.mjs
```

`settings-shell.mjs` is the native acceptance fixture, not a product entry point.
It opens the independent Settings test probe through a real taskbar click, navigates current DOM controls,
changes a real native appearance, captures native window buffers, and exercises
WM close, new-PID/generation reopen, single-instance presentation, failure/rollback,
daemon disconnect, unauthorized/fake identity rejection and an independent
public application's live PID. The probe runs the production bootstrap/controller;
test queries live only in `settings-probe.mjs`, never production Settings.
Audio uses actual private PipeWire virtual endpoints; network opts into the
existing root-owned synthetic iwd service's 13-network, delayed-prompt mode and
uses real native requests/credential input,
never a user AP. The test-only `runtime-client.c` driver checks fresh mapped
owned surfaces and delivers actual compositor pointer/paired keyboard events;
it is not a management protocol in PollyWM.

Only the coordinator's single native lane should build/run this fixture. The
wrapper records logs and captures without claiming that fixture preparation or
host DOM checks constitute native acceptance:

```sh
python3 desktop/tests/settings-native.py \
  /absolute/build/pollyui-layer-client-test /absolute/build/pollyui \
  --mode all --evidence /private/evidence
```

Run in an isolated Linux container with the pinned SDK, read-only source, no
network and private writable evidence. Network mode needs a root **fixture
coordinator only** to start the fake iwd service; PollyWM, PollyUI, PipeWire and
the public survivor run as UID/GID 1000. `--mode ui` or `--mode audio` can run
directly as UID1000. The wrapper creates its own buses, HOME/XDG trees and core,
checks expected PASS markers as well as failures, and retains evidence. It
does not read host preferences, connect the host system bus, install packages,
change display hardware or operate real Wi-Fi/audio devices. Physical radios,
GPU/audio hardware, installed reboot persistence and authenticated-session
qualification are separate acceptance work.

CTest registers four separate wrapper invocations: `desktop-settings-ui` and
`desktop-settings-audio` use `--mode ui`/`audio` and the `ordinary-native` label;
run them explicitly as UID1000. `desktop-settings-network` uses `--mode network`
and the `root-container;fixture-coordinator;synthetic-network` labels. Its root
coordinator owns only the private synthetic iwd/system-bus fixture; the wrapper
drops PollyWM, PollyUI and the public survivor to UID1000. The audio mode starts
its private PipeWire core as that same ordinary user. These registrations do
not grant Settings new service authority or qualify an authenticated login.
`desktop-settings-installed` stages a real relocated installation with spaces
in its path, runs the production Shell/app without a probe, and verifies
`polly-settings` launch/presentation/reopen from `/tmp` and `/`.
UI mode also checks actual startup-error documents for missing-owned,
mismatched and wrong-socket private bus settings. `--renderer gl` selects
software GLES; the default is raster.

Each test receives absolute driver/PollyUI target paths, runs from the source
root, writes only under its own build evidence directory and has a 330-second
CTest bound, a 300-second subprocess limit, a 240-second driver deadline and
15-second per-stage state/input deadlines. Only the multi-network fixture's
service lifetime grows to 240 seconds for this dual-process software-rendered
flow; other iwd modes keep their old bound. Packaging installs the independent
app, fixed wrapper/desktop entry and shared environment helper. Windows/GUI-only
dependency boundaries remain unchanged.
Registration, syntax checks and earlier-layer input evidence do not establish
new ordinary-window input or Settings native acceptance. Build/run only the
fixed combined feature snapshot in the coordinator's single native lane.

The same private test driver also consumes two fixed public fixture targets:
`org.pollyui.file-dialog-window` / `PollyUI.FileText` with
`FileDialogFixture.<seq>.`, and `org.pollyui.files-window-fixture` / `Files`
with `FilesFixture.<seq>.`. Their ordinary markers must share the target's
public client, UID1000 and owner PID. The only actions are `click x y`,
`wheel x y deltaY`, `key enter|escape|tab|shift-tab` and `close`; coordinates
must fit the current client geometry, wheel magnitude is at most 10000 and
sequences are positive, monotonic unsigned integers. Files additionally accepts
the paired native `key backspace` for its focused inline rename field; the
chooser's key whitelist is unchanged. The driver hides its
marker and uses each fixture's declared no-action focus point, then looks up
the target again before one business action. It never retains a view across
an event-loop settle. Receivers await the marker's actual `onclose` callback
and inspect their current DOM/focus/files; capturing their real window buffer
is a separate JS action. Paired ordinary-key delivery is a new fixture path
requiring native acceptance, not evidence inherited from old layer-key tests.
These bindings exist only in the test executable, not the product compositor.

The Settings close handshake separates window/process lifetime from coordinate
readiness. Its independent idle observer must keep the same native UID1000/PID,
remain mapped, non-minimized and visible, and retain a real surface buffer.
Waiting for a newer configure does not by itself mean that this application
exited. Configure serials, current/wanted/presented geometry and buffer size stay
visible in changed-state diagnostics; the test does not clear pending geometry
or claim a new configure was presented. A closed Settings window must be truly
absent even if a remaining Settings view is pending; an open Settings window and
every actual pointer target still require settled geometry. The native driver's
`--settings-lifetime-policy` option checks these predicate boundaries without
starting a compositor. Normal application resize/titlebar interaction remains
a separate native assertion if pending geometry is observed.
