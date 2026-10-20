# Systemd boot for the CPU shell prototype

These files are the minimal systemd layer used by the 236 MB prototype:

- `init` — BusyBox initramfs PID 1; mounts dev/proc/sys/dev-shm, execs systemd
- `polly.service` — runs `mini-session.sh`
- `polly.target` — `systemd.unit=polly.target`
- `mini-session.sh` — udev + libinput + Pixman PollyWM + CPU PollyUI + Rime IME

Install paths in the test root:

```text
/init                                      -> /init
/usr/local/bin/mini-session.sh             -> mini-session.sh
/etc/systemd/system/polly.service          -> polly.service
/etc/systemd/system/polly.target           -> polly.target
```

Kernel command line:

```text
console=ttyS0 systemd.unit=polly.target
```

Verified:

- `systemd 257` as PID 1
- `Started polly.service` / `Reached target polly.target`
- PollyWM Pixman modeset at 1280x800
- PollyUI shell, taskbar and welcome UI visible
- Rime IME protocol/engine ready; `nihao` candidates and `你好` commit tested

Not yet:

- PAM login / UID 1000 / logind session
- decorator and `/usr/bin/logger`
- systemd-tmpfiles/modprobe units still fail because the minbase root lacks
  those helpers; they do not block `polly.target`
- the test image is still Debian minbase + BusyBox, not the production Live
  systemd contract
