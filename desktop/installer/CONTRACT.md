# Read-only installation-target review

This is an ordinary, non-root PollyUI application, not a second installer.
It implements T24.6's bounded report/view/controller binding, a fixed ordinary-user
read-only transport, and T24.3's pre-write acknowledgement. Neither full task is
closed by this module. There is no writer, privileged helper invocation, password prompt or OS
authorization. Every binding, confirmation and action result has
`readOnly=true` and `writeAuthorized=false`. Public Live root credentials grant
no target-write permission.

## Source-checkout launches

Run from the repository root with an already built PollyUI runtime, as an
ordinary user. CMake packaging includes only the production installer modules,
not synthetic entry points or test providers. The model/host/native-provider
Node suites are registered as the CTest `desktop-install-target-ui` test;
registration and source packaging do not qualify native rendering or a
production source producer. Do not copy `targets.py` away from its source-adjacent
`release/storage/layout.py` and claim a functional deployed helper.

```powershell
.\build\win-clang\pollyui.exe --app-id org.pollyui.install-targets .\desktop\installer\main.mjs
.\build\win-clang\pollyui.exe --app-id org.pollyui.install-targets-fixture .\desktop\installer\fixture-main.mjs
node --test .\desktop\installer\target-tests.mjs .\desktop\installer\host-tests.mjs
```

Without opt-in, `main.mjs` has no provider and visibly reports **native helper integration
pending**. It does not enumerate anything. `fixture-main.mjs` uses synthetic
snapshots only, clearly labeled in the title and content. Native rendering,
real ordinary-user execution and screenshots are separate fixed-commit
acceptance, not claimed by the mock-host tests. On a desktop-services-enabled
runtime, explicitly adding `--desktop` before the script and `--theme` after it
opts into `desktop/client/theme.mjs`'s existing read-only theme subscription.
Only validated/bounded component colors change; no Shell menu, theme painter,
appearance-management permission or decoration implementation is modified.
On Linux, `--desktop` plus the script argument `--readonly-provider` opts into
the narrowly fixed `desktop.installTargets` API. `--desktop` alone does not
acquire any report and grants no installation/management/root rights. With
opt-in, the ordinary window automatically refreshes; absent/incompatible native
API or missing/unqualified deployed source is a visible error, not a mock,
empty inventory or helper-pending success. API registration alone starts no
process and does not invent production source inputs.

## Explicit provider interface

`createTargetApp({host, provider, optInTheme, native, reportError, timeoutMs})`
creates an ordinary native application window. `provider` defaults to `null`,
never a mock or arbitrary command fallback. Tests supply the same factory an
explicit mock host and report callbacks. `reportError` follows the existing
console-report callback pattern; acquisition/validation errors are also visible.

```javascript
const provider = {
  async readReport({purpose, requestId, previousGeneration}) {
    // purpose: "refresh", "confirm" or "hypothetical-onward"
    // Trusted integration must independently acquire bounded readonly evidence.
    return {
      schemaVersion: 1, readOnly: true, writeAuthorized: false,
      generation: "unique-acquisition-generation",
      report: inventoryReport, // unchanged targets.inventory() schema 1
      source: {
        kind: "memory", // "memory", "downloaded", "unknown"
        description: "Human-readable source provenance",
        downloadedBytes: 1234, // exact bytes, or null (unknown), not physical capacity
        memoryLogicalBytes: 5678, // exact logical bytes, or null
        exactSourceMapping: true,
        kernelBasis: ["259:1"], // kernel IDs explicitly marked active-source in report
        reasons: [] // {code, message, detail?}; preserved when mapping is unknown
      }
    };
  },
  subscribeInvalidation(callback) {
    // Optional: removal/hotplug/mount/source change notification. Does not enumerate.
    // Return the listener cleanup function. Called on application close.
    return unsubscribe;
  }
};
```

Callbacks are **not** privileged commands, executable paths or IPC capabilities.
`native-provider.mjs` accepts only the versioned fixed native adapter described
below, parses the exact envelope, and rejects generation replay. Its optional
`cancelRead()` and `stop()` own transport cancellation; the controller invokes
them on interruption, acquisition failure/timeout and close, with visible logs
on cancellation failure. A provider without these methods retains the original
late-result rejection behavior, without claiming the transport stopped.
The fixed helper obtains source basis from actual collector active-source
reasons, never UI claims. It applies the unchanged exclusions and correlates
the running/root/boot/source ancestry.
The shape parser cannot authenticate a provider or prove complete hardware
evidence. `RM`, model and device path never substitute for real serial/WWN.
There is still only a corroborated-USB eligibility floor, not physical-media
qualification, exclusive access or other mount-namespace/raw-opener proof.

