# Authentication and session foundation

The development image now uses Linux-PAM and elogind. Its explicit
`system/login.pam` registers a login UID and an elogind session, avoiding reliance
on optional desktop-keyring or alternate session modules in the distribution's
generic PAM stack. OpenRC starts dbus, cgroups and elogind. The ordinary
compositor uses libseat's logind backend, and PAM supplies the user's private
`XDG_RUNTIME_DIR`.

The temporary Live getty still explicitly selects automatic login. The account
has no usable password, and **password locking remains disabled by default**.
PAM session registration is not proof that the user authenticated. No protected
boot option, password prompt, secure lock or credential-management UI is
introduced by this foundation.

`system/elogind-polly.conf` keeps automatic lid/key/idle power actions disabled
until lock-before-suspend behavior is implemented. It does not grant additional
power privileges or bypass elogind authorization. A successful D-Bus method
allow rule is not proof that the daemon authorizes an action.

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
check. The project adds no privileged password reader and does not select a
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

The helper is **not yet a screen locker**. A real lock requires compositor-owned
input/rendering isolation, correct output lifecycle, a separately trusted lock
client, crash-safe recovery and binding authentication success to the current
lock attempt. None may be replaced by an ordinary fullscreen overlay.

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
