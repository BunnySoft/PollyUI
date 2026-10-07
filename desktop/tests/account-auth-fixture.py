#!/usr/bin/python3 -I
"""Test-only real NSS/PAM/passwd/su fixture; never prints or persists plaintext passwords."""
import argparse
import errno
import hashlib
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import pty
import re
import secrets
import select
import string
import stat
import subprocess
import termios
import time
import fcntl
import sys


def load_accounts():
    loader = importlib.machinery.SourceFileLoader("polly_accounts", "/usr/sbin/polly-accounts")
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def interactive(command, replies=(), uid=0):
    master, slave = pty.openpty()

    def session():
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
        if uid and os.geteuid() == 0:
            os.setgroups([])
            os.setgid(uid)
            os.setuid(uid)
        elif uid and uid != os.geteuid():
            raise PermissionError("An ordinary fixture cannot select another identity")

    process = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave,
                               preexec_fn=session, env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin",
                                                        "LANG": "C.UTF-8"})
    pending, output, index = b"", b"", 0
    try:
        deadline = time.monotonic() + 40
        while process.poll() is None:
            if time.monotonic() > deadline:
                raise RuntimeError("Interactive authentication timed out; transcript withheld")
            readable, _, _ = select.select([master], [], [], 0.1)
            if not readable:
                continue
            try:
                chunk = os.read(master, 4096)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not chunk:
                break
            pending += chunk
            output += chunk
            if len(output) > 65536:
                raise RuntimeError("Authentication output exceeded its bound")
            if re.search(rb"(?i)password:\s*$", pending):
                if index >= len(replies):
                    raise RuntimeError("Unexpected password prompt; transcript withheld")
                if termios.tcgetattr(slave)[3] & termios.ECHO:
                    raise RuntimeError("Refusing to send a password while terminal echo is enabled")
                os.write(master, replies[index].encode("ascii") + b"\n")
                index += 1
                pending = b""
        result = process.wait(timeout=5)
        if result == 0 and index != len(replies):
            raise RuntimeError("Authentication did not consume the expected prompts")
        return result, output
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        os.close(master)
        os.close(slave)


def password():
    return "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(28))


def success(command, replies=(), uid=0):
    result, output = interactive(command, replies, uid)
    if result != 0:
        for reply in replies:
            output = output.replace(reply.encode("ascii"), b"[redacted]")
        diagnostics = re.findall(rb"(?:polly-passwd:|passwd:|PollyDesktop account operation failed:)[^\r\n]*", output)
        raise RuntimeError("Authentication fixture command failed: " + command[0] + "; " +
                           b"; ".join(diagnostics).decode("utf8", errors="replace"))


def root_su(token, expected=True):
    result, output = interactive(["/usr/bin/su", "-", "-c", "/usr/bin/id -u"], [token], 1000)
    accepted = result == 0 and re.search(rb"(?:^|[\r\n])0(?:[\r\n]|$)", output) is not None
    if accepted != expected:
        raise RuntimeError("Root-password su accepted/denied contrary to expectation")


def seed_container(repo):
    if not Path("/run/.containerenv").exists() or os.geteuid() != 0:
        raise RuntimeError("Container fixture refuses to modify a non-container or non-root environment")
    if any(line.split(":")[0] in {"root", "polly"} and
           not line.split(":")[1].startswith(("!", "*"))
           for line in Path("/etc/shadow").read_text().splitlines()):
        raise RuntimeError("Container fixture requires pristine locked accounts")
    subprocess.run(["mount", "-t", "tmpfs", "-o", "size=8m,nodev,nosuid,mode=0755", "tmpfs", "/home"], check=True)
    Path("/usr/sbin/polly-accounts").write_text(
        (repo / "desktop/release/install/accounts.py").read_text(), encoding="utf8", newline="\n")
    Path("/usr/sbin/polly-accounts").chmod(0o755)
    accounts = load_accounts()
    root = accounts.DATA
    (root / "etc").mkdir(parents=True)
    root.parent.chmod(0o700)
    for name in ("passwd", "shadow"):
        lines = [line for line in Path("/etc", name).read_text().splitlines()
                 if line.split(":")[0] in {"root", "polly"}]
        accounts.atomic(root / "etc" / name, "\n".join(lines) + "\n", 0o640 if name == "shadow" else 0o644)
    os.chown(root / "etc/shadow", 0, accounts.grp.getgrnam("shadow").gr_gid)
    accounts.atomic(root / "etc/group", "root:x:0:\npolly:x:1000:\nshadow:x:" +
                    str(accounts.grp.getgrnam("shadow").gr_gid) + ":\n")
    accounts.atomic(root / "etc/nsswitch.conf", "passwd: files\ngroup: files\nshadow: files\n")
    identifier = "73c3d806-e114-4691-b1a7-8506c7a44e21"
    accounts.atomic(root / "config.json", json.dumps({
        "schemaVersion": 2, "homeUuid": identifier, "automaticLogin": False, "initialized": False,
    }) + "\n")
    accounts.atomic(accounts.UUID_FILE, identifier + "\n")
    accounts.bind(root, accounts.ROOT)
    accounts.bind(root / "etc", Path("/var/lib/extrausers"))
    accounts.RUNTIME.mkdir(mode=0o700)
    accounts.atomic(accounts.RUNTIME / "ready", identifier + "\n", 0o600)
    accounts.atomic(accounts.RUNTIME / "automatic-login", "off\n", 0o600)
    nss = Path("/etc/nsswitch.conf")
    accounts.atomic(nss, re.sub(r"^shadow:.*$", "shadow: extrausers files", nss.read_text(), flags=re.M))
    accounts.atomic(Path("/etc/pam.d/common-auth"),
                    "auth requisite pam_exec.so quiet seteuid /usr/sbin/polly-accounts check\n"
                    "auth required pam_unix.so\n")
    password_policy = Path("/etc/pam.d/common-password")
    accounts.atomic(password_policy,
                    "password requisite pam_exec.so quiet seteuid /usr/sbin/polly-accounts password-scope\n" +
                    password_policy.read_text())
    return accounts


