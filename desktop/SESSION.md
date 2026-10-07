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

**Actual Live power authorization is deferred.** In the Alpine PAM/elogind UEFI guest,
`CanPowerOff` and `CanReboot` return `Access denied`; the panel reports the
failure and keeps both actions disabled. No real shutdown/restart is claimed.
For Live power controls the project does not install polkit, grant new power privileges or add a
privileged authorization proxy. This is an explicit scope decision, not a
silent fallback to a different power command.
The Debian Live policy also deliberately keeps these actions denied; moving
from elogind to systemd-logind does not enable power controls.

The isolated `desktop-power-shell-raster` and `desktop-power-shell-gl` fixtures
exercise native pointer confirmation/cancellation, capability gating and service
loss against a test-only login1 provider. They never control the host's daemon
and are not evidence that the Live guest has power authorization.

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
