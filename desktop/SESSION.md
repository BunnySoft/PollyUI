# Authentication and session foundation

Both development bases use Linux-PAM and the login1 session interface.
The current Debian candidate uses systemd/udev/logind and
`release/debian/login.pam`; the preserved Alpine path uses OpenRC/eudev/elogind
and `system/login.pam`. Their explicit PAM policies register a login UID and
session without depending on a GNOME/KDE keyring stack. The ordinary compositor
uses libseat's logind backend, and PAM supplies the user's private
`XDG_RUNTIME_DIR`. See the [PollyOS overview](../docs/POLLYOS.md) for the current
candidate and its separately tracked physical acceptance.

The temporary Live getty still explicitly selects automatic login. The account
has no usable password, and **password locking remains disabled by default**.
PAM session registration is not proof that the user authenticated. No protected
boot option, password prompt, secure lock or credential-management UI is
introduced by this foundation.

`system/elogind-polly.conf` keeps automatic lid/key/idle power actions disabled
until lock-before-suspend behavior is implemented. It does not grant additional
power privileges or bypass elogind authorization. A successful D-Bus method
allow rule is not proof that the daemon authorizes an action.

## Installed console setup, login and everyday su

On 2026-10-07 the user explicitly required an administrator entry both during
setup and for ordinary daily maintenance. The installed system must provide
local interactive `polly` and independent root-password initialization, and allow the ordinary user to run
`su -` with that password. A sudo-only entry does not satisfy this requirement.
PollyWM, PollyShell and ordinary applications continue to run as the ordinary
user; this is temporary elevation, not a root desktop or passwordless su.

The account-enabled builder now implements a first console-stage setup/login
path. Previously generated D1 artifacts remain unchanged. New images also
start with both passwords locked, but their root-owned first-boot service asks
for local interactive `polly` and independent root passwords before normal
login. No default password is provided.
Account/authentication state must be deliberately preserved or migrated during
system maintenance and recovery; it must not be overwritten by a system template or
treated as ordinary AppData. Password entry must remain local and interactive,
without plaintext credentials in source, images, logs or command arguments.

This installed-system requirement does not automatically enable password locking,
protected TTY recovery or power authorization in the existing passwordless Live.
It is tracked as SES-07/08/09/10 in the remaining-work ledger.

The authoritative schema-v2 state lives under `/home/.polly-system/accounts`.
The parent is root-private; a runtime bind exposes public account attributes
and a root/shadow-group-readable password database at fixed system locations.
Only the two development accounts' shadow records use Debian's `extrausers`
NSS provider; system accounts, `/etc`, `/var` and package databases remain
slot-local. Unsupported schemas, wrong volumes and unsafe files fail explicitly.
The initialized bit is committed after both passwords succeed. Loss of a
derived completion marker does not reopen setup or reset passwords.

`/usr/bin/passwd` is a narrowly scoped, root-owned setuid compatibility entry.
It preserves the real caller UID, creates a private mount namespace/chroot,
binds the active slot's distribution runtime and PAM policy read-only, and
executes distribution `passwd.distrib` against the shared account database.
Standard PAM handles all password input/checking; the proxy does not collect
passwords or offer arbitrary execution. Distribution passwd loses its separate
setuid bit via dpkg statoverride. A PAM password-scope check rejects managed
password changes outside the persistence entry rather than silently updating
the non-authoritative system-local shadow copy. Ordinary users cannot change root's password.
Managed-account aging/expiry and alternate root/prefix/repository/stdin options
are not implemented; they return explicit errors.

TTY1 uses the late `zz-installed.conf` override so Live's `polly.conf` cannot
restore unconditional autologin. Default console login preselects `polly` but
requires its password. A root-authenticated administrator can run
`polly-accounts autologin on` or `off` after `su -`; the setting applies next
boot and automatic login is consumed only once. Desktop exit returns to login,
not an already authenticated shell. Graphical setup/greeter, administrator UI,
integrated locking/VT protection and account/host migration across different
system versions remain incomplete.

## Ordinary logout and save-before-session-exit

