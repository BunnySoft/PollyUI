# SysRT capability gaps and service migration

The architecture substrate is implemented; the desktop is not fully migrated.
Alpha.6 proves the current end-to-end path, not support for every native API.
This inventory describes missing behavior, its concrete consumer and its place
in the next work. It is not a requirement to finish all mechanisms first.

## Delivery routes

| Route | Code changed | Result | Does it replace a domain C bridge? |
|---|---|---|---|
| Mechanism-first | `sysrt/ffi` and generic SDKs | More native call shapes become possible, potentially without a new desktop feature | Not by itself |
| UI separation first | Settings, narrow IPC and Shell presentation | More pages run in a separate application while existing native backends remain | No |
| Service migration | Required protocol SDK features, JS domain logic, callers and tests | One existing system capability works through the new path and its replaced bridge is deleted | Yes |

The selected route is **service migration**. Wi-Fi/iwd and the subsequent
independent six-page Settings UI are now delivered. Add mechanisms only for
concrete calls in the next selected service. These remain separate outcomes:
moving a page out of Shell does not itself rewrite its native backend.

## Generic FFI gaps

| Missing behavior | Current supported boundary | Concrete consumer / priority |
|---|---|---|
| Retained callback registration | Callback closures exist only during a synchronous call; native code cannot keep the address afterward | PipeWire/Wayland listeners; deferred until that service is selected |
| Foreign-thread callback delivery | An external thread cannot enter QuickJS; the outer synchronous call reports rejection | Native event libraries; requires owning-loop delivery and teardown before use |
| Pointer/record/string callback arguments | Current callbacks accept scalar parameters and scalar/void results | Event metadata and borrowed native records; needs explicit copy/borrow lifetime contracts |
| Additional async pointer shapes/results | Async accepts scalars, copied strings and exclusive flat managed-buffer loans; not arbitrary pointer vectors or unknown pointer results | Extend only for a measured blocking operation and defined ownership |
| Borrowed external memory views | Opaque pointers are not readable by guessing an extent; adoption requires known length and a matching native releaser | Native records/buffers returned under a real API contract |
| Fallible OS-handle ownership helpers | Descriptors/handles remain caller-owned; `void(pointer)` adoption is not an OS-handle close system | Files/process/socket lifecycle; do not treat handles as heap allocations |
| Other generated ABI targets | Generated file metadata covers Linux x86_64/LP64; it is not a general header parser or a Windows/other-architecture profile | Add a target when that platform is actually built and exercised |

Do not make arbitrary numeric addresses readable or claim interruptible native
calls as a shortcut. Shutdown still waits for accepted work; cancellation does
not undo OS side effects. Native ABI metadata remains trusted code, not a sandbox.

## D-Bus SDK capabilities required by iwd

These are protocol/connection features, not changes to libffi itself. The
consumer-required transport slice is now integrated: `openDbusEndpoint` supports
the shapes below on a single-reader connection. Existing scalar client/service
adapters remain unchanged, accepting empty or one `u/b/s/o` request and fixed
scalar replies. The JS iwd replacement uses the additional endpoint; it does
not turn those adapters into a general introspection/parser/FD API.

| Required feature | Actual iwd call/message |
|---|---|
| Multi-argument requests and replies | `Properties.Set(ssv)`, Agent `RequestUserPassword(os)` and username/password reply `ss` |
| Signed 16-bit scalar and array of structs | `Station.GetOrderedNetworks` returns `a(on)`; RSSI is an `n`, not uint32 |
| Arrays, dictionary entries and variants | ObjectManager `GetManagedObjects`: `a{oa{sa{sv}}}`; Daemon `GetInfo`: `a{sv}`; power uses a boolean variant |
| Signal matching and delivery | Daemon `NameOwnerChanged(sss)`, ObjectManager `InterfacesAdded/Removed`, Properties `PropertiesChanged` |
| Calls and agent methods on one connection | The unique owner registered by `RegisterAgent(o)` must receive later agent requests while outgoing calls progress |
| Export an agent path without claiming a service name | iwd calls `/org/pollyui/NetworkAgent` on the registered connection's unique name |
| Copied sender and reply provenance | Check the daemon/root-owned iwd unique owner and invalidate operations on owner changes; a match rule alone is not authorization |

