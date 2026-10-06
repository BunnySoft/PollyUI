#!/usr/bin/env python3
"""Exercise PAM only in a disposable root-owned test container."""
import os
from pathlib import Path
import pwd
import secrets
import shutil
import socket
import struct
import subprocess
import sys
import tempfile


MAGIC = 0x50414D31


def authenticate(program, password, expected, serial):
    parent, child = socket.socketpair()
    parent.settimeout(15)

    def child_setup():
        os.dup2(child.fileno(), 3)

    process = subprocess.Popen([program], preexec_fn=child_setup, pass_fds=(parent.fileno(), child.fileno(), 3),
                               stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    child.close()
    try:
        payload = password.encode()
        result = b""
        try:
            parent.sendall(struct.pack("=III", MAGIC, serial, len(payload)) + payload)
            while len(result) < 16:
                part = parent.recv(16 - len(result))
                if not part:
                    break
                result += part
        except (BrokenPipeError, ConnectionResetError):
            if expected is not None:
                raise
        code = process.wait(timeout=15)
        if expected is None:
            assert code != 0 and not result, (code, result)
        else:
            assert code == 0 and len(result) == 16, (code, len(result))
            actual = struct.unpack("=IIII", result)
            assert actual[:3] == (MAGIC, serial, expected), (serial, expected, actual)
    finally:
        parent.close()
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)


def main():
    if os.getuid() != 0 or not Path("/run/.containerenv").exists():
        raise RuntimeError("This fixture must run only in its disposable Podman container")
    program = str(Path(sys.argv[1]).resolve())
    policy = Path("/etc/pam.d/polly-lock")
    if policy.exists():
        raise RuntimeError("Refusing to overwrite an existing PAM service")
    name = "polly-pam-fixture"
    try:
        pwd.getpwnam(name)
    except KeyError:
        pass
    else:
        raise RuntimeError("Refusing to modify an existing account")
    subprocess.run(["adduser", "-D", "-H", "-s", "/sbin/nologin", name], check=True)
    password = secrets.token_hex(24)
    subprocess.run(["chpasswd"], input=f"{name}:{password}\n", text=True,
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    policy.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile("desktop/system/polly-lock.pam", policy)
    policy.chmod(0o644)
    user = pwd.getpwnam(name)
    authenticate(program, password, None, 7)

    def child_cases(unavailable=False):
        pid = os.fork()
        if pid == 0:
            try:
                os.setgroups([])
                os.setgid(user.pw_gid)
                os.setuid(user.pw_uid)
                if unavailable:
                    authenticate(program, password, 2, 5)
                else:
                    authenticate(program, password, 0, 1)
                    authenticate(program, "wrong-" + password, 1, 2)
                    authenticate(program, "", None, 3)
                    authenticate(program, "embedded\0value", None, 4)
                    authenticate(program, "x" * 4097, None, 6)
                os._exit(0)
            except BaseException as error:
                print("FAIL: PAM helper fixture:", repr(error), file=sys.stderr, flush=True)
                os._exit(1)
        _, status = os.waitpid(pid, 0)
        assert os.waitstatus_to_exitcode(status) == 0

    child_cases()
    if len(sys.argv) == 5:
        with tempfile.TemporaryDirectory(prefix="polly-lock-auth-") as temporary:
            root = Path(temporary)
            root.chmod(0o700)
            os.chown(root, user.pw_uid, user.pw_gid)
            secret = root / "test-password"
            secret.write_text(password)
            secret.chmod(0o600)
            os.chown(secret, user.pw_uid, user.pw_gid)
            environment = {**os.environ, "HOME": temporary, "XDG_RUNTIME_DIR": temporary,
                           "XDG_CONFIG_HOME": str(root / "config"), "XDG_DATA_HOME": str(root / "data"),
                           "XDG_CACHE_HOME": str(root / "cache"), "WLR_BACKENDS": "headless",
                           "WLR_HEADLESS_OUTPUTS": "2", "WLR_RENDERER": "pixman",
                           "SDL_VIDEODRIVER": "wayland", "SDL_RENDER_DRIVER": "software", "PU_RENDERER": "raster"}
            def drop():
                os.setgroups([])
                os.setgid(user.pw_gid)
                os.setuid(user.pw_uid)
            result = subprocess.run([str(Path(sys.argv[2]).resolve()), str(Path(sys.argv[3]).resolve()),
                                     str(Path(sys.argv[4]).resolve()), str(Path("desktop/session/lock.mjs").resolve()), str(secret)],
                                    env=environment, preexec_fn=drop, timeout=40, capture_output=True, text=True)
            output = result.stdout + result.stderr
            assert result.returncode == 0, output
            assert not any(message in output for message in ["Uncaught ", "FAIL:", "AddressSanitizer",
                                                             "LeakSanitizer", "[lock] UI callback failed"]), output
            print("PASS: native masked input rejected a wrong password and completed PAM-backed unlock")
    policy.chmod(0o666)
    child_cases(unavailable=True)
    print("PASS: unprivileged PAM success/denial, bounded protocol, nonce and unsafe-policy rejection")


if __name__ == "__main__":
    main()
