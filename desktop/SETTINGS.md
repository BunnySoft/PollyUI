# System Settings

Open **Settings** using the taskbar button, Dock, the searchable **Settings**
entry in Applications, or the desktop background's context-menu gesture.
The six pages share one ordinary decorated, resizable window. Theme changes,
other application activity and launcher dismissal do not close it. **Close**,
Escape (unless consumed by an input), Alt+F4 and the window-frame close control
close only Settings. Use its normal taskbar/window-switcher entry to restore a
minimized Settings window; the current runtime has no owner-handle activation
API, so the launch buttons reuse rather than guess a foreign-toplevel ID.

## Available controls

| Page | User operation and authority |
| --- | --- |
| Appearance | Select a preset, reload user theme files or restore packaged themes. The existing Shell transaction updates wallpaper, panels and negotiated window frames; the current choice and file policy use the existing user preference keys. Selection keeps Settings open and shows application/save status or the original error. |
| Displays | Edit enabled outputs, resolution/refresh, scale, rotation and position using the existing display draft and native output manager. Apply opens the existing trusted-layer **Keep / Revert** confirmation. The compositor's 15-second watchdog remains authoritative; only Keep saves the exact-identity startup profile. Hotplug/serial changes discard the stale draft and visibly ask the user to review the replacement. |
| Network | The existing iwd controller shows actual adapters, radio/connection state, RSSI and IP-configuration status. Scan, radio power, connect, masked password/username prompts, disconnect and explicitly confirmed forgetting use the existing revision-bound native requests. An unprovisioned enterprise network remains disabled. The page does not add Bluetooth, VPN or an IP-address backend. |
| Audio | The existing private PipeWire policy provides endpoint volume, mute and default playback/recording devices. Requests show acknowledgment progress; existing name/class preferences are saved only after the actual service echoes them. Device loss, missing service, unavailable volume/mute and storage errors remain visible. No host audio daemon or WirePlumber is substituted. |
| Keyboard | Change, disable or reset the existing fixed shortcut catalog. Recording opens the existing trusted Shell layer: shortcut suppression is layer-focus-bound, not granted to the ordinary Settings window. Escape first cancels recording; closing/changing the owning Settings page releases capture. |
| About | Displays current appearance, display count and actual session-service status. The runtime does not expose a release version, so the page says so instead of inventing one. Login/lock behavior is deployment-policy-dependent; account/password/administrator actions are explicitly unavailable here. |

Missing native APIs are visibly unavailable, not fake ready services. Existing
native APIs can still report an unavailable service, denied operation or missing
device; their real state/error remains on the corresponding page. Power keeps
its existing, separately confirmed authorization-aware panel, reachable from
Appearance, without changing suspend/lock policy.

User theme/shortcut/display/audio preferences keep their existing persistence
contracts and keys. iwd, not Settings, owns saved network credentials and
connection policy. A memory-only Live session does not gain reboot persistence
from this window.

## Ownership and lifetime

`shell.showSystemSettings(outputId, page?)` opens/reuses the new window; page IDs
are `appearance`, `displays`, `network`, `audio`, `keyboard`, `about`. The Shell
Applications entry is an internal action (`org.pollyui.shell.Settings`), not an
external `.desktop` launcher with privileged APIs. The ordinary toplevel remains
on the existing trusted Shell process/connection. No public appearance, output,
audio-policy or Wi-Fi-agent privilege is added. Placement belongs to PollyWM;
ordinary `window.create` does not accept layer-only `output`/keyboard options.

The legacy `showSettings` appearance/about overlay, `showDisplays`,
`showShortcuts`, `showNetwork` and `showAudio` APIs remain compatible with
existing menu/native fixtures. New user-visible entry points use
`showSystemSettings`.

Navigation detaches the previous service page before mounting the next one.
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
Same-page repaints/retheming preserve mounted credential/display inputs. Native
display confirmation owns its own token/lifetime and survives Settings close;
it cannot be silently kept or reverted by a stale Settings callback.

## Bounded checks and native acceptance

The existing `desktop/tests/menu-host.mjs` now also exercises the actual
Settings view/reconciler: entry points, page content, pointer/keyboard handlers,
theme changes, native request shapes, provisional display confirmation,
acknowledged audio persistence, masked Wi-Fi prompts, actual current-node
replacement, late service callbacks, unavailable controls and close/restart
cleanup. Its DOM/backend are synthetic and certify no native rendering.

```powershell
node --test .\desktop\tests\menu-host.mjs .\desktop\tests\xp-startup-compatibility.mjs
node .\desktop\tests\xp-luna-unit.mjs
```

`settings-shell.mjs` is the native acceptance fixture, not a product entry point.
It opens Settings through a real taskbar click, navigates current DOM controls,
changes a real native appearance, captures native window buffers, and exercises
WM close, Close-button reopen and an independent public application's live PID.
Audio uses actual private PipeWire virtual endpoints; network uses the existing
root-owned synthetic iwd D-Bus service and real native requests/credential input,
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

The same private test driver also consumes two fixed public fixture targets:
`org.pollyui.file-dialog-window` / `PollyUI.FileText` with
`FileDialogFixture.<seq>.`, and `org.pollyui.files-window-fixture` / `Files`
with `FilesFixture.<seq>.`. Their ordinary markers must share the target's
public client, UID1000 and owner PID. The only actions are `click x y`,
`wheel x y deltaY`, `key enter|escape|tab|shift-tab` and `close`; coordinates
must fit the current client geometry, wheel magnitude is at most 10000 and
sequences are positive, monotonic unsigned integers. The driver hides its
marker and uses each fixture's declared no-action focus point, then looks up
the target again before one business action. It never retains a view across
an event-loop settle. Receivers await the marker's actual `onclose` callback
and inspect their current DOM/focus/files; capturing their real window buffer
is a separate JS action. Paired ordinary-key delivery is a new fixture path
requiring native acceptance, not evidence inherited from old layer-key tests.
These bindings exist only in the test executable, not the product compositor.