The trusted Shell's Applications menu provides **Log out...**. Alt+Escape now
requests that same confirmation rather than abruptly terminating the compositor;
Ctrl+Alt+L also opens it while a Shell surface has focus. The first confirmation
sends normal `xdg_toplevel.close` requests. Apps decide whether to save, discard
or cancel; PollyUI apps can defer an external close through `oncloserequest`.
The desktop never claims that application data was saved.

Pending public toplevel resources (including unmapped windows), this Shell's
still-running launched processes and pending Activate/Open requests keep the
session alive. The UI lists remaining apps and offers Cancel or another normal
close request, not force-kill. Already closed apps are not reopened on cancel.
Only a fresh, authoritative empty inventory enables the final **Log out now**
confirmation. A sealed barrier denies late new toplevels and new Shell launches.
Logout ends the normal Shell, its `--exit-with-shell` compositor and installed
session entry; greetd then supervises the real user's exit and shows login again.
Standard installed/Live entries additionally select `--save-before-exit`, which
sets the compositor's `--require-session-exit` gate. A Shell's uncommitted normal
exit retains ordinary applications instead of disconnecting them. Development
and health-check commands keep their existing default supervision behavior.
Live ends its desktop in the existing ordinary user's temporary console, not a
root shell, and does not acquire installed persistence or password policy.

Native fixed no-argument operations are `beginSessionExit()`, `sessionExitState()`,
`cancelSessionExit()` and `sealSessionExit()`. Session-status protocol v2 admits
these only from the current private Shell connection as ordinary UID1000, with
no active lock and an exit-with-Shell session. It grants no arbitrary session ID,
other-user access, root process API or logind termination shortcut. Old v1 service
readiness/IME behavior remains compatible; old servers explicitly reject this
new feature rather than report a fake empty session.

`shell/session-exit.mjs` is the shared close coordinator for logout and Power.
It requires an explicit final action and invokes its commit callback once.
Known-not-sent failure (`error.sent === false`) can release the barrier through
Cancel; uncertain sent delivery (`error.sent === true`) stays visibly blocked
and is never retried automatically. Power's daemon capabilities and authorization
remain its native backend's responsibility, not this close coordinator's.
Source/controller and host-close tests are not proof of a real installed
logout-to-greetd or saved-document lifecycle; those belong to the concentrated
Alpha hand test.

## Installed graphical setup and password greeter

On 2026-10-08 the user approved **Debian greetd for the installed profile only**.
The dedicated sources in `session/` and `src/desktop/greeter-client.*` implement
the first-run/password-login flow. Central build, image/default-boot wiring and
real graphical/logind acceptance are separate integration steps; the presence of
these sources does not change existing images, Live policy or the console fallback.

`greeter.mjs` displays four masked fields for separate polly/root passwords and
their confirmations, then a polly-only password login. Pointer, Tab, Enter,
visible progress/errors, retry and cancellation use the existing text input.
Mismatch, empty/multiline/invalid UTF-8, over-1024-byte and identical passwords
submit nothing. Input references are cleared after submission/cancel/close.
First-run setup additionally rejects ASCII control bytes 0-31 and Delete (127)
in the UI, native SETUP API and broker before invoking passwd. An echo-disabled
PTY can still interpret erase/kill/EOF/signal controls; accepting those bytes
could otherwise set a different password from the one entered. Direct greetd
LOGIN keeps its existing nonempty/NUL/CR/LF/UTF-8 bound and does not impose this
new setup-only character restriction on previously configured PAM passwords.
No password is logged, persisted, put in argv/environment or exposed as a hash.
JS strings necessarily exist transiently in RAM; this is not a claim that the
garbage collector securely erases every immutable string copy.

The non-setid native `graphicalAuth` API has only `status()`, `setup(polly, root)`,
`login(pollyPassword)`, `cancel()` and `onProgress(phase)`. It refuses root and
identities other than the dedicated `polly-greeter` service account (UID 1-999).
It checks root kernel socket peers, root-owned socket parent directories and
greeter-owned sockets, bounds frames/deadlines and wipes native credential buffers.
Login uses greetd's length-prefixed JSON protocol with fixed username `polly`,
fixed `/usr/bin/polly-installed-session` and only the two fixed desktop/type
environment entries. `handoff` means greetd acknowledged scheduling, **not** that
PAM/logind or the desktop has already started. Exiting the greeter then lets greetd
establish and supervise the actual user session.

