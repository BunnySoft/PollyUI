# Shell-owned Wi-Fi/iwd service

`desktop/services/network.mjs` is the only Wi-Fi backend. The launcher installs
it on the existing `desktop` API and captures the real native `desktop.windows`
authorization binding. `startNetwork()` checks that binding every time; an
ordinary public Wayland application cannot register a Shell authentication
agent. The existing Shell panel and Settings managed-panel entry point continue
to use the same methods. No UI layout, root daemon, account/polkit policy or iwd
credential storage is introduced by this migration.

The service uses `openDbusEndpoint` from the [D-Bus SDK](../docs/DBUS-SDK.md).
RPC, signals and `/org/pollyui/NetworkAgent` share one unique connection.
`DBUS_SYSTEM_BUS_ADDRESS`, when present, must be nonempty, NUL-free and bounded
to 4095 UTF-8 bytes. Otherwise Linux uses
`unix:path=/run/dbus/system_bus_socket`. There is no session-bus, HOME or
arbitrary-peer fallback. Tests use an explicit isolated system-bus fixture,
never the host radio.

## Existing API

| Method | Contract |
|---|---|
| `startNetwork()` | Authorize the current Shell connection, install signal matches, discover and verify iwd, register its agent and load the model |
| `stopNetwork()` | Cancel/drop local requests and prompts, attempt a NoReply unregistration, then close the owned connection; no process-wide `dbus_shutdown` |
| `networkState()` | Return an independently copied UI snapshot |
| `refreshNetworks()` | Refresh the model; reject before trusted iwd readiness; coalesce refresh signals |
| `networkAction(revision, id, action)` | Require the current nonzero uint32 revision, a known target, an available operation and no concurrent mutation |
| `cancelNetworkConnection()` | Discard the local Connect result and request the station's actual Disconnect; not a claim that Connect side effects were rolled back |
| `replyNetworkAuthentication(token, user, password)` | Require the current live token; null/null cancels; invalid fields preserve the current prompt |
| `onNetworkChanged` | Optional function called on visible state changes; it is a JS event-loop callback, not a retained native callback |

Snapshots contain `ready`, `registered`, `refreshing`, `revision`, `error`,
`operation`, `target`, `networkConfiguration`, `devices`, `networks` and
`authentication`. Devices expose id/name/address/state/mode/powered/scanning/
station/connectedNetwork. Networks expose id/device/name/type/known/connected/
signal/order. Signal is signed RSSI divided by 100 (dBm), or null. A live prompt
contains only id/kind/network/username; **passwords never enter snapshots,
configuration files, logs or artifacts**.

Actions are `scan`, `disconnect`, `power-on`, `power-off`, `connect` and `forget`.
Connect supports open/PSK and already-known 802.1x networks on powered stations
with a registered agent. The UI retains explicit confirmation before forgetting;
the service only targets that model entry's KnownNetwork path. No Bluetooth,
VPN, new enterprise provisioning or IP-configuration editor is added.

## Trust, projection and lifetime

Discovery resolves `net.connman.iwd` through the bus daemon and requires
`GetConnectionUnixUser(uniqueOwner) == 0`. All later RPCs target that verified
unique name. Agent admission and iwd signals check sender headers before
payload decoding. Daemon NameOwnerChanged requires the actual daemon sender,
path and `sss` signature. Owner changes invalidate model/revision/epoch,
pending results and authentication tokens, then reverify a new owner without
replaying mutations.

GetManagedObjects requires `a{oa{sa{sv}}}`. The projection consumes only
Device/Station/Network and their documented fields; unknown interfaces and
properties are explicitly skipped at native iterators, not fabricated as
successful defaults. Used fields require their actual wire types, UTF-8 limits,
unique object/interface/property keys, iwd path prefixes and valid device/
connected-network relationships. Device/network/pending-operation limits remain
desktop policy (16/256/32), outside the generic SDK.

GetOrderedNetworks requires `a(on)` with signed int16 RSSI from -10000 to 0.
Daemon.GetInfo requires `a{sv}`; NetworkConfigurationEnabled must be boolean.
UnknownMethod/UnknownInterface means explicitly unsupported/null, not false.

The Agent implements Release, Cancel(s), RequestPassphrase(o),
RequestPrivateKeyPassphrase(o), RequestUserNameAndPassword(o) and
RequestUserPassword(os). A credential request must match the active Connect
target, caller and epoch, and cannot replace a pending prompt. PSKs require
8-63 UTF-8 bytes or 64 hexadecimal characters; other passwords require 1-1024
bytes and usernames at most 256 bytes (nonempty for username/password requests).
Cancellation/replies/closure release retained messages exactly once.

Deadlines use the OS monotonic clock: discovery/matches 3 seconds, model/order/
agent-registration/info 5 seconds, Connect/authentication 120 seconds, other
operations 15 seconds. Error reporting includes operation/error name or local
code, not arbitrary remote diagnostic bodies, credentials or SSIDs.

The production `desktop/native/network.c/.h` bridge and its native install,
pump, shutdown and build hooks are removed. Native session-bus/audio/power
users remain active. Source/private-fixture validation is **not** a new ISO or
physical-radio acceptance claim; the accepted Alpha.6 artifacts are unchanged.

## Isolated native validation

The root-coordinated `desktop-network-service` and `desktop-settings-network`
fixtures require UID/GID 1000 to resolve through the disposable container's NSS.
Starting this SDK container as UID1000 creates Podman's temporary user mapping;
the root coordinator can then run with `podman exec --user 0:0`, while the
fixtures drop application privileges back to UID1000. A root-created container
without that mapping needs an explicit private test account before the lane.
Do not add host accounts or change the shared SDK image to satisfy this test.
Missing NSS identity can make D-Bus authentication fail before any service
operation; it is not evidence that a root-owner check should be relaxed.

The integrated JS service, raster/GL network Shell flows and Settings network
flow passed with that prerequisite. The endpoint's glibc sanitizer/musl and
Valgrind evidence covers its real private-bus ownership/routing contracts.
Earlier C/JS fixture runs intermittently lost the control-panel window at
different steps; the cause was not established. Their diagnostics remain
preserved separately from the final probe-free successful runs.
