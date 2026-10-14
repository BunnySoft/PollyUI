# Processes: read-only Linux process monitor

Launch **Processes** from Applications, run the installed `polly-processes`, or:

```sh
pollyui --desktop --app-id org.pollyui.processes desktop/apps/processes/main.mjs
```

The fixed relocatable wrapper starts an independent ordinary process, QuickJS
realm and decorated window. It uses original Polly controls/icons and optional
public theme subscription, not Shell management connections, an application
registry or a process daemon. No new C bridge or command interpreter is involved.

The monitor reads actual PID, kernel `comm` name, state, resident memory and CPU
counters from `/proc` using the existing SysRT libc file mappings. It does not
read command lines, environments or user documents. **Refresh**, F5 and a
two-second timer take a fresh snapshot; each column toggles sorting. CPU is
`delta(utime + stime) / delta(machine CPU ticks) * 100`, the share of total
machine CPU, not a per-core percentage or cgroup-normalized quota. Aggregate
guest counters are not counted twice. The first observation, a reused PID
with a different start time, a reset counter or a nonadvancing aggregate shows
**Unavailable**, distinct from an actually sampled zero. RSS comes from
`VmRSS` in KiB, converted to bytes; a missing value is unavailable, not zero.
These are sampled observations, not an atomic system-wide snapshot.

The provider opens `/proc` and each PID directory with NOFOLLOW/CLOEXEC, reads
only fixed `stat`/`status` names relative to those descriptors and checks the
PID/start-time identity again after collecting RSS. Exited, changed or denied
processes are counted visibly as skipped. Other I/O/parse failures are explicit;
the last successful rows remain labelled stale rather than an empty success.
Snapshots contain at most 4096 processes and each pseudo-file at most 64 KiB;
a larger list is labelled partial. Calls are synchronous and can block the
application event loop; there is no hard I/O deadline. Only Linux x86_64
glibc/musl mappings are supported by the current backend. Other platforms or
missing `/proc` fail visibly.

This first slice is **monitor-only**. There is no End/kill control, generic
signal API, arbitrary shell execution, privilege escalation, CPU priority,
service management or administrator policy. A future management slice must
verify actual runtime authority and process/session identity, protect critical
session processes, require confirmation and report denial/cancellation; this
application does not bypass those missing contracts.

## Bounded checks

```sh
node --test desktop/apps/processes/tests/processes.mjs
ctest --test-dir /absolute/sysrt-build --output-on-failure -R '^desktop-processes-native$'
```

The Node suite checks parsers, CPU/PID reuse, sorting, errors, late close and the
actual reconciler's ordinary window/control tree with injected observations.
The native fixture runs as an ordinary user, starts only its own bounded Python
child, samples real `/proc` through the production provider in three QuickJS
VMs and cleans up that child only. It never signals shared host processes or
system services. These checks do not establish native window pixels/input,
physical CPU accuracy or a rebuilt release/ISO.