def verify(accounts, guest):
    accounts.require_ready(False)
    if Path("/usr/bin/passwd.distrib").stat().st_mode & stat.S_ISUID:
        raise RuntimeError("Distribution passwd must not bypass the persistent setuid entry")
    retained = accounts.ROOT / "fixture-state.json"
    count = 1
    if retained.exists():
        old = json.loads(accounts.read(retained, secret=True))
        current = hashlib.sha256(accounts.read(accounts.ROOT / "etc/shadow", secret=True).encode()).hexdigest()
        if old["shadowDigest"] != current or not accounts.completed() or \
                accounts.config()["automaticLogin"] is not True:
            raise RuntimeError("Account/password/login policy was not retained across the cold boot")
        count = old["count"] + 1
    first, second, root_first, root_second = password(), password(), password(), password()
    if not accounts.completed():
        result, _ = interactive(["/usr/bin/su", "-", "-c", "/usr/bin/id -u"], uid=1000)
        if result == 0:
            raise RuntimeError("Uninitialized accounts allowed ordinary-user su")
        success(["/usr/sbin/polly-accounts", "setup"], [first, first, root_first, root_first])
    else:
        success(["/usr/bin/passwd", "polly"], [first, first])
        success(["/usr/bin/passwd", "root"], [root_first, root_first])
        success(["/usr/sbin/polly-accounts", "setup"])
    accounts.require_ready()
    root_su(password(), False)
    root_su(root_first)
    success(["/usr/bin/passwd"], [first, second, second], 1000)
    result, _ = interactive(["/usr/bin/passwd", "root"], uid=1000)
    if result == 0:
        raise RuntimeError("Ordinary passwd changed root without root authority")
    success(["/usr/bin/passwd", "root"], [root_second, root_second])
    root_su(root_first, False)
    root_su(root_second)
    visible = subprocess.run(["/usr/bin/getent", "shadow", "polly"], check=True,
                             capture_output=True, text=True, timeout=10).stdout
    if visible.strip() != ":".join(accounts.passwords()["polly"]):
        raise RuntimeError("NSS did not expose the latest shared password record")
    denied = subprocess.run(["/usr/bin/getent", "shadow", "polly"],
                            user=1000, group=1000, extra_groups=[], capture_output=True, timeout=10)
    if b"$y$" in denied.stdout or b"$6$" in denied.stdout:
        raise RuntimeError("Ordinary process read a private password hash")
    success(["/usr/sbin/polly-accounts", "autologin", "on"])
    if guest:
        accounts.atomic(accounts.RUNTIME / "automatic-login", "on\n", 0o600)
    digest = hashlib.sha256(accounts.read(accounts.ROOT / "etc/shadow", secret=True).encode()).hexdigest()
    accounts.atomic(retained, json.dumps({"count": count, "shadowDigest": digest}) + "\n", 0o600)
    slot = Path("/etc/polly-system-slot").read_text().strip() if guest else "container"
    print(f"POLLY_ACCOUNT_AUTH_PASS count={count} slot={slot}", flush=True)


def console_message(message):
    subprocess.run(["/usr/bin/logger", "-t", "polly-account-console", message],
                   check=True, timeout=10)


def console_password(index, count):
    descriptor = sys.stdin.fileno()
    if not os.isatty(descriptor):
        raise RuntimeError("Console fixture requires its authenticated controlling terminal")
    original = termios.tcgetattr(descriptor)
    quiet = list(original)
    quiet[3] &= ~(termios.ECHO | termios.ECHONL)
    termios.tcsetattr(descriptor, termios.TCSAFLUSH, quiet)
    try:
        console_message(f"POLLY_AUTH_SECRET_PENDING index={index} round={count}")
        token = sys.stdin.readline(256).rstrip("\n")
        if not re.fullmatch(r"[a-z0-9]{28}", token):
            raise RuntimeError("Invalid console fixture secret; input withheld")
        return token
    finally:
        termios.tcsetattr(descriptor, termios.TCSAFLUSH, original)


