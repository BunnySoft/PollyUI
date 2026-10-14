#!/usr/bin/env python3
"""Bound Live startup, retain its real logs, and return failures to the user's TTY."""
import os
from pathlib import Path
import re
import selectors
import signal
import subprocess
import sys
import syslog
import tempfile
import time

READY = re.compile(rb"(?:^| )POLLY_LIVE_DESKTOP_READY outputs=[1-9][0-9]*\r?$")
ANSI = re.compile(rb"\x1b\[[0-9;]*m")
STARTUP_SECONDS = 90


def supervise(command, log, timeout=STARTUP_SECONDS):
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               start_new_session=True)
    ready = False
    pending = b""
    started = time.monotonic()
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    try:
        while selector.get_map():
            if not ready and time.monotonic() - started >= timeout:
                raise TimeoutError(f"Desktop did not become usable within {timeout} seconds")
            events = selector.select(0.1)
            for key, _ in events:
                block = os.read(key.fileobj.fileno(), 65536)
                if not block:
                    selector.unregister(key.fileobj)
                    continue
                log.write(block)
                log.flush()
                pending += block
                while b"\n" in pending:
                    line, pending = pending.split(b"\n", 1)
                    syslog.syslog(syslog.LOG_INFO, line.decode("utf-8", "replace"))
                    if READY.search(ANSI.sub(b"", line)):
                        ready = True
                if len(pending) > 65536:
                    syslog.syslog(syslog.LOG_WARNING, "Oversized session log line; see private session log")
                    pending = b""
            if process.poll() is not None and not events:
                break
        result = process.wait(timeout=5)
        if pending:
            syslog.syslog(syslog.LOG_INFO, pending.decode("utf-8", "replace"))
        if result:
            raise RuntimeError(f"Desktop session failed with status {result}")
        if not ready:
            raise RuntimeError("Desktop exited before its first usable frame")
        return 0
    finally:
        selector.close()
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
        process.stdout.close()


def main():
    if os.getuid() != 1000 or os.environ.get("XDG_RUNTIME_DIR") != "/run/user/1000":
        raise RuntimeError("Live startup requires the existing ordinary-user PAM session")
    syslog.openlog("polly-session", syslog.LOG_PID)
    def interrupted(number, frame):
        raise InterruptedError("Session interrupted by signal " + str(number))
    signal.signal(signal.SIGTERM, interrupted)
    fd, name = tempfile.mkstemp(prefix="polly-session-", dir=Path.home())
    syslog.syslog(syslog.LOG_INFO, "Live startup deadline: 90 seconds; private log: " + name)
    if os.environ.get("POLLY_LIVE_SPLASH") != "1":
        print("Starting PollyDesktop Live. Ctrl+Alt+F2: console. Startup limit: 90 seconds.", flush=True)
        print("Session log: " + name, flush=True)
    command = ["sh", "/usr/share/pollyui/desktop/tools/run-session.sh",
               "--save-before-exit", "--ime", "--audio", "/usr/bin/pollywm", "/usr/bin/pollyui",
               "/usr/share/pollyui/desktop/shell/live.mjs"]
    try:
        with os.fdopen(fd, "wb") as log:
            supervise(command, log)
    except (OSError, RuntimeError, TimeoutError, subprocess.TimeoutExpired, KeyboardInterrupt) as error:
        message = "Polly Live startup/session stopped: " + str(error)
        syslog.syslog(syslog.LOG_ERR, message)
        print("\033[?25h\n" + message, file=sys.stderr, flush=True)
        print("Diagnostics: polly-live-diagnostics | journalctl -b | " + name, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
