#!/usr/bin/python3 -I
"""Real passwd/PAM/greetd fixture in a marked rootless container; not seat/GUI acceptance."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import resource
import secrets
import select
import shutil
import signal
import socket
import stat
import struct
import subprocess
import sys
import time

FIXTURE = Path("/run/polly-graphical-auth-fixture")
UID = 991


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def exact(channel, length):
    result = bytearray(length)
    offset = 0
    while offset < length:
        count = channel.recv_into(memoryview(result)[offset:])
        if not count:
            raise RuntimeError("Fixture channel disconnected")
        offset += count
    return result


def ipc(channel, request):
    data = json.dumps(request).encode()
    channel.sendall(struct.pack("=I", len(data)) + data)
    length, = struct.unpack("=I", exact(channel, 4))
    if not 0 < length < 16384:
        raise RuntimeError("greetd fixture response exceeded its bound")
    return json.loads(exact(channel, length))


def conversation(channel, username, token):
    reset = ipc(channel, {"type": "cancel_session"})
    if reset["type"] == "error":
        reset = ipc(channel, {"type": "cancel_session"})
    if reset["type"] != "success":
        raise RuntimeError("greetd did not confirm cancellation of the preceding attempt")
    response = ipc(channel, {"type": "create_session", "username": username})
    supplied = False
    for _ in range(16):
        if response["type"] != "auth_message":
            return response, supplied
        kind = response["auth_message_type"]
        if kind == "secret" and not supplied:
            supplied = True
            answer = token.decode()
        elif kind in ("info", "error"):
            answer = None
        else:
            raise RuntimeError("Unexpected PAM prompt (contents withheld)")
        response = ipc(channel, {"type": "post_auth_message_response", "response": answer})
        answer = None
    raise RuntimeError("PAM conversation exceeded the fixture bound")


def greeter():
    if os.getuid() != UID or os.geteuid() != UID or not FIXTURE.is_dir():
        raise RuntimeError("Fixture greeter requires its synthetic ordinary account")
    tokens = socket.socket(socket.AF_UNIX)
    tokens.settimeout(20)
    tokens.connect(str(FIXTURE / "tokens.sock"))
    first, second = struct.unpack("=II", exact(tokens, 8))
    if not 0 < first <= 1024 or not 0 < second <= 1024:
        raise RuntimeError("Invalid synthetic token bound")
    polly, root = exact(tokens, first), exact(tokens, second)
    tokens.close()
    channel = socket.socket(socket.AF_UNIX)
    channel.settimeout(20)
    channel.connect(os.environ["GREETD_SOCK"])
    try:
        result, supplied = conversation(channel, "polly", b"synthetic-wrong-" + polly)
        if result["type"] != "error" or result["error_type"] != "auth_error" or not supplied:
            raise RuntimeError("Real greetd/PAM failed to reject the wrong password")
        result, _ = conversation(channel, "root", root)
        if result["type"] != "error" or result["error_type"] != "auth_error":
            raise RuntimeError("Real greetd/PAM allowed a graphical root account")
        result, supplied = conversation(channel, "polly", polly)
        if result["type"] != "success" or not supplied:
            raise RuntimeError("Real greetd/PAM did not authenticate the installed polly password")
        result = ipc(channel, {"type": "start_session",
            "cmd": ["/usr/bin/python3", "-I", "-B", "/usr/lib/polly-graphical-auth-fixture.py", "--user"],
            "env": ["XDG_SESSION_TYPE=wayland", "XDG_CURRENT_DESKTOP=Polly"]})
        if result["type"] != "success":
            raise RuntimeError("Real greetd did not schedule the user session")
        print("POLLY_GREETD_PAM_AUTH_PASS wrong-denied=1 root-denied=1 greeter-uid=991", flush=True)
    finally:
        polly[:] = b"\0" * len(polly)
        root[:] = b"\0" * len(root)
        channel.close()


def user_session():
    if os.getuid() != 1000 or os.geteuid() != 1000 or os.getgid() != 1000:
        raise RuntimeError("greetd did not drop to the actual ordinary polly identity")
    if os.environ.get("XDG_SESSION_TYPE") != "wayland" or os.environ.get("XDG_CURRENT_DESKTOP") != "Polly":
        raise RuntimeError("greetd did not apply the fixed session flags")
    print("POLLY_GREETD_USER_PASS uid=1000 gid=1000 type=wayland desktop=Polly logind-tested=0", flush=True)
    time.sleep(0.2)


def setup_round(accounts, broker, first, second, ending, deny_uid=False):
    greeter_gid = pwd.getpwnam("polly-greeter").pw_gid
    path = FIXTURE / "setup.sock"
    path.unlink(missing_ok=True)
    listener = socket.socket(socket.AF_UNIX)
    listener.bind(str(path))
    os.chown(path, UID, greeter_gid)
    path.chmod(0o600)
    listener.listen(1)
    worker = os.fork()
    if worker == 0:
        try:
            channel, _ = listener.accept()
            listener.close()
            with channel:
                def authority(value):
                    _, uid, gid = struct.unpack("=iII", value.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                    if uid != UID or gid != greeter_gid:
                        raise PermissionError("Fixture setup denied the kernel peer identity")
                broker.transaction(channel, accounts, authority)
            os._exit(0)
        except BaseException:
            print("Fixture setup worker failed (details withheld).", file=sys.stderr, flush=True)
            os._exit(1)
    client = os.fork()
    if client == 0:
        try:
            listener.close()
            if not deny_uid:
                os.setgroups([])
                os.setgid(greeter_gid)
                os.setuid(UID)
            channel = socket.socket(socket.AF_UNIX)
            channel.settimeout(50)
            channel.connect(str(path))
            if deny_uid:
                channel.sendall(broker.REQUEST.pack(broker.MAGIC, broker.STATUS, 0, 0))
                _, result = broker.REPLY.unpack(exact(channel, broker.REPLY.size))
                if result != broker.UNAVAILABLE:
                    raise RuntimeError("Fixture root peer was incorrectly admitted")
            else:
                channel.sendall(broker.REQUEST.pack(broker.MAGIC, broker.SETUP, len(first), len(second)) + first + second)
                expected = [broker.POLLY, broker.ROOT, broker.POLICY] if ending == "policy" else \
                    [broker.POLLY, broker.ROOT, broker.PREPARED] if ending in ("cancel", "commit") else [broker.UNAVAILABLE]
                for wanted in expected:
                    magic, result = broker.REPLY.unpack(exact(channel, broker.REPLY.size))
                    if magic != broker.MAGIC or result != wanted:
                        raise RuntimeError("Unexpected first-run result: " + str(result))
                if ending in ("cancel", "commit"):
                    operation = broker.CANCEL if ending == "cancel" else broker.COMMIT
                    channel.sendall(broker.REQUEST.pack(broker.MAGIC, operation, 0, 0))
                    for wanted in ([broker.CANCELLED] if ending == "cancel" else [broker.COMMITTING, broker.COMPLETE]):
                        _, result = broker.REPLY.unpack(exact(channel, broker.REPLY.size))
                        if result != wanted:
                            raise RuntimeError("Unexpected commit/cancel result: " + str(result))
            channel.close()
            os._exit(0)
        except BaseException as error:
            print("Fixture ordinary setup client failed: " + type(error).__name__, file=sys.stderr, flush=True)
            os._exit(1)
    listener.close()
    try:
        for pid in (client, worker):
            _, status = os.waitpid(pid, 0)
            if os.waitstatus_to_exitcode(status):
                raise RuntimeError("Actual first-run fixture process failed")
    finally:
        path.unlink(missing_ok=True)


def native_setup(accounts, broker, first, second):
    greeter_gid = pwd.getpwnam("polly-greeter").pw_gid
    Path("/run/polly-greeter").mkdir(mode=0o755)
    listener = socket.socket(socket.AF_UNIX)
    listener.bind(broker.SOCKET)
    os.chown(broker.SOCKET, UID, greeter_gid)
    Path(broker.SOCKET).chmod(0o600)
    listener.listen(1)
    worker = os.fork()
    if worker == 0:
        try:
            while True:
                channel, _ = listener.accept()
                with channel:
                    def authority(value):
                        _, uid, gid = struct.unpack("=iII", value.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                        if (uid, gid) != (UID, greeter_gid):
                            raise PermissionError("Fixture native setup requires its real ordinary peer")
                    broker.transaction(channel, accounts, authority)
        except BaseException:
            os._exit(1)
    listener.close()
    tokens = socket.socket(socket.AF_UNIX)
    tokens.bind(str(FIXTURE / "tokens.sock"))
    os.chown(FIXTURE / "tokens.sock", UID, greeter_gid)
    (FIXTURE / "tokens.sock").chmod(0o600)
    tokens.listen(1)
    tokens.settimeout(20)
    def drop():
        os.setgroups([])
        os.setgid(greeter_gid)
        os.setuid(UID)
    process = subprocess.Popen(["/usr/bin/polly-greeter-client-fixture", "--setup"],
                               stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               close_fds=True, preexec_fn=drop,
                               env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"})
    try:
        channel, _ = tokens.accept()
        with channel:
            channel.sendall(struct.pack("=II", len(first), len(second)) + first + second)
        output, _ = process.communicate(timeout=90)
        if process.returncode or b"POLLY_NATIVE_SETUP_CLIENT_PASS" not in output:
            print("NATIVE SETUP DIAGNOSTIC: " +
                  output.replace(first, b"[redacted]").replace(second, b"[redacted]").decode("utf8", errors="replace"),
                  file=sys.stderr, flush=True)
            raise RuntimeError("Actual native client did not cancel/commit first-run state correctly")
        print("POLLY_NATIVE_SETUP_FIXTURE_PASS actual-client-uid=991 real-passwd=1 cancel-uninitialized=1 "
              "commit=1 seat-tested=0 gui-tested=0", flush=True)
    finally:
        tokens.close()
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        os.kill(worker, signal.SIGTERM)
        os.waitpid(worker, 0)
        Path(broker.SOCKET).unlink(missing_ok=True)


def run_greetd(repo, first, second, native=False, evidence=None):
    greeter_gid = pwd.getpwnam("polly-greeter").pw_gid
    policy = (repo / "desktop/session/polly-greetd.pam").read_text()
    policy = policy.replace("session required pam_systemd.so type=wayland",
                            "session required pam_exec.so quiet /usr/lib/polly-graphical-auth-session-marker")
    Path("/etc/pam.d/polly-greetd-fixture").write_text(policy)
    greeter_policy = (repo / "desktop/session/polly-greetd-greeter.pam").read_text().replace(
        "session required pam_systemd.so type=wayland",
        "session required pam_exec.so quiet /usr/lib/polly-graphical-auth-session-marker")
    Path("/etc/pam.d/polly-greetd-greeter-fixture").write_text(greeter_policy)
    marker = Path("/usr/lib/polly-graphical-auth-session-marker")
    marker.write_text('#!/bin/sh\nset -eu\nprintf "%s %s %s class=%s\\n" "$PAM_SERVICE" "$PAM_TYPE" '
                      '"$PAM_USER" "${XDG_SESSION_CLASS:-missing}" >> '
                      '/run/polly-graphical-auth-fixture/pam-events\n')
    marker.chmod(0o755)
    shutil.copyfile(__file__, "/usr/lib/polly-graphical-auth-fixture.py")
    Path("/usr/lib/polly-graphical-auth-fixture.py").chmod(0o644)
    command = "/usr/bin/python3 -I -B /usr/lib/polly-graphical-auth-fixture.py --greeter"
    expected_marker = b"POLLY_GREETD_PAM_AUTH_PASS"
    if native:
        command = "/usr/bin/polly-greeter-client-fixture"
        expected_marker = b"POLLY_GREETD_NATIVE_CLIENT_PASS"
        Path("/usr/bin/polly-installed-session").write_text(
            "#!/bin/sh\nexec /usr/bin/python3 -I -B /usr/lib/polly-graphical-auth-fixture.py --user\n")
        Path("/usr/bin/polly-installed-session").chmod(0o755)
    events_file = FIXTURE / "pam-events"
    old_events = events_file.read_text() if events_file.exists() else ""
    user_open = "polly-greetd-fixture open_session polly class=user\n"
    user_close = "polly-greetd-fixture close_session polly class=missing\n"
    greeter_open = "polly-greetd-greeter-fixture open_session polly-greeter class=greeter\n"
    old_closed = old_events.count(user_close)
    old_user_open = old_events.count(user_open)
    old_greeter_open = old_events.count(greeter_open)
    config = FIXTURE / "greetd.conf"
    config.write_text('[terminal]\nvt = "none"\n[general]\nsource_profile = false\n'
                      'service = "polly-greetd-fixture"\nrunfile = "/run/polly-graphical-auth-fixture/greetd-used"\n'
                      '[default_session]\nuser = "polly-greeter"\nservice = "polly-greetd-greeter-fixture"\n'
                      'command = "' + command + '"\n')
    (FIXTURE / "tokens.sock").unlink(missing_ok=True)
    tokens = socket.socket(socket.AF_UNIX)
    tokens.bind(str(FIXTURE / "tokens.sock"))
    os.chown(FIXTURE / "tokens.sock", UID, greeter_gid)
    (FIXTURE / "tokens.sock").chmod(0o600)
    tokens.listen(1)
    tokens.settimeout(20)
    process = subprocess.Popen(["/usr/sbin/greetd", "--config", str(config)], stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, close_fds=True,
                               env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"},
                               start_new_session=True)
    output = bytearray()
    try:
        try:
            channel, _ = tokens.accept()
        except TimeoutError:
            if process.poll() is not None:
                output.extend(process.stdout.read(32768))
            raise RuntimeError("greetd did not establish the fixture greeter session")
        with channel:
            _, uid, gid = struct.unpack("=iII", channel.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if (uid, gid) != (UID, greeter_gid):
                raise RuntimeError("greetd did not launch the actual unprivileged greeter")
            channel.sendall(struct.pack("=II", len(first), len(second)) + first + second)
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline:
            if select.select([process.stdout], [], [], 0.1)[0]:
                block = os.read(process.stdout.fileno(), 4096)
                if not block:
                    break
                output.extend(block)
                if len(output) > 32768:
                    raise RuntimeError("greetd diagnostic bound exceeded")
            if b"POLLY_GREETD_USER_PASS" in output and events_file.exists() and \
                    events_file.read_text().count(user_close) > old_closed:
                break
        if first in output or second in output:
            raise RuntimeError("Synthetic credential appeared in greetd output; transcript withheld")
        if expected_marker not in output or b"POLLY_GREETD_USER_PASS" not in output:
            raise RuntimeError("Actual greetd authentication/UID transition did not finish")
        events = events_file.read_text()
        if events.count(user_open) <= old_user_open or events.count(user_close) <= old_closed:
            raise RuntimeError("Actual PAM session open/close was not observed")
        if events.count(greeter_open) <= old_greeter_open:
            raise RuntimeError("Released greetd did not pass greeter class to PAM session opening")
        print(("POLLY_GREETD_NATIVE_FIXTURE_PASS" if native else "POLLY_GREETD_FIXTURE_PASS") +
              " package=0.10.3-4 actual-greeter-uid=991 actual-user-uid=1000 "
              "wrong-denied=1 root-denied=1 pam-open=1 pam-close=1 pam-greeter-class=greeter "
              "pam-user-class=user logind-tested=0 gui-tested=0", flush=True)
    except BaseException:
        diagnostics = bytes(output).replace(first, b"[redacted]").replace(second, b"[redacted]")
        print("GREETER FIXTURE DIAGNOSTIC (synthetic tokens redacted): " +
              diagnostics.decode("utf8", errors="replace"), file=sys.stderr, flush=True)
        raise
    finally:
        tokens.close()
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)
        if evidence is not None:
            case = "native-client" if native else "pam-client"
            evidence.mkdir(parents=True, exist_ok=True)
            (evidence / (case + "-greetd.conf")).write_text(config.read_text())
            (evidence / (case + "-user.pam")).write_text(policy)
            (evidence / (case + "-greeter.pam")).write_text(greeter_policy)
            (evidence / (case + "-pam-events")).write_text(events_file.read_text() if events_file.exists() else "")
            diagnostics = bytes(output).replace(first, b"[redacted]").replace(second, b"[redacted]")
            (evidence / (case + "-daemon.log")).write_bytes(diagnostics)
            (evidence / (case + "-stage.json")).write_text(json.dumps({
                "package": "0.10.3-4", "daemonPid": process.pid, "daemonExit": process.returncode,
                "fixtureVt": "none", "greeterUid": UID, "greeterGid": greeter_gid,
                "pamSystemdReplacedByFixtureEventMarker": True,
                "productionSeatPolicyModified": False, "logindTested": False, "guiTested": False,
                "nativeClient": native, "pamGreeterClassExpected": "greeter", "pamUserClassExpected": "user",
            }, sort_keys=True) + "\n")
        output[:] = b"\0" * len(output)


def root_fixture(repo, packages, evidence=None):
    if os.getuid() != 0 or not Path("/run/.containerenv").exists() or FIXTURE.exists():
        raise RuntimeError("Credential fixture requires a pristine disposable rootless container")
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    FIXTURE.mkdir(mode=0o755)
    account_fixture = load("existing_account_fixture", repo / "desktop/tests/account-auth-fixture.py")
    accounts = account_fixture.seed_container(repo)
    broker = load("new_graphical_setup", repo / "desktop/session/setup-broker.py")
    shutil.copyfile(packages / "polly-passwd", "/usr/bin/passwd")
    Path("/usr/bin/passwd").chmod(0o4755)
    subprocess.run(["useradd", "--system", "--uid", str(UID), "--user-group", "--no-create-home",
                    "--home-dir", str(FIXTURE), "--shell", "/usr/sbin/nologin", "polly-greeter"], check=True)
    descriptor = packages / "greetd_0.10.3-4_amd64.deb"
    record = (packages / "greetd-0.10.3-4.metadata").read_text()
    digest = hashlib.sha256(descriptor.read_bytes()).hexdigest()
    if f"SHA256: {digest}\n" not in record or "Version: 0.10.3-4\n" not in record:
        raise RuntimeError("greetd package differs from the exact signed APT record")
    subprocess.run(["dpkg-deb", "--extract", str(descriptor), str(FIXTURE / "package")], check=True)
    shutil.copyfile(FIXTURE / "package/usr/sbin/greetd", "/usr/sbin/greetd")
    Path("/usr/sbin/greetd").chmod(0o755)
    native = packages / "polly-greeter-client-fixture"
    if not native.is_file():
        raise RuntimeError("Compile the current native client fixture before running this acceptance")
    shutil.copyfile(native, "/usr/bin/polly-greeter-client-fixture")
    Path("/usr/bin/polly-greeter-client-fixture").chmod(0o755)
    first, second = bytearray(secrets.token_hex(20).encode()), bytearray(secrets.token_hex(20).encode())
    try:
        password_policy = Path("/etc/pam.d/common-password")
        original_policy = password_policy.read_text()
        deny = Path("/usr/lib/polly-graphical-auth-root-deny")
        deny.write_text('#!/bin/sh\n[ "$PAM_USER" != root ]\n')
        deny.chmod(0o755)
        password_policy.write_text(
            "password requisite pam_exec.so quiet /usr/lib/polly-graphical-auth-root-deny\n" + original_policy)
        setup_round(accounts, broker, first, second, "policy")
        if accounts.completed() or accounts.passwords()["polly"][1].startswith(("!", "*")) or \
                not accounts.passwords()["root"][1].startswith(("!", "*")):
            raise RuntimeError("Second-password failure lost accepted state or reported initialization")
        password_policy.write_text(original_policy)
        setup_round(accounts, broker, first, second, "cancel")
        if accounts.completed():
            raise RuntimeError("Cancellation incorrectly initialized installed accounts")
        accounts.passwords(usable=True)
        native_setup(accounts, broker, first, second)
        accounts.require_ready()
        if accounts.administrator_policy()["administratorUids"] != [1000]:
            raise RuntimeError("Graphical first-run did not use the existing role bootstrap")
        previous = accounts.read(accounts.ROOT / "etc/shadow", secret=True)
        setup_round(accounts, broker, first, second, "initialized")
        setup_round(accounts, broker, first, second, "initialized", deny_uid=True)
        if previous != accounts.read(accounts.ROOT / "etc/shadow", secret=True):
            raise RuntimeError("Initialized-state refusal changed a configured password")
        print("POLLY_GRAPHICAL_SETUP_FIXTURE_PASS actual-client-uid=991 second-password-failure=1 "
              "cancel-uninitialized=1 commit=1 root-peer-denied=1 initialized-reset-denied=1 seat-tested=0", flush=True)
        run_greetd(repo, first, second, evidence=evidence)
        run_greetd(repo, first, second, native=True, evidence=evidence)
    finally:
        broker.wipe(first)
        broker.wipe(second)


if __name__ == "__main__":
    try:
        if len(sys.argv) == 2 and sys.argv[1] == "--greeter":
            greeter()
        elif len(sys.argv) == 2 and sys.argv[1] == "--user":
            user_session()
        elif len(sys.argv) in (3, 4):
            root_fixture(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]) if len(sys.argv) == 4 else None)
        else:
            raise ValueError("Invalid fixture arguments")
    except BaseException as error:
        print("GRAPHICAL AUTH FIXTURE FAILED: " + type(error).__name__ +
              (": " + str(error) if isinstance(error, RuntimeError) else " (credential transcript withheld)"),
              file=sys.stderr, flush=True)
        sys.exit(1)