Input is a plain object, not JSON text. Exact schema/readonly flags, unique
entry IDs, required fields, duplicate IDs, bounded arrays/text/depth and a
2 MiB JSON byte limit are checked. Ineligible/unknown entries, raw evidence,
null fields and reason details remain in the immutable report and view.
Unsafe JS integers are rejected visibly rather than rounded into a new scope:
values above `Number.MAX_SAFE_INTEGER` need a future exact-integer wire schema.
Unknown source mapping remains visible and blocks selection/confirmation.
Source logical/downloaded bytes are separate from disk and measured layout
capacity; `null` is displayed as unknown, not zero.

## Selection and asynchronous boundaries

First acquisition never preselects a target. The user explicitly selects one
qualified entry, reviews its model/capacity/serial/WWN/partitions/current use,
then acknowledges the exact **hypothetical whole-disk** `[0,endByteExclusive)`
range, partition table and all reported partitions. Nothing is cleared.

The controller's immutable state has `{schemaVersion, readOnly,
writeAuthorized, generation, phase, envelope, selection, scopeAcknowledged,
confirmation, reasons}`. Selection freezes identity, complete observation
(including node/topology/diskseq), exact clearing scope, measured layout,
source metadata and acquisition generation. It is a `ui-only-target-binding`,
**not** Python's SHA selection fingerprint or an authentication token.

Each view callback captures the local generation and the exact selection object.
Old callbacks return `status="stale"` without modifying a replacement selection.
Fresh async results must match the active request/local generation before
publication. Cancel, explicit refresh, provider invalidation and window close
discard consent and pending requests. Late results cannot resurrect it.
Acquisition timeout is bounded to 10 seconds by default (configurable 1–30000
ms); retry is explicit. A session retains up to 1024 acquisition generations to
reject replay of any previously observed report; reaching that limit requires
closing/reopening, not silently pruning replay protection. The provider owns cancellation of its own read-only
transport; ignoring a late result alone is not a claim that it stopped.

`confirm(generation, selection)` independently acquires a new report generation
and structurally re-identifies all frozen target/scope/source fields. Removed,
replaced, ambiguous, active, missing-ID, renumbered/hotplugged, changed-capacity,
changed-partition or changed-source evidence invalidates consent. Report errors
and malformed inputs fail closed and visibly; cancellation is never installation
success. Even identical explicit refresh discards consent.

Only a matching fresh report returns:

```javascript
{
  status: "confirmed-read-only", readOnly: true, writeAuthorized: false,
  confirmation: {
    schemaVersion: 1, kind: "ui-only-scope-confirmation",
    readOnly: true, writeAuthorized: false, generation: 5,
    acknowledgedReportGeneration: "acquisition-before-consent",
    reidentifiedReportGeneration: "fresh-acquisition",
    target: immutableFreshUiBinding
  }
}
```

`hypotheticalOnward(generation, confirmation)` re-acquires/re-identifies again
before any hypothetical onward review, then returns `status="blocked-no-writer"`
and clears the confirmation. It never calls an onward writer callback.
Other result statuses include `ready`, `selected`, `scope-acknowledged`,
`scope-unchecked`, `rejected`, `blocked`, `unavailable`, `invalidated`, `error`,
`stale`, `cancelled`, `superseded`, and `disposed`, always readonly and unauthorized.
There are no installation progress percentages or success records: no installation
has begun. Actual OS authorization, the real user/media gate, trusted server
deployment, exclusive descriptor/race closure and writer remain separate work.

## Fixed native transport and deployment contract

The Linux desktop-services target now includes `src/desktop/install-targets.c`,
and the existing application API lifecycle calls install/pump/shutdown outside
the Wayland-only service block. CMake runtime packaging uses the complete
source-adjacent helper layout below (with the existing `/usr` install prefix and
`lib` library directory); the default Debian platform recipe also copies those
four fixed code files, normalizes LF and sets root-owned 0755 directories/0644
files. `package-linux.mjs` records the helper/collector/layout/payload source
hashes as build inputs and its tar writer assigns root ownership. This source
wiring does not rebuild or retroactively qualify existing artifacts.

A real qualified offline source producer is still **pending**. No production
`source.json`, measured amounts, EFI/RECOVERY defaults or staged inputs ship
here. Missing configuration remains a visible logged refusal before enumeration.
The three existing lifecycle calls are:

```c
// pu_applications_install(), before publishing the desktop global:
if (!pu_install_targets_install(ctx, desktop_api)) return 0;
// pu_applications_pump(), before returning worked:
worked += pu_install_targets_pump();
// pu_applications_shutdown(), before freeing desktop_api/context:
pu_install_targets_shutdown();
```

The API is exactly `desktop.installTargets = {protocolVersion: 1,
transport: "fixed-unprivileged-v1", readReport(), cancel()}`. Both functions
reject all arguments. `readReport()` returns a Promise of the exact envelope;
neither API takes commands, helper paths, source paths, measurements, credentials
or kernel-basis claims. Registration starts no process. Non-Linux/missing API
is an explicit opted-in UI refusal; there is no fallback.

Each acquisition launches only the deployment-fixed helper using the canonical
root-owned `/usr/bin/python3` interpreter with `-I -S -B`, fixed environment
`PATH=/usr/bin:/bin, LC_ALL=C`, EOF stdin, stdout and separate diagnostic pipes.
UID0 and setid callers are refused. The child retains the ordinary caller's
UID/GID, sets no-new-privileges, clears ambient capabilities, starts a private
process group, requests parent-death termination, and closes all inherited
descriptors other than stdin/stdout/stderr. No sudo, polkit, session-bus
privilege broker or generic process/filesystem API is added.
Linux `close_range` and the stated `prctl` controls must actually succeed;
unsupported kernels refuse acquisition rather than using a descriptor-limit
guess or inheriting unrelated application FDs.

The single in-flight child has a monotonic **8 second total deadline**, including
the final pipe-EOF wait even after the leader exits. At most 2 MiB stdout and
4096 diagnostic bytes are retained, with at most sixteen 16 KiB reads per pipe
per pump. Overflow, transport failure, nonzero exit and malformed JSON reject
the Promise and log `[install-targets]` diagnostics. Parsing is followed by
the existing exact UI schema/safe-integer validation. The fixed Python collector
uses a 7 second evidence deadline, its original MAX_NODES=256/MAX_DEPTH=16/
MAX_TEXT=4096 bounds and the unchanged dynamic storage layout.

Cancel/timeout/close kill the acquisition process group, close pipe FDs and
reject after the direct owned child is reaped. A superseding read waits for
that rejection before launching its child. Runtime shutdown terminates/reaps
the direct child and releases QuickJS Promise references without late callbacks.
Successful completion also terminates residual group members. This is bounded
read-only transport lifetime, not exclusive device ownership; the ordinary OS
init remains responsible for reaping orphaned grandchildren on abrupt group
termination. There is no hotplug watch subscription; each refresh/confirm/
hypothetical-onward acquires new evidence and a new UUID generation.

Deploy root-owned, readable regular files with non-group/world-writable
ancestors (normally directories 0755, files 0644), without symlink components:

| Fixed location | Contents |
| --- | --- |
| `/usr/lib/pollyui/install-targets/install/readonly-helper.py` | New fixed helper, no CLI options |
| `/usr/lib/pollyui/install-targets/install/targets.py` | Current unchanged-policy collector/model |
| `/usr/lib/pollyui/install-targets/storage/layout.py` | Current source-adjacent storage contract |
| `/usr/lib/pollyui/install-targets/maintenance/payload.py` | Current development-unsigned payload validator |
| `/usr/share/pollyui/install-targets/source.json` | Qualified source receipt from a real offline source producer, not UI input |
| `/run/polly-install-source/payload.json` | Exact current payload contract bytes bound by that receipt |
| `/run/polly-install-source/<name>` | All receipt-listed staged regular source inputs, readable by the ordinary caller |

Root ownership is a **local deployment trust assumption**, not production
signature authentication. The host kernel, fixed distribution Python standard
library, `/usr/bin/lsblk`, `/usr/bin/findmnt` and deployment administrator are
trusted; malicious root, ACL/mount-namespace authority changes and raw-opener
proof are outside this read-only model. Source files are regular-file read/stat
probes only; no block-device open is added. Source/helper/config ownership,
permissions, types and symlink ancestry are checked before use. Missing config,
layout, payload, readable source or qualification refuses **before enumeration**.

`source.json` has exactly these fields; no template is deployed as real input:

| Field | Required value/evidence |
| --- | --- |
| `schemaVersion`, `kind` | Integer `1`, `"polly-install-source"` |
| `sourceKind`, `qualification` | `"downloaded"`, `"deployment-owned-offline-inputs-v1"`; memory/other kinds currently refused |
| `description` | Nonempty bounded human provenance; emitted description also states development-unsigned |
| `inputs` | 1-15 unique `{name, bytes}` records; direct basename only, excluding `payload.json`; positive exact byte lengths of **all** staged inputs |
| `measurements` | Exactly `{payloadBytes, headroomMiB}` for EFI/SYSTEM/PERSISTENT/RECOVERY, measured/qualified by the offline source producer using current `storage/layout.py`; no reserve/payload defaults |
| `payloadContractSha256` | SHA256 of exact staged `payload.json` bytes, solely a change/integrity binding |

The helper validates the current payload contract and requires its SYSTEM/
PERSISTENT measured bytes to equal the receipt's corresponding measurements.
EFI/RECOVERY measurements and all reserves must come from the qualified producer;
they are not inferred from archive length or fabricated by this helper.
`downloadedBytes` is the observed total of listed staged regular-file lengths,
excluding the payload-contract sidecar. `memoryLogicalBytes` is `null`, never
disk capacity or invented RAM usage. Receipts/contracts/source stat identities
are rechecked after collection; their hashes bind changes across acquisitions,
so a same-size replacement revokes old UI consent. These hashes, root metadata,
generation strings and UI bindings are **not** signatures, authentication
tokens or write permits.

All listed paths plus `payload.json` pass to the actual fixed collector. Only
its kernel-backed source ancestry and reported `active-source` reasons establish
`kernelBasis`. A root-owned `/run` path may still be RAM tmpfs; ownership or a
complete downloaded file never proves physical source mapping. Unknown RAM,
overlay, loop or unresolved running/root/boot/source ancestry emits
`kind="unknown", exactSourceMapping=false` with visible reasons, retaining any
actually observed byte length and model errors. Such a report cannot select or
confirm any target. Non-USB floors, serial/WWN/diskseq/ancestry and all three
protected internal model-family exclusions remain unchanged.

## Private native acceptance fixtures

`native-provider-tests.mjs` and the existing Node host/model suites cover request,
replay, malformed/unsafe output and timeout/cancel/close barriers. Host mocks
prove ordinary view serialization only, not SDL rendering or backend trust.

`desktop/tests/install-readonly-native.sh` compiles only the dedicated adapter
and a small QuickJS transport harness, never the full project/CMake/VM/image.
It requires the explicit `/run/polly-readonly-private-fixture` marker in a
**rootless private container** with network disabled, source mounted read-only,
private Linux `/tmp` and trusted-mode 0755 tmpfs mounts for `/run`,
`/usr/lib/pollyui` and `/usr/share/pollyui`. Container-root staging is not helper
privilege: every native acquisition runs as UID1000, empty supplementary groups.
The fixed **test compile** path names `install/fixture-helper.py`, not the
production helper; there is no runtime environment/argument escape for tests.

No `CAP_SYS_ADMIN` or fixture mount syscalls are needed: the operator creates
the private tmpfs views when starting the container. Production host mounts,
mount propagation, `/proc` and `/sys` are not altered by test registration.

CTest registers `desktop-install-readonly-transport` with the
`root-container;private-readonly-fixture` labels. Its strict small QuickJS target
`polly-install-readonly-transport-test` compiles only the adapter/harness and
uses the fixed test-helper macro. `install-readonly-registered.py` refuses
without the private marker/tmpfs views, stages the already-built test binary
only in private `/tmp`, then executes the existing UID1000 acquisition matrix.
It is not part of the ordinary host/source-only storage runner.

The fixture supplies real private sysfs/proc text and fixed synthetic
`lsblk/findmnt` subprocess responses to the actual collector, then executes
the actual helper envelope, compiled native Promise transport, JS provider,
model and controller. It checks original serial/WWN/model/capacity/diskseq/
reason parity, distinct generations, dynamic capacity, confirmed-readonly/
blocked-no-writer results, unknown overlay/RAM, missing/unqualified/writable/
unreadable/symlink source, source replacement, unsafe integers, partial/malformed/
oversized output, disconnect, cancellation, deadline-after-leader-exit,
inherited descriptor closure and no pipe/direct-child leaks. It does not read
real disks, host sysfs/proc evidence, Accounts/Network/Users, or create writers.

`native-fixture-main.mjs` is the separate final heavy-lane **ordinary SDL window**
fixture: it rejects old binaries/JS stubs and accepts only the staged private
collector fixture receipt/identity. The distinct `pollyui-readonly-fixture`
target reuses the full product source/options/dependencies but applies the
fixed test-helper macro only to that uninstalled fixture target, never to
production `pollyui`. CTest's `desktop-install-readonly-window` is labeled
`ordinary-native;private-readonly-fixture`, receives absolute production
compositor/runtime and fixture-runtime target paths, and saves logs under a
private build evidence directory. It requires actual UID1000 and explicitly
prepared synthetic source, then launches the fixture as a separate ordinary
window through the existing native launcher.

Both native registrations have 120-second timeouts; neither runs by virtue of
source registration, and neither accepts an environment/argument override to
the production helper. The final lane must observe
`NATIVE READONLY ORDINARY WINDOW PASS` and no FAIL marker; source/Node mocks or
the small transport harness do not qualify that window, real pointer/wheel
input, normal installed source modes, GPU hardware or production deployment.
Default provider-pending, explicit missing-config errors, real pointer/wheel
actions and close/late-result barriers remain separate runtime scenarios.