Use explicit message ownership and zero-wait event-loop I/O. Reply, signal and
method routing must not consume one another's messages. Do not emulate native
filters with unsupported retained FFI callbacks or share a connection with two
independent readers. Generic transport stays free of iwd's device/queue/UI limits.
Credential payloads and arbitrary remote error bodies must not enter logs.
The endpoint's supported subset is `n/u/b/s/o`, arrays, structs, dictionaries
and variants. Unused fields can be explicitly projected out before recursion;
unsupported values are not silently decoded. Its copied-header admission runs
before payload decoding. These rules and exact lifecycle APIs are documented
in [D-Bus SDK connection contracts](./DBUS-SDK.md).
The integrated native tests passed on glibc with ASan/UBSan and on musl,
including the existing scalar and duplex routes. Retained FFI callbacks,
Unix-FD transport and general introspection are not added by this slice.

## Desktop migration inventory

| Domain | Current implementation still active | Concrete next work |
|---|---|---|
| Wi-Fi | `desktop/services/network.mjs`, Shell-owned service and independent Settings client | Delivered: JS iwd replaces `network.c/.h`; UI is in Settings, not a complete Shell control panel. Physical-radio/persistence qualification is separate |
| Audio | `desktop/native/audio.c`, Shell PipeWire routing/persistence policy | Requires native event/record mechanisms; not covered by the scalar D-Bus client |
| Displays / shortcuts | `output-client.c`, `shortcut-client.c`, Shell guarded controls | Wayland objects/listeners and guarded transactions; compositor watchdogs stay authoritative |
| Power | `desktop/native/power.c` | Preserve login-service owner, seat, capability and uncertain-action semantics when replacing the client |
| Notifications / tray | `notifications.c`, `tray.c`, `dbus-menu.c` | D-Bus server, signals and container messages; existing disconnect handling is not a migration |
| Other application storage / HTTP | `sysrt/projection/quickjs/storage.c`, `fetch.c` | Shell JSON migration did not replace other applications' storage or the HTTP implementation |
| Other platforms / protocols | Windows filesystem, DNS/HTTP/TLS profiles incomplete | Separate targets; not prerequisites for Linux iwd migration |

Some native code should remain native: GUI rendering/Host integration,
compositor enforcement and qualified authentication mechanisms are not domain
bridges to delete indiscriminately. Installation, updates, recovery and an
untrusted-application sandbox are separate product/security projects.

## First selected slice: Wi-Fi/iwd

The first service implementation remains Shell-owned JS so the existing
authorized UI and agent lifetime are preserved. This is not a new root daemon
or a migration of every domain backend. All six existing Settings pages
subsequently moved to the ordinary Settings process with strict narrow RPC;
that does not remove audio/display/shortcut/power C clients.

1. Extend only the D-Bus signatures, signal/agent routing and connection
   ownership needed above; preserve existing scalar client/service consumers.
2. Move discovery, ordered networks, scan, radio, connect/disconnect, confirmed
   forgetting, agent registration, credential prompts and owner-loss handling
   into JS over those native mappings.
3. Wire the existing Shell/Settings control-panel callers to the JS service.
   Preserve current revision checks, cancellation, masked fields and errors.
   Delete `desktop/native/network.c/.h` and their install/pump/shutdown/build
   wiring once the replacement works; do not retain a C fallback.
4. Exercise real isolated D-Bus/iwd fixtures, including a root-owned synthetic
   provider with ordinary-user applications, forged senders, stale revisions,
   credentials/cancellation and owner restart. Preserve the accepted Alpha
   artifacts; source migration is not evidence of a new ISO or radio test.

The exit criterion is an actual JS Wi-Fi backend with the current supported
operations intact and the replaced C bridge absent. A codec prototype, an
independent UI still calling the old backend, or a passed mock is not completion.

The replacement is implemented in [Shell-owned Wi-Fi/iwd](../desktop/NETWORK.md).
It uses one verified system-bus connection for agent requests and RPC, retains
current scan/radio/connect/credential/cancel/disconnect/forget behavior, and
removes the production C bridge and native lifecycle/build hooks. Unknown
interfaces/properties are explicitly projected away; unsupported used types fail.
Existing root-owned private iwd Shell/Settings fixtures remain the operation
oracle. Standalone glibc/musl private-bus tests cover containers, sender admission,
same-connection agent/RPC/signal routing, ABI, deadlines and closure/GC/FD
lifetime; the glibc endpoint lane also runs under Valgrind. This is source-level
migration evidence only, not a new ISO or physical-radio test.