`setup-broker.py` is a root, systemd-socket-activated service, not a root GUI,
setid interpreter, polkit/sudo exception or general command executor. Its only
requests are bounded status/setup/commit/cancel. `SO_PEERCRED` plus a live pidfd
and libsystemd session checks require the dedicated UID/GID, active local
greeter-class **seat0/tty1/wayland** session. Production has no test-authority
switch or environment override. Status returns only setup/login.

Under the existing account state lock, the broker calls the fixed installed
`/usr/bin/passwd polly` and `/usr/bin/passwd root` through a private, echo-disabled
PTY and the existing persistent passwd proxy/PAM policy. It does not hash or
silently reset passwords itself. Both updates must succeed before `prepared`.
The client must then send a distinct commit before existing
`accounts.finish()` validates hashes, bootstraps the initial role and atomically
initializes state. The original **Set passwords and continue** click authorizes
that completion: after `prepared`, the native client sends the separate IPC commit
on its next pump tick unless cancelled. There is no second user confirmation button.
Cancel/disconnect before commit leaves initialization false;
already accepted password changes are retained, never rolled back to older
credentials. Committing is visibly non-cancellable. Closing after that commit
point does not undo committed state or admit a desktop without login. Initialized
accounts refuse setup without changing either configured password.
An unavailable or uncertain operation result goes to the explicit Retry screen;
Retry reads authoritative setup/login status rather than resubmitting setup.
This also handles an already committed setup whose completion reply was lost.
Password-policy rejection stays on setup for re-entry, and a denied login stays
on login. An uncertain transport result does not assert that a desktop was never
scheduled.

The declared new runtime dependency is **greetd 0.10.3-4 from Debian trixie**;
see `session/greeter-dependencies.json`. That exact released worker performs
PAM authenticate/account/setcred/open-session, drops UID/GID/groups for the
session child, waits for it and closes the session/deletes credentials.
It does not implement master's expired-token change flow. The user PAM policy
requires polly UID1000 plus ready/initialized storage in authentication **and**
account checks, so root and incomplete state cannot enter even via autologin.
The dedicated greeter PAM service permits only its named service identity;
`pam_permit` is needed there for greetd's credential establishment even though
greeter password authentication is skipped. It is not used for ordinary login.
Both production policies retain required `pam_loginuid`/`pam_systemd` sessions.
In the exact Debian 0.10.3-4 source, `context.rs:118-124` starts the default
session as `SessionClass::Greeter`; `session/worker.rs:205-218` sets
`XDG_SESSION_CLASS=greeter` (ordinary sessions: `user`) and `XDG_SEAT=seat0`
in PAM's environment **before** `pam_open_session` at line222. Class is removed
from the child's environment only after opening, at line225; the broker therefore
checks libsystemd's recorded class, not a greeter-supplied environment string.
The bounded actual-daemon fixture also asserts greeter/user class at PAM session
opening. This validates the released backend's class propagation, not logind's
real seat registration; production `pam_systemd type=wayland` remains unchanged.

### Central integration contract (source-wired candidate; runtime acceptance pending)

| Source | Installed destination / requirement |
|---|---|
| `session/greeter.mjs`, `greeter-controller.mjs` | `/usr/share/pollyui/desktop/session/`, together with existing JS text-input modules |
| `src/desktop/greeter-client.c`, `.h`, `session/greeter-protocol.h` | Compile into Linux PollyUI; include `desktop/session`. No new native PAM link is needed for this client |
| `session/greeter-entry` | `/usr/lib/pollyui/greeter-entry`, root-owned 0755; normalized LF |
| `session/greetd-launch.py`, `setup-broker.py` | `/usr/lib/pollyui/`, root-owned 0644, invoked by fixed `/usr/bin/python3 -I -B` |
| `session/greetd.conf` | `/usr/lib/pollyui/greetd.conf`, root-owned 0644; no default `initial_session`, `source_profile=false`, VT1 |
| `session/polly-greetd*.pam` | `/etc/pam.d/polly-greetd` and `/etc/pam.d/polly-greetd-greeter`, root-owned 0644 |
| `session/polly-greetd.service`, `polly-greeter-setup.service`, `.socket` | Root-owned system units; socket owner/group `polly-greeter`, mode0600, parent root0755 |
| `session/greeter-dependencies.json` | Qualify/stage the exact package and required runtime packages in the installed recipe, not merely the SDK |

