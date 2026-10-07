#!/usr/bin/python3 -I
"""Root-owned installed account lifecycle; passwords are handled only by passwd/PAM."""
import argparse
from contextlib import contextmanager
import errno
import fcntl
import grp
import importlib.util
import json
import os
from pathlib import Path
import re
import resource
import stat
import subprocess
import sys
import syslog
import tempfile
import time

DATA = Path("/home/.polly-system/accounts")
ROOT = Path("/var/lib/polly-accounts")
RUNTIME = Path("/run/polly-accounts")
UUID_FILE = Path("/etc/polly-home-uuid")
STORAGE_MANIFEST = Path("/etc/polly-storage.json")
STORAGE_PROGRAM = Path("/usr/lib/polly-storage/storage.py")


def trusted(path, directory=False, secret=False):
    info = path.lstat()
    valid_type = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    if not valid_type or info.st_uid != 0 or info.st_mode & 0o022 or \
            (secret and info.st_mode & 0o007):
        raise ValueError("Unsafe account state path: " + str(path))
    return info


def read(path, limit=16384, secret=False):
    trusted(path, secret=secret)
    with path.open("rb") as source:
        contents = source.read(limit + 1)
    if len(contents) > limit:
        raise ValueError("Account state exceeds its size limit: " + str(path))
    return contents.decode("utf8")


