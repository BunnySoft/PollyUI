#!/usr/bin/python3 -I
"""Generate the fixed installed greeter config from the existing boot policy."""
import importlib.machinery
import importlib.util
import os
from pathlib import Path
import resource
import stat
import sys

BASE = Path("/usr/lib/pollyui/greetd.conf")
CONFIG = Path("/run/polly-greeter/greetd.conf")
ACCOUNTS = "/usr/sbin/polly-accounts"


def accounts_module():
    loader = importlib.machinery.SourceFileLoader("polly_greetd_accounts", ACCOUNTS)
    spec = importlib.util.spec_from_loader(loader.name, loader)
    accounts = importlib.util.module_from_spec(spec)
    loader.exec_module(accounts)
    return accounts


def configure(accounts):
    accounts.require_ready(False)
    base = accounts.read(BASE)
    if "[initial_session]" in base:
        raise ValueError("Default installed greeter configuration must not enable autologin")
    accounts.trusted(CONFIG.parent, directory=True)
    policy = accounts.read(accounts.RUNTIME / "automatic-login", 16)
    if policy not in ("on\n", "off\n"):
        raise ValueError("Invalid prepared boot login policy")
    marker = accounts.RUNTIME / "autologin-used"
    if marker.exists() or marker.is_symlink():
        info = accounts.trusted(marker)
        if stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1:
            raise ValueError("Invalid once-per-boot login marker")
    elif policy == "on\n" and accounts.completed():
        accounts.require_ready()
        descriptor = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        os.close(descriptor)
        # Consume before launch, as the existing getty does; a failed launch never repeats autologin.
        base += '\n[initial_session]\ncommand = "/usr/bin/polly-installed-session"\nuser = "polly"\n'
    accounts.atomic(CONFIG, base, 0o600)


def main():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    if os.getuid() != 0 or os.geteuid() != 0 or len(sys.argv) != 1:
        raise PermissionError("Fixed installed greetd launcher requires its root service")
    os.environ.clear()
    os.environ.update(PATH="/usr/sbin:/usr/bin:/sbin:/bin", LANG="C.UTF-8")
    os.umask(0o077)
    for path in (Path("/usr"), Path("/usr/sbin"), Path("/usr/bin"), BASE.parent):
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid or info.st_mode & 0o022:
            raise PermissionError("Untrusted greeter deployment directory")
    for path in (Path(ACCOUNTS), Path("/usr/sbin/greetd"), BASE):
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid or info.st_mode & 0o022:
            raise PermissionError("Untrusted fixed greeter deployment")
    configure(accounts_module())
    os.execve("/usr/sbin/greetd", ["/usr/sbin/greetd", "--config", str(CONFIG)],
              {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"})


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError) as error:
        print("Installed graphical login refused startup: " + type(error).__name__, file=sys.stderr)
        sys.exit(1)