Create a locked, non-login, non-root system account/group `polly-greeter` in
the **image**, with its own UID below1000; do not assign polly's groups or role.
`greeter-entry` uses the PAM runtime for ephemeral XDG directories.
The parent must add a dedicated mutually exclusive `--greeter` service mode
to `src/main.c`: install `pu_greeter_client_install(ctx)` before running the entry,
pump `pu_greeter_client_pump()` with existing native service pumps and shut it down
before freeing JS. Keep the runtime alive across primary-window closure and
setup-to-login surface replacement; clear keep-alive on quit/error/shutdown, as
for lock/input-method modes. Fail startup if installation fails. Do **not** enable
`--desktop` application-spawn APIs for this mode. Add its source/header/include
and feature define in central CMake; `greeter-entry` directly launches the dedicated
PollyWM shell, not `run-session.sh` (that launcher currently selects `--desktop`).

The candidate installed recipe stages exact greetd and the dedicated locked
service account. Both installed image builders qualify those deployed resources,
owners/modes and the actual dpkg-derived dependency inventory before assembly.
Candidate startup enables `polly-greetd.service` and its setup socket, preserving
`polly-accounts prepare` and storage ordering, and uses `graphical.target`.
TTY1 getty and the distro greetd manager are masked only in the guest root;
`zz-installed.conf` no longer pulls console firstboot. The unenabled
`polly-console-fallback.service` explicitly stops the graphical manager and uses
the existing interactive setup/authenticated getty helpers. The explicit GRUB
console entry selects `polly-console.target`, so this fallback is reachable
before first-run credentials exist, without requiring a root login first. It is not a
passwordless fallback. This source wiring still needs the fixed-source native
build and real isolated installed boot acceptance before publication. It never
masks host gettys, changes host PAM/logind or changes Live policy.

The fixed root launcher validates the installed account backend and prepared
`automatic-login` boot snapshot. Default/off or incomplete accounts have no
initial session. Explicit on + completed/ready state consumes the existing private
`autologin-used` marker before launch, at most once per boot, and never deletes it
on restart/logout. The generated root-only runtime configuration does not modify
stored preferences, passwords or initialized state.

### Bounded evidence and remaining product acceptance

`node --test desktop/tests/greeter-controller.mjs` covers confirmations, exact UTF-8
bounds, retry, cancel, secret clearing and closed late callbacks.
`python3 -B desktop/tests/greeter-setup.py` covers the wire/state/seat-policy adapter
and root-only launcher/autologin fixtures. Existing installed account/role/profile
regressions remain relevant. `greeter-ui.mjs` is for the **newly compiled engine**
with `pollyui --test desktop/tests/greeter-ui.mjs`: it exercises real native
DOM/render/input with explicitly synthetic windows/backend. It is not real PAM,
Wayland-window, installed-boot or logind evidence.

`greeter-auth-fixture.py REPO PACKAGES [EVIDENCE]` requires a pristine marked
rootless container with the existing locked installed-account template, private
mount capability and no host PAM/TTY/seat/bus mounts. Root stages only fixture
accounts/policy; the actual native client and greetd greeter run as UID991.
`PACKAGES` must contain the exact verified `.deb`, retained exact APT metadata,
source-current `polly-passwd`, and `polly-greeter-client-fixture`. Compile only the
two small C files, not the whole engine:

