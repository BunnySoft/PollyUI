#!/usr/bin/python3 -I
"""Socket-activated first-run password transaction; no general privileged API."""
import ctypes
import errno
import hmac
import importlib.machinery
import importlib.util
import os
from pathlib import Path
import pwd
import resource
import select
import signal
import socket
import stat
import struct
import subprocess
import sys
import termios
import time
import pty

MAGIC = 0x50475231
LIMIT = 1024
REQUEST = struct.Struct("=IIII")
REPLY = struct.Struct("=II")
STATUS, SETUP, COMMIT, CANCEL = range(4)
NEEDS_SETUP, LOGIN, POLLY, ROOT, PREPARED, COMMITTING, COMPLETE, CANCELLED, POLICY, UNAVAILABLE = range(1, 11)
SOCKET = "/run/polly-greeter/setup.sock"
ACCOUNTS = "/usr/sbin/polly-accounts"
GREETER = "polly-greeter"


class Cancelled(Exception):
    pass


class PasswordPolicyError(Exception):
    pass


def wipe(buffer):
    buffer[:] = b"\0" * len(buffer)


def trusted(path, directory=False):
    info = Path(path).lstat()
    valid = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    if not valid or info.st_uid != 0 or info.st_mode & 0o022:
        raise PermissionError("Untrusted fixed service deployment")


def load_accounts():
    for path in ("/usr", "/usr/sbin"):
        trusted(path, True)
    trusted(ACCOUNTS)
    loader = importlib.machinery.SourceFileLoader("polly_greeter_accounts", ACCOUNTS)
    spec = importlib.util.spec_from_loader(loader.name, loader)
    accounts = importlib.util.module_from_spec(spec)
    loader.exec_module(accounts)
    return accounts


