# Read-only installation-target review

This is an ordinary, non-root PollyUI application, not a second installer.
It implements T24.6's bounded report/view/controller binding and T24.3's
pre-write acknowledgement only. Neither full task is closed by this module.
There is no writer, privileged helper invocation, password prompt or OS
authorization. Every binding, confirmation and action result has
`readOnly=true` and `writeAuthorized=false`. Public Live root credentials grant
no target-write permission.

## Source-checkout launches

Run from the repository root with an already built PollyUI runtime, as an
ordinary user. Application entry points are not deployed by CMake/package
scripts. The two Node suites are registered as the CTest
`desktop-install-target-ui` test; this does not deploy a native provider or
qualify native rendering. Do not copy `targets.py` away from its source-adjacent
`release/storage/layout.py` and claim a functional deployed helper.

```powershell
.\build\win-clang\pollyui.exe --app-id org.pollyui.install-targets .\desktop\installer\main.mjs
.\build\win-clang\pollyui.exe --app-id org.pollyui.install-targets-fixture .\desktop\installer\fixture-main.mjs
node --test .\desktop\installer\target-tests.mjs .\desktop\installer\host-tests.mjs
```

`main.mjs` has no provider and visibly reports **native helper integration
pending**. It does not enumerate anything. `fixture-main.mjs` uses synthetic
snapshots only, clearly labeled in the title and content. Native rendering,
real ordinary-user execution and screenshots are separate fixed-commit
acceptance, not claimed by the mock-host tests. On a desktop-services-enabled
runtime, explicitly adding `--desktop` before the script and `--theme` after it
opts into `desktop/client/theme.mjs`'s existing read-only theme subscription.
Only validated/bounded component colors change; no Shell menu, theme painter,
appearance-management permission or decoration implementation is modified.

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
No current native enumerator/server-to-application pipe implements this contract.
`exactSourceMapping=true` with kernel basis is only supplied synthetic evidence
today; a later trusted server must establish its real basis. It must apply the
unchanged exclusions and correlate the running/root/boot/source ancestry.
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
transport, if needed; ignoring a late result is not a claim that it stopped.

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
