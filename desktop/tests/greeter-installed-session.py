#!/usr/bin/python3 -I
"""Read-only proof inside a marked installed VM after real graphical password login."""
import json
import os
from pathlib import Path
import stat
import subprocess


def main():
    marker = Path("/run/polly-installed-greeter-acceptance")
    info = marker.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or \
            marker.read_text() != "isolated-installed-greeter-v1\n":
        raise RuntimeError("Session proof requires the parent's explicit isolated VM fixture marker")
    if os.getuid() != 1000 or os.geteuid() != 1000 or os.getgid() != 1000 or \
            os.environ.get("USER") != "polly" or os.environ.get("LOGNAME") != "polly":
        raise RuntimeError("Graphical session is not the actual ordinary polly identity")
    subprocess.run(["/usr/lib/polly-account-profile-check", "installed"], check=True, timeout=10,
                   stdout=subprocess.DEVNULL)
    identifier = os.environ.get("XDG_SESSION_ID", "")
    if not identifier or "/" in identifier or len(identifier) > 64:
        raise RuntimeError("PAM did not supply a bounded session identifier")
    expected = {"Id": identifier, "User": "1000", "Service": "polly-greetd", "Class": "user",
                "Type": "wayland", "Seat": "seat0", "TTY": "tty1", "Active": "yes", "Remote": "no"}
    result = subprocess.run(["/usr/bin/loginctl", "show-session", identifier,
                             *["--property=" + name for name in expected]], check=True, timeout=10,
                            capture_output=True, text=True)
    actual = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    if actual != expected:
        raise RuntimeError("Actual logind session differs from the installed greeter contract")
    runtime = Path(os.environ.get("XDG_RUNTIME_DIR", ""))
    info = runtime.lstat()
    if runtime != Path("/run/user/1000") or not stat.S_ISDIR(info.st_mode) or \
            info.st_uid != 1000 or stat.S_IMODE(info.st_mode) != 0o700:
        raise RuntimeError("PAM did not provide the proper owned runtime")
    if os.environ.get("XDG_CURRENT_DESKTOP") != "Polly":
        raise RuntimeError("Ordinary session does not identify the Polly desktop")
    print("POLLY_INSTALLED_GREETER_SESSION_PASS " + json.dumps({
        "uid": os.getuid(), "gid": os.getgid(), "logind": actual, "runtime": str(runtime),
        "rootDesktop": False, "liveProfile": False,
    }, sort_keys=True), flush=True)


if __name__ == "__main__":
    main()