class SeatAuthority:
    def __init__(self):
        self.systemd = ctypes.CDLL("libsystemd.so.0")
        self.libc = ctypes.CDLL(None)
        self.libc.free.argtypes = [ctypes.c_void_p]
        for name in ("sd_pid_get_session", "sd_session_get_class", "sd_session_get_seat",
                     "sd_session_get_type", "sd_session_get_tty"):
            function = getattr(self.systemd, name)
            function.argtypes = [ctypes.c_int if name == "sd_pid_get_session" else ctypes.c_char_p,
                                 ctypes.POINTER(ctypes.c_void_p)]
            function.restype = ctypes.c_int
        self.systemd.sd_session_get_uid.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_uint)]
        self.systemd.sd_session_get_uid.restype = ctypes.c_int
        for name in ("sd_session_is_active", "sd_session_is_remote"):
            getattr(self.systemd, name).argtypes = [ctypes.c_char_p]
            getattr(self.systemd, name).restype = ctypes.c_int

    def text(self, name, argument):
        result = ctypes.c_void_p()
        if getattr(self.systemd, name)(argument, ctypes.byref(result)) < 0 or not result.value:
            raise PermissionError("Required local greeter session is unavailable")
        try:
            return ctypes.string_at(result)
        finally:
            self.libc.free(result)

    def authorize(self, channel):
        pid, uid, gid = struct.unpack("=iII", channel.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        greeter = pwd.getpwnam(GREETER)
        if not 0 < greeter.pw_uid < 1000 or uid != greeter.pw_uid or gid != greeter.pw_gid:
            raise PermissionError("Only the dedicated ordinary greeter may request setup")
        descriptor = os.pidfd_open(pid)
        try:
            session = self.text("sd_pid_get_session", pid)
            session_uid = ctypes.c_uint()
            if self.systemd.sd_session_get_uid(session, ctypes.byref(session_uid)) < 0 or \
                    session_uid.value != uid or \
                    self.text("sd_session_get_class", session) != b"greeter" or \
                    self.text("sd_session_get_seat", session) != b"seat0" or \
                    self.text("sd_session_get_type", session) != b"wayland" or \
                    self.text("sd_session_get_tty", session) != b"tty1" or \
                    self.systemd.sd_session_is_active(session) != 1 or \
                    self.systemd.sd_session_is_remote(session) != 0 or select.select([descriptor], [], [], 0)[0]:
                raise PermissionError("Setup requires the active local seat0 tty1 greeter")
        finally:
            os.close(descriptor)


def receive(channel, length, timeout=5):
    buffer = bytearray(length)
    offset, deadline = 0, time.monotonic() + timeout
    try:
        while offset < length:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([channel], [], [], remaining)[0]:
                raise TimeoutError("Bounded setup request timed out")
            count = channel.recv_into(memoryview(buffer)[offset:])
            if not count:
                raise Cancelled()
            offset += count
        return buffer
    except BaseException:
        wipe(buffer)
        raise


def request(channel):
    buffer = receive(channel, REQUEST.size)
    try:
        magic, operation, first, second = REQUEST.unpack(buffer)
        if magic != MAGIC or operation not in (STATUS, SETUP, COMMIT, CANCEL) or \
                (operation != SETUP and (first or second)) or \
                (operation == SETUP and not (0 < first <= LIMIT and 0 < second <= LIMIT)):
            raise ValueError("Invalid bounded setup request")
        return operation, first, second
    finally:
        wipe(buffer)


def send(channel, result):
    channel.settimeout(5)
    channel.sendall(REPLY.pack(MAGIC, result))
    channel.settimeout(None)


def cancellation(channel):
    if select.select([channel], [], [], 0)[0]:
        operation, _, _ = request(channel)
        if operation != CANCEL:
            raise ValueError("Only cancellation is accepted during password setup")
        raise Cancelled()


def password_tool(channel, name, token):
    if name not in ("polly", "root"):
        raise ValueError("Unsupported first-run password target")
    master, slave = pty.openpty()
    attributes = termios.tcgetattr(slave)
    attributes[3] &= ~termios.ECHO
    termios.tcsetattr(slave, termios.TCSANOW, attributes)
    libc = ctypes.CDLL(None)
    parent = os.getpid()

    def isolate():
        os.setsid()
        if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0 or os.getppid() != parent:
            os._exit(126)
        os.umask(0o077)

    process = None
    pending = bytearray()
    try:
        trusted("/usr/bin", True)
        trusted("/usr/bin/passwd")
        process = subprocess.Popen(["/usr/bin/passwd", name], stdin=slave, stdout=slave, stderr=slave,
                                   preexec_fn=isolate, close_fds=True,
                                   env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"})
        deadline, prompts, total = time.monotonic() + 40, 0, 0
        expected = (b"New password:", b"Retype new password:")
        while process.poll() is None:
            cancellation(channel)
            if time.monotonic() >= deadline:
                raise TimeoutError("Password policy did not complete in time")
            readable, _, _ = select.select([master, channel], [], [], 0.05)
            if channel in readable:
                cancellation(channel)
            if master not in readable:
                continue
            try:
                chunk = os.read(master, 4096)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not chunk:
                break
            total += len(chunk)
            if total > 16384:
                raise ValueError("Password policy output exceeded its bound")
            pending.extend(chunk)
            if prompts < 2 and pending.rstrip().endswith(expected[prompts]):
                if termios.tcgetattr(slave)[3] & termios.ECHO:
                    raise PermissionError("Password input unexpectedly enabled echo")
                response = bytearray(token)
                response.append(10)
                try:
                    offset = 0
                    while offset < len(response):
                        offset += os.write(master, memoryview(response)[offset:])
                finally:
                    wipe(response)
                prompts += 1
                wipe(pending)
                pending.clear()
        result = process.wait(timeout=5)
        cancellation(channel)
        if result != 0 or prompts != 2:
            raise PasswordPolicyError()
    finally:
        wipe(pending)
        if process is not None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=5)
        os.close(master)
        os.close(slave)


def transaction(channel, accounts, authorize):
    payload = bytearray()
    try:
        authorize(channel)
        operation, first, second = request(channel)
        accounts.require_ready(False)
        if operation == STATUS:
            send(channel, LOGIN if accounts.completed() else NEEDS_SETUP)
            return
        if operation != SETUP:
            raise ValueError("Expected status or first-run setup")
        payload = receive(channel, first + second)
        polly, root = memoryview(payload)[:first], memoryview(payload)[first:]
        if any(value < 32 or value == 127 for value in payload):
            print("First-run setup rejected terminal-control password input.", file=sys.stderr)
            raise PasswordPolicyError()
        if hmac.compare_digest(polly, root):
            raise ValueError("Passwords must be nonempty, separate and single-line")
        with accounts.state_lock(timeout=5):
            accounts.require_ready(False)
            if accounts.completed():
                raise PermissionError("Initialized passwords cannot be replaced by first-run setup")
            authorize(channel)
            cancellation(channel)
            send(channel, POLLY)
            password_tool(channel, "polly", polly)
            send(channel, ROOT)
            password_tool(channel, "root", root)
            wipe(payload)
            accounts.passwords(usable=True)
            send(channel, PREPARED)
            operation, _, _ = request(channel)
            if operation == CANCEL:
                raise Cancelled()
            if operation != COMMIT:
                raise ValueError("Initialization requires a separate commit")
            authorize(channel)
            cancellation(channel)
            send(channel, COMMITTING)
            accounts.finish()
            accounts.require_ready()
            send(channel, COMPLETE)
    except Cancelled:
        try:
            send(channel, CANCELLED)
        except (BrokenPipeError, ConnectionResetError):
            print("First-run request disconnected; no completion was sent.", file=sys.stderr)
    except PasswordPolicyError:
        send(channel, POLICY)
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print("First-run service refused request: " + type(error).__name__, file=sys.stderr)
        try:
            send(channel, UNAVAILABLE)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            print("First-run failure response could not be delivered.", file=sys.stderr)
    finally:
        wipe(payload)


def main():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    libc = ctypes.CDLL(None)
    if os.getuid() != 0 or os.geteuid() != 0 or len(sys.argv) != 1 or libc.prctl(4, 0, 0, 0, 0):
        raise PermissionError("Setup broker requires its fixed root service")
    if os.environ.get("LISTEN_PID") != str(os.getpid()) or os.environ.get("LISTEN_FDS") != "1":
        raise PermissionError("Setup broker requires one systemd-owned socket")
    os.environ.clear()
    os.environ.update(PATH="/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL="C")
    os.umask(0o077)
    listener = socket.socket(fileno=3)
    listener.set_inheritable(False)
    if listener.family != socket.AF_UNIX or listener.type != socket.SOCK_STREAM or listener.getsockname() != SOCKET:
        raise PermissionError("Unexpected first-run socket")
    accounts, authority = load_accounts(), SeatAuthority()
    while True:
        channel, _ = listener.accept()
        with channel:
            channel.set_inheritable(False)
            transaction(channel, accounts, authority.authorize)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError) as error:
        print("First-run service could not start: " + type(error).__name__, file=sys.stderr)
        sys.exit(1)