def console_authenticate(user, token, expected=True):
    command = ["/usr/bin/su", "-", "-c", "/usr/bin/id -u"] if user == "root" else [
        "/usr/bin/su", "polly", "-s", "/bin/sh", "-c", "/usr/bin/id -u"]
    result, output = interactive(command, [token])
    uid = b"0" if user == "root" else b"1000"
    accepted = result == 0 and re.search(rb"(?:^|[\r\n])" + uid + rb"(?:[\r\n]|$)", output) is not None
    if accepted != expected:
        raise RuntimeError("Console PAM accepted/denied credentials contrary to expectation")


def console_data(first):
    home = Path.home()
    if home != Path("/home/polly") or not os.path.samestat(home.stat(), Path("/Users/1000").stat()):
        raise RuntimeError("Console HOME does not reference the stable UID authority")
    expected = {"XDG_CONFIG_HOME": "Settings", "XDG_DATA_HOME": "AppData",
                "XDG_STATE_HOME": "AppState", "XDG_CACHE_HOME": "Cache"}
    for variable, name in expected.items():
        if os.environ.get(variable) != str(home / name):
            raise RuntimeError("Console XDG path disagrees with its user authority")
    for name in ("Settings", "AppData", "AppState", "Documents"):
        directory = home / name
        if directory.is_symlink() or not directory.is_dir() or directory.stat().st_uid != 1000:
            raise RuntimeError("User data directory has an unexpected identity")
        probe = directory / ".polly-account-persistence"
        content = "ordinary-user retained probe: " + name + "\n"
        if first:
            with probe.open("x") as destination:
                os.fchmod(destination.fileno(), 0o600)
                destination.write(content)
                destination.flush()
                os.fsync(destination.fileno())
        elif probe.is_symlink() or not probe.is_file() or probe.read_text() != content or \
                probe.stat().st_uid != 1000 or stat.S_IMODE(probe.stat().st_mode) != 0o600:
            raise RuntimeError("Committed user data did not survive the clean restart")


def verify_console(first, count):
    cmdline = Path("/proc/cmdline").read_text().split()
    if os.getuid() != 1000 or os.geteuid() != 1000 or \
            "polly.mode=console" not in cmdline or "polly.serial=1" not in cmdline:
        raise RuntimeError("Console fixture requires normal polly authentication, not a root test service")
    old_user, old_root, new_user, new_root = [console_password(index, count) for index in range(4)]
    console_data(first)
    if first:
        console_authenticate("polly", old_user)
        console_authenticate("root", old_root)
        success(["/usr/bin/passwd"], [old_user, new_user, new_user])
        result, _ = interactive(["/usr/bin/passwd", "root"])
        if result == 0:
            raise RuntimeError("Ordinary passwd changed root without root authentication")
        success(["/usr/bin/su", "-", "-c", "/usr/bin/passwd root"],
                [old_root, new_root, new_root])
    console_authenticate("polly", old_user, False)
    console_authenticate("polly", new_user)
    console_authenticate("root", old_root, False)
    console_authenticate("root", new_root)
    denied = subprocess.run(["/usr/bin/getent", "shadow", "polly"],
                            capture_output=True, timeout=10)
    if b"$y$" in denied.stdout or b"$6$" in denied.stdout:
        raise RuntimeError("Ordinary console process read a private password hash")
    console_message(f"POLLY_ACCOUNT_CONSOLE_PASS round={count} uid=1000 changed={int(first)}")
    fixture = Path.home() / "Cache/.polly-account-console.b64"
    fixture.unlink()
    success(["/usr/bin/su", "-", "-c", "/usr/bin/systemctl poweroff"], [new_root])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--container", type=Path)
    parser.add_argument("--guest", action="store_true")
    parser.add_argument("--console", choices=("first", "retained"))
    parser.add_argument("--round", type=int, default=1)
    args = parser.parse_args()
    if args.console is not None:
        if args.container is not None or args.guest or not 1 <= args.round <= 3:
            parser.error("Console acceptance cannot be mixed with root fixture modes")
        try:
            verify_console(args.console == "first", args.round)
        except (OSError, RuntimeError, subprocess.SubprocessError) as error:
            console_message("POLLY_ACCOUNT_CONSOLE_FAILED: " + str(error))
            raise
        return
    if args.container is not None and not args.guest:
        accounts = seed_container(args.container)
    elif args.guest and args.container is None:
        if "polly.verify-persistence=1" not in Path("/proc/cmdline").read_text().split():
            raise RuntimeError("Guest account fixture requires its explicit test-only boot mode")
        accounts = load_accounts()
    else:
        parser.error("Select exactly one isolated container or test guest mode")
    verify(accounts, args.guest)


if __name__ == "__main__":
    main()