def atomic(path, text, mode=0o644):
    trusted(path.parent, directory=True)
    fd, name = tempfile.mkstemp(prefix="." + path.name + "-", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(fd, "wb") as target:
            target.write(text.encode("utf8"))
            target.flush()
            os.fchmod(target.fileno(), mode)
            os.fsync(target.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_DIRECTORY | os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


@contextmanager
def state_lock(root=ROOT, timeout=60):
    trusted(root, directory=True)
    descriptor = os.open(root / ".state.lock",
                         os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or \
                stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1:
            raise ValueError("Unsafe account state lock")
        deadline = time.monotonic() + timeout
        while True:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError as error:
                if error.errno not in (errno.EAGAIN, errno.EWOULDBLOCK):
                    raise
                if time.monotonic() >= deadline:
                    raise TimeoutError("Account state is busy; no configuration change was committed") from error
                time.sleep(min(0.05, max(0, deadline - time.monotonic())))
        yield
    finally:
        os.close(descriptor)


def parse_config(text):
    result = json.loads(text)
    version = result.get("schemaVersion") if isinstance(result, dict) else None
    field = "persistentUuid" if version == 3 else "homeUuid"
    if not isinstance(result, dict) or set(result) != {"schemaVersion", field, "automaticLogin", "initialized"} or \
            type(version) is not int or version not in (2, 3) or \
            type(result["automaticLogin"]) is not bool or \
            type(result["initialized"]) is not bool or \
            not isinstance(result[field], str) or \
            not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", result[field]):
        raise ValueError("Unsupported or invalid account configuration")
    return result


def config(root=ROOT):
    return parse_config(read(root / "config.json"))


def backing_store():
    if STORAGE_PROGRAM.exists() or STORAGE_PROGRAM.is_symlink() or \
            STORAGE_MANIFEST.exists() or STORAGE_MANIFEST.is_symlink():
        for path in (STORAGE_PROGRAM.parent.parent, STORAGE_PROGRAM.parent):
            trusted(path, directory=True)
        trusted(STORAGE_PROGRAM)
        trusted(STORAGE_PROGRAM.with_name("layout.py"))
        spec = importlib.util.spec_from_file_location("polly_account_storage", STORAGE_PROGRAM)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        state = module.Storage()
        state.check()
        if state.contract["users"][:2] != [
                {"name": "root", "uid": 0, "gid": 0}, {"name": "polly", "uid": 1000, "gid": 1000}]:
            raise ValueError("Primary account rename requires the explicit identity migration")
        return state.persistent / "SystemData/Accounts", state.persistent, state.volumes["PERSISTENT"], 3
    return DATA, Path("/home"), read(UUID_FILE, 64).strip(), 2


def state_volume(settings, expected, version):
    field = "persistentUuid" if version == 3 else "homeUuid"
    if settings["schemaVersion"] != version or settings.get(field) != expected:
        raise ValueError("Persistent account state belongs to a different layout or volume")


def identities(text):
    records = {}
    for line in text.splitlines():
        fields = line.split(":")
        if fields[0] not in {"root", "polly"}:
            continue
        if len(fields) != 7 or fields[0] in records:
            raise ValueError("Invalid installed account identity")
        expected = "0" if fields[0] == "root" else "1000"
        if fields[1] != "x" or fields[2:4] != [expected, expected]:
            raise ValueError("Installed account UID/GID changed")
        records[fields[0]] = line
    if set(records) != {"root", "polly"}:
        raise ValueError("Missing installed account identity")
    return records


def password_records(text, usable=False):
    records = {}
    for line in text.splitlines():
        fields = line.split(":")
        if len(fields) != 9 or fields[0] not in {"root", "polly"} or fields[0] in records:
            raise ValueError("Invalid persistent shadow database")
        if usable and not re.fullmatch(r"\$(?:y|6)\$[^\s:]{1,500}", fields[1]):
            raise ValueError("Both accounts require usable nonempty passwords")
        records[fields[0]] = fields
    if set(records) != {"root", "polly"}:
        raise ValueError("Missing persistent account password")
    return records


def passwords(root=ROOT, usable=False, *, shadow_gid=None):
    records = password_records(read(root / "etc/shadow", secret=True), usable)
    expected = grp.getgrnam("shadow").gr_gid if shadow_gid is None else shadow_gid
    if type(expected) is not int or expected < 0 or \
            trusted(root / "etc/shadow", secret=True).st_gid != expected:
        raise ValueError("Persistent shadow group does not match this system")
    return records


def completed(root=ROOT):
    initialized = config(root)["initialized"]
    marker = root / "setup-complete"
    if not marker.exists() and not marker.is_symlink():
        return initialized
    if read(marker, 32) != "1\n":
        raise ValueError("Invalid setup completion marker")
    if not initialized:
        raise ValueError("Setup marker disagrees with the authoritative configuration")
    return initialized


def require_ready(require_complete=True):
    data, volume, expected, version = backing_store()
    for path in (volume, data.parent, data, ROOT, ROOT / "etc", RUNTIME):
        trusted(path, directory=True)
    state_volume(config(), expected, version)
    if read(RUNTIME / "ready", 64).strip() != expected:
        raise ValueError("Account state does not match the required user volume")
    for source, target in ((data, ROOT), (data / "etc", Path("/var/lib/extrausers"))):
        mounted = subprocess.run(["/usr/bin/findmnt", "-rn", "-M", str(target)],
                                 capture_output=True, text=True, timeout=10)
        if mounted.returncode != 0 or not os.path.samestat(source.stat(), target.stat()):
            raise ValueError("Required account bind mount is missing or mismatched")
    identities(read(ROOT / "etc/passwd"))
    passwords()
    if require_complete and not completed():
        raise ValueError("First-run setup is not complete")


def bind(source, target):
    trusted(source, directory=True)
    target.mkdir(mode=0o755, parents=True, exist_ok=True)
    trusted(target, directory=True)
    mounted = subprocess.run(["/usr/bin/findmnt", "-rn", "-M", str(target)],
                             capture_output=True, text=True, timeout=10)
    if mounted.returncode == 0:
        if not os.path.samestat(source.stat(), target.stat()):
            raise ValueError("Refusing to replace an unexpected account mount")
    elif mounted.returncode == 1:
        subprocess.run(["/usr/bin/mount", "--bind", str(source), str(target)],
                       check=True, timeout=10)
    else:
        raise ValueError("Cannot inspect the required account mount: " + mounted.stderr.strip())


def prepare():
    data, volume, expected, version = backing_store()
    mounted = subprocess.run(["/usr/bin/findmnt", "-rn", "-M", str(volume), "-o", "UUID,FSTYPE,OPTIONS"],
                             check=True, capture_output=True, text=True, timeout=10).stdout.split()
    if len(mounted) != 3 or mounted[:2] != [expected, "ext4"] or "rw" not in mounted[2].split(","):
        raise ValueError("Required writable ext4 user volume is missing or mismatched")
    for path in (volume, data.parent, data, data / "etc"):
        trusted(path, directory=True)
    with state_lock(data):
        settings = config(data)
        state_volume(settings, expected, version)
        records = identities(read(Path("/etc/passwd")))
        identities(read(data / "etc/passwd"))
        passwords(data)
        if completed(data) and not (data / "setup-complete").exists():
            atomic(data / "setup-complete", "1\n")
        atomic(data / "etc/passwd", records["root"] + "\n" + records["polly"] + "\n")
        bind(data, ROOT)
        bind(data / "etc", Path("/var/lib/extrausers"))
        RUNTIME.mkdir(mode=0o700, exist_ok=True)
        trusted(RUNTIME, directory=True)
        atomic(RUNTIME / "ready", expected + "\n", 0o600)
        atomic(RUNTIME / "automatic-login", "on\n" if settings["automaticLogin"] else "off\n", 0o600)
        if "polly.serial=1" in Path("/proc/cmdline").read_text().split():
            dropin = Path("/run/systemd/system/polly-firstboot.service.d")
            dropin.mkdir(parents=True, exist_ok=True)
            atomic(dropin / "serial.conf", "[Service]\nTTYPath=/dev/ttyS0\n")
            subprocess.run(["/usr/bin/systemctl", "daemon-reload"], check=True, timeout=20)
    print("POLLY_ACCOUNTS_READY", flush=True)


def finish():
    require_ready(False)
    passwords(usable=True)
    settings = config()
    settings["initialized"] = True
    atomic(ROOT / "config.json", json.dumps(settings, sort_keys=True) + "\n")
    atomic(ROOT / "setup-complete", "1\n")
    print("POLLY_SETUP_COMPLETE", flush=True)


def password_scope(user):
    if user is None:
        raise ValueError("Missing PAM password target")
    if user not in {"root", "polly"}:
        return
    if not Path("/config.json").is_file():
        raise ValueError("Managed password changes require the persistent passwd entry")
    config(Path("/"))
    identities(read(Path("/etc/passwd")))
    passwords(Path("/"))


def setup():
    require_ready(False)
    with state_lock():
        require_ready(False)
        if completed():
            if not (ROOT / "setup-complete").exists():
                atomic(ROOT / "setup-complete", "1\n")
            print("PollyDesktop setup is already complete.", flush=True)
            return
        if not sys.stdin.isatty():
            raise ValueError("First-run setup requires a local interactive terminal")
        print("PollyDesktop first-run setup.\nSet separate polly and root passwords locally.\n"
              "No default password is provided. Cancelling keeps normal login disabled.", flush=True)
        for name in ("polly", "root"):
            print("Setting " + name + " password.", flush=True)
            subprocess.run(["/usr/bin/passwd", name], check=True)
        finish()


def set_automatic_login(enabled):
    require_ready()
    with state_lock():
        require_ready()
        settings = config()
        settings["automaticLogin"] = enabled
        atomic(ROOT / "config.json", json.dumps(settings, sort_keys=True) + "\n")


def getty(tty):
    require_ready()
    if tty != "tty1":
        raise ValueError("Unsupported installed desktop terminal")
    args = ["/sbin/agetty", "--noclear"]
    boot_policy = read(RUNTIME / "automatic-login", 16)
    if boot_policy not in {"on\n", "off\n"}:
        raise ValueError("Invalid boot login policy")
    automatic = False
    if boot_policy == "on\n":
        try:
            fd = os.open(RUNTIME / "autologin-used", os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        except FileExistsError:
            trusted(RUNTIME / "autologin-used")
        else:
            os.close(fd)
            args += ["--autologin", "polly"]
            automatic = True
    if not automatic:
        args += ["--skip-login", "--login-options", "-- polly"]
    syslog.syslog(syslog.LOG_AUTH | syslog.LOG_NOTICE,
                  "POLLY_LOGIN_CONSOLE_READY mode=" + ("automatic" if automatic else "password"))
    os.execv(args[0], [*args, tty, "linux"])


def main():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    if os.geteuid() != 0:
        raise PermissionError("This account operation requires root")
    login_auth = os.environ.get("PAM_SERVICE") == "login" and os.environ.get("PAM_TYPE") == "auth"
    password_user = os.environ.get("PAM_USER")
    os.environ.clear()
    os.environ.update(PATH="/usr/sbin:/usr/bin:/sbin:/bin", LANG="C.UTF-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["prepare", "setup", "check", "check-storage", "autologin", "getty", "password-scope"])
    parser.add_argument("value", nargs="?")
    args = parser.parse_args()
    if args.operation == "prepare" and args.value is None:
        prepare()
    elif args.operation == "setup" and args.value is None:
        setup()
    elif args.operation == "check" and args.value is None:
        require_ready()
        if login_auth:
            syslog.syslog(syslog.LOG_AUTH | syslog.LOG_NOTICE, "POLLY_LOGIN_AUTH_PENDING")
    elif args.operation == "check-storage" and args.value is None:
        require_ready(False)
    elif args.operation == "password-scope" and args.value is None:
        password_scope(password_user)
    elif args.operation == "autologin" and args.value in {"on", "off"}:
        set_automatic_login(args.value == "on")
        print("Automatic login " + args.value + " (next boot only).")
    elif args.operation == "getty" and args.value is not None:
        getty(args.value)
    else:
        parser.error("Invalid account operation arguments")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print("PollyDesktop account operation failed: " + str(error), file=sys.stderr)
        sys.exit(1)
