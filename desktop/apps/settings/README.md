# Settings 0.1 (development)

`polly-settings [appearance|about|displays|network|audio|keyboard]` asks the running
Shell to launch or present its single owned Settings process. The wrapper resolves
the installed runtime/data paths relative to its own binary directory. Settings
runs with `--app-id org.pollyui.settings`, without `--desktop`, in its own process,
QuickJS realm and GUI event loop. It uses its own application directories; it does
not read or migrate Shell localStorage, theme files or management connections.

Appearance selection, theme-file reload/restore and live About snapshots use the
fixed `org.pollyui.Settings1` scalar D-Bus contract. The version-1 JSON appearance
and About payloads have strict field, size, catalog and service-state validation.
Display, network, audio and keyboard pages explicitly open the existing Shell
control panel; these controls are **not** independent Settings implementations.
The Shell keeps the existing native apply/acknowledgement/persistence/rollback
state machines, and quick-theme menus remain available.

The original Windows-11-inspired presentation uses a persistent sidebar,
grouped surface cards and illustrated theme previews, rather than full-width
theme buttons. Theme previews are native primitive artwork, not screenshots
of hardware; the modern material is solid, not a claim of Mica or blur.
About keeps system/session information separate from expandable technical paths,
storage identities and Settings's own application version.

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