```sh
cc -std=c11 -O2 -Wall -Wextra -Wpedantic -Werror \
  -Ithird_party/quickjs -Isrc/desktop -Idesktop/session \
  desktop/tests/greeter-native-client.c src/desktop/greeter-client.c \
  /reference/normal/third_party/quickjs/libqjs.a -lm -lpthread -ldl \
  -o /out/polly-greeter-client-fixture
cc -std=c11 -O2 -Wall -Wextra -Wpedantic -Werror \
  desktop/release/install/passwd-proxy.c -o /out/polly-passwd
```

Actual fixtures passed real passwd/PAM second-password refusal, native
status/setup/prepared-cancel/commit, bootstrap/initialized-reset refusal,
kernel root-peer refusal, actual greetd wrong-password/root refusal, native
wrong-password retry and fixed-command handoff to real UID/GID1000, plus actual
PAM open/close. The fixture deliberately substitutes only `pam_systemd` with
session-event recording and uses greetd `vt="none"`; **seat/logind/GUI tested=0**.
Production seat checks, `pam_systemd` and VT1 are not relaxed for this test.
An actual run exposed and fixed greeter `pam_setcred` policy, retired-worker
cancel acknowledgement, closed-transport cancel races and QuickJS's mandatory
zero-terminated JSON frame. These are functional backend fixes, not lock-helper
success being re-labelled as session acceptance.
The original fixed `f6f1609` was also reproduced in a separate private container:
a DEL-containing setup token committed, but direct PAM denied the intended bytes
and accepted the terminal-edited bytes. That verifier proves only password-byte
matching, not login/session establishment. The corrected actual broker rejects
all 33 ASCII control/Delete bytes in either password (66 cases), without changing
either password record or initialized state. Native SETUP refusal, direct LOGIN
control-character compatibility and successful mixed Unicode/ASCII passwd/PAM
and greetd authentication are separately exercised.

Full T14.1/T14.2 acceptance still requires the parent's newly assembled installed
VM: fresh graphical setup, actual pointer/Tab/Enter/masked input, mismatch/no action,
cancel/second-password failure with initialized=false, visible correct/wrong-password
login/retry, real PAM/logind seat/runtime and logout/restart/cold-boot policy retention.
`greeter-installed-session.py` is a read-only post-login proof, run as the actual
ordinary user at the PAM-created installed-session entry, before existing
`run-session.sh` narrows `XDG_RUNTIME_DIR` to its private compositor directory,
and only after the parent stages the root-owned isolated-VM marker
`/run/polly-installed-greeter-acceptance` with `isolated-installed-greeter-v1\n`.
It requires polly UID/GID1000, `polly-greetd` service, user/wayland/seat0/tty1,
active/nonremote and the owned mode0700 PAM runtime. Its success alone does not
prove the preceding screenshots/input/password/cancellation or subsequent logout
cleanup; those remain explicit native/boot acceptance observations.

### P0 storage migration

The [confirmed storage target](../docs/POLLYOS-STORAGE-DESIGN.md) replaces future
fixed A/B installation assumptions, not the current implementation above.
M01/M06 must jointly migrate the account authority to `/SystemData/Accounts`
and adapt the controller, passwd namespace and PAM/NSS checks. HOME is mapped
by stable UID with root's persistent home and compatible XDG paths; authentication
initialization remains one authority even when overall setup has its own records.
Recheck login, passwd and su after migration and recovery. Existing D1 passes
do not establish new-path acceptance; sequencing/status is in the
[P0 execution ledger](../docs/POLLYOS-BACKLOG.md#16-完整执行清单与依赖).

## Installed-system policy confirmed on 2026-10-07

The user selected password-based `polly` login with configurable automatic
login, then accepted the following desktop conventions. These are requirements,
not retroactive changes to existing D1 artifacts or the passwordless Live.
The console account subset above is implemented; the full policy is not.

| Area | Required installed-system behavior |
|---|---|
| Setup and identity | Provision `polly` and independent root credentials locally; mark completion only after success. The administrator user still runs the desktop without root privileges. |
| Login | Require the `polly` password by default. Automatic login is explicit, administrator-authenticated configuration, not stored plaintext credentials. |
| Administration | Authenticate account, system-component and security changes; ordinary preferences need no elevation. Daily `su -` still uses root authentication. |
| Lock and logout | Unlock with the ordinary user's password; default idle lock is ten minutes and configurable. Wake requires authentication; logout leaves no authenticated shell, and TTY paths must not bypass locking. |
| Power | Authorize only the needed actions for a real active local session. Shutdown/restart give applications a save opportunity and warn about other sessions or updates; suspend/hibernate remain gated on verified lock/recovery. |
| Persistent state | Preserve latest authentication, UID/GID, roles, host identity and policy through maintenance/recovery, including standard password changes. Do not share all of `/etc` or `/var/lib`, or put authentication state in ordinary AppData. Package state must match restored software, not blindly retain its latest database. |
| Network credentials | Remember successful connections in root-managed private system storage, support forgetting networks, and keep credentials out of images/logs. Filesystem permissions are not encrypted-vault protection. |
| Encryption and release trust | Optional data encryption does not bypass boot unlock for automatic login. Formal system updates require signature verification; checksums and login passwords do not supply these protections. |

The restricted administration/power backend still needs implementation and an
explicit dependency/authorization design. A permitted D-Bus message alone is
not daemon authorization, and no general-purpose root executor or root Shell is
implied. See the [complete task ledger](../docs/POLLYOS-BACKLOG.md) for the
confirmed defaults, M01-M06 foundation, M13 power work and remaining dependencies.
Old D1 artifacts retain locked passwords and unprotected automatic login.
Account-enabled candidates are separate development artifacts, not completed
protected sessions or production security qualification.

## Capability-gated power controls

PollyShell's Power panel offers shutdown/restart only when the root-owned
login1 service reports `yes` for the current PID's active, local, same-user
seat session. Opening the confirmation or cancelling it performs no action.
Confirmation rechecks the session and capability before making a noninteractive
request; stale state, service loss and `challenge` authorization do not bypass
the daemon. Suspend and hibernate remain unsupported.

The Alpha Power flow shares `createSessionExitController` with Logout. The
first confirmation requests each application's normal Close path; applications
can show their own Save / Cancel prompt. The on-demand Power layer does not
hold exclusive keyboard focus over those application prompts. Pending windows,
processes or activation requests keep the session open, with explicit retry and
cancel. There is no deadline kill, quiet termination or claim that an open
application has saved. Already closed applications are not reopened by Cancel.
Once the common controller observes all applications closed, a separate final
confirmation seals that same session-close barrier and invokes the existing
`requestPower` once using the current native revision. The native backend then
re-reads the actual PID's session and both daemon capabilities before sending the
fixed noninteractive `PowerOff(false)` or `Reboot(false)` call. No caller-supplied
UID, role, session ID or arbitrary root command is accepted.

`powerState()` now has `version: 1`, the existing capability/session fields,
and `outcome`, `sent`, `busy`, `cancellable`. Outcomes distinguish verification,
accepted request, explicit daemon rejection, preflight failure, cancellation and
uncertain final result. `cancelPower()` cancels only the verification phase
before the final action is sent. Transport loss, owner change, timeout or a bad
acknowledgment after sending is explicitly **uncertain**, not “never shut down”.
The UI waits for the native outcome instead of treating a queued request as
success. Accepted/uncertain actions cannot be cancelled or resubmitted by
refreshing or reopening the panel; the service does not automatically retry the
final method. A definite rejection or preflight failure leaves a visible error
and allows the common barrier to be cancelled without undoing already closed
applications. A backend without versioned outcome tracking or a missing common
application-close controller is visibly unavailable, never a direct unsafe
power-button fallback.

These source changes implement the real **already-authorized `yes` path**.
They do not grant new daemon permission. Ordinary non-setid desktop users
retain the existing trusted Shell connection boundary; root/setid callers and
ordinary public applications cannot acquire this Power interface. The Session
owner supplies the common controller and Shell wiring; Power subscribes to it
and detaches only its own subscription, leaving common lifecycle ownership with
the Shell. Deployment still needs an actual active local user session and
daemon authorization. Isolated source checks of UI/native result handling are
not evidence of a guest shutdown/restart or installed permission.

**Actual Live power authorization is deferred.** In the Alpine PAM/elogind UEFI guest,
`CanPowerOff` and `CanReboot` return `Access denied`; the panel reports the
failure and keeps both actions disabled. No real shutdown/restart is claimed.
For Live power controls the project does not install polkit, grant new power privileges or add a
privileged authorization proxy. This is an explicit scope decision, not a
silent fallback to a different power command.
The Debian Live policy also deliberately keeps these actions denied; moving
from elogind to systemd-logind does not enable power controls.
The Debian Live recipe explicitly stages
`/etc/dbus-1/system.d/polly-live-power.conf`; that file denies polly's capability
queries and final methods. If an installed candidate retains it or login1
returns `no`/`challenge`, Shutdown/Restart remain visibly disabled. Removing a
deny policy, installing an authorization agent or adding a privileged proxy
requires a separately approved installed-profile authorization decision.

The earlier isolated `desktop-power-shell-raster` and `desktop-power-shell-gl`
fixtures exercised the original direct-confirmation controls and capability
gating against a test-only login1 provider. Their Shell-spawned provider is a
managed process, so that fixture must be adapted to an externally owned private
provider before it can exercise the new normal-application-close barrier; a
daemon must not be force-killed just to make the barrier pass. They are not
evidence that Live has power authorization or that this Alpha flow has shut down
a guest. The bounded `power-actions.mjs` cases use synthetic controller/backend
state and the actual view/reconciler. `power-result.c` checks real result-handling
code using synthetic D-Bus messages without connecting to any bus. Actual
ordinary-user guest shutdown/restart and Save/Cancel interaction belong to the
single coordinated Alpha manual acceptance.

## Independent authentication helper

Build the opt-in target:

```sh
cmake -S desktop -B build/desktop-auth -G Ninja \
    -DPU_BUILD_SESSION_AUTH=ON -DBUILD_TESTING=OFF
cmake --build build/desktop-auth --target polly-auth-check -j 2
```

`polly-auth-check` runs as the ordinary caller, **not setuid/root**. It invokes
the fixed `polly-lock` PAM service for its real UID. Linux-PAM's own
distribution-provided `unix_chkpwd` helper performs the protected shadow-file
check. This lock helper adds no privileged password reader and does not select a
username or PAM service from untrusted UI data.

The binary only accepts a same-UID Unix stream socket on FD 3; it has no
password arguments or environment variables. The request contains a fixed
magic, request serial and a bounded nonempty password. Replies echo the serial,
an accepted/denied/unavailable result and PAM's numeric status. It refuses root,
setuid execution, embedded NULs, invalid/oversized requests and unsafe PAM policy
files. A policy must be a regular root-owned file not writable by other users.

The helper closes unrelated descriptors, redirects standard streams away from
the terminal, clears the environment, disables core dumps and process
dumpability, limits input waiting to five seconds and bounds its lifetime to
30 seconds. Its own password buffer is explicitly cleared. PAM owns any
conversation responses it receives; this is not a guarantee that every module
or allocator securely zeroizes all copies.

The service requires `pam_unix` without `nullok`, account checks and a failure
delay. Only one password prompt is supported; multifactor or interactive
password-change policies fail closed as unavailable. Missing service/module,
expired account or unsupported policy is never treated as successful unlock.

## Opt-in session-lock mechanism

The combined runtime can now build the separately authorized `--session-lock`
service with `PU_BUILD_SESSION_AUTH=ON`. PollyWM's explicit
`--lock-on-start PROGRAM` development option starts the configured program on
its own private Wayland connection. Ordinary clients and the Shell are not
granted the session-lock global. This is not enabled by the Live launcher.

The compositor covers outputs before the client can draw, suppresses ordinary
focus/shortcuts/drag/input, reverts provisional display settings, and refuses new
Shell display configurations while locked. It acknowledges the standard
`ext-session-lock-v1` request only after covered frames have been presented.
Lock surfaces are independent of ordinary layer-shell surfaces. Output
hotplug gets a black cover; loss of all outputs or the lock client does not
expose the desktop. A replacement trusted client can recover a crashed lock
without first revealing normal content.

`desktop/session/lock.mjs` renders a neutral, multi-output PollyUI password
interface. It does not load user themes or arbitrary images. Native
`sessionLock.authenticate()` starts the adjacent helper, ties its private reply
to the current request serial and requires a successful helper exit plus a PAM
acceptance result before sending the unlock request. Failed, stale, missing or
timed-out replies stay locked. The helper lifetime is bounded and input fields
are cleared after submission. Both UI and helper disable memory dumps.

To exercise this development entry on a disposable **password-configured**
account, explicitly set `POLLY_LOCK_RUNTIME` to the absolute PollyUI executable
and pass the executable `desktop/tools/run-session-lock.sh` as
`pollywm --lock-on-start`'s program before `--shell`. The build/install rules keep
the helper next to the runtime. A root-owned `/etc/pam.d/polly-lock` service must
already be configured. Do not enable it on the passwordless Live account:
there is no usable password, and forcing it to start would leave it locked.

This is a tested locking mechanism, **not a completed protected desktop
session**. A normal Shell lock menu, configured recovery trigger, elogind
Lock/Unlock signal policy, lock-before-suspend, authenticated TTY fallback and
physical-device qualification remain to be connected. The development Live
still returns to an unprotected ordinary-user console after desktop exit.
Therefore it continues to advertise no secure lock and enables none by default.

## Startup health and ordinary shutdown

`polly-desktop --check` distinguishes created Shell surfaces, private audio
discovery and the separately spawned input method's engine/protocol initialization.
It requires the services selected by `--audio`/`--ime`; it does not wait for services
that were not requested. The native input method reports readiness after schema
selection, initial state and protocol synchronization, not merely when its PID
exists. Its connection and role must remain live when the Shell queries status.
No user text, passwords or process-control request is carried by this status
protocol.

The diagnostic has an explicit inner readiness deadline and an outer process
deadline. Known failures return nonzero promptly via the opt-in
`--exit-on-shell-failure` supervision policy, with retries disabled. Normal Shell
crashes continue to preserve ordinary clients unless an explicit exit policy
was selected; failure never terminates a protected locked session.

During ordinary compositor shutdown the input method receives termination while
its Wayland connection can still complete surface cleanup. Its grace period is
bounded; an unresponsive service still gets terminated. An SDL quit now ends
the service keep-alive loop even when it has no visible window, rather than
requiring connection failure to end it.

`desktop-installed-session` covers disabled services, real initialization,
delayed startup, invalid schemas and never-ready processes. The `session-health`
core fixture covers missing/failed services, timeouts, closed Shell surfaces and
transition reporting. These checks do not replace hardware, rendered-frame,
Chinese-input or audio-signal acceptance.

The running Shell also observes service status at a bounded polling cadence.
Input-method loss and native audio errors are shown through the panel's existing
error display and included in `getState().services`. A long input-method startup
produces a warning after 15 seconds; it does not itself terminate or restart the
service. Repeated unchanged warnings do not flood logs, recovery clears the
service warning, and unrelated settings/application errors keep their own state.
This observation never changes normal Shell supervision, application lifetimes,
lock policy or audio routing.

## Isolated verification

`tests/auth-helper.py` runs only as root in a throwaway Podman container,
creates a fresh test-only user/password there, then executes the helper as
that unprivileged UID. It covers correct/wrong passwords, invalid payloads,
root rejection and unsafe policy permissions. Test credentials are generated
in memory and never printed or committed. The fixture must never be run
against host accounts.

The UEFI boot fixture additionally verifies active ordinary-user PAM/elogind
registration before accepting desktop readiness. It performs no host account,
password, service or access-policy changes.

`desktop-session-lock` exercises private authority, covered-frame acknowledgment,
client crash/recovery and output removal/hotplug. `desktop-native-lock-raster`
and `desktop-native-lock-gl` add the actual PollyUI lock surfaces and input.
Passing the compositor/client/runtime executables after the helper path to
`auth-helper.py` adds an end-to-end disposable-user run: native masked typing
rejects an incorrect password, then the real PAM check unlocks with a generated
correct password. Temporary credentials never travel through argv or environment
variables; the test file lives only in the disposable fixture directory.
