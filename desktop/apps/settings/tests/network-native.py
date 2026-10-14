"""Private bus/iwd coordinator; no host network or GUI is used."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time


def ordinary():
    os.setgroups([])
    os.setgid(1000)
    os.setuid(1000)


def stop(process):
    if process is not None and process.poll() is None:
        process.terminate()
        process.wait(timeout=5)


if os.getuid() != 0 or os.geteuid() != 0:
    raise SystemExit("Use only an isolated root fixture coordinator")
runner, library, provider = sys.argv[1:]
repo = Path(__file__).resolve().parents[4]
with tempfile.TemporaryDirectory(prefix="polly-settings-network-api-") as temporary:
    root = Path(temporary)
    root.chmod(0o755)
    processes = []
    env = dict(os.environ)
    try:
        for kind in ("system", "session"):
            socket = root / (kind + "-bus")
            address = "unix:path=" + str(socket)
            config = root / (kind + ".conf")
            config.write_text(
                f"<busconfig><type>{kind}</type><listen>{address}</listen><auth>EXTERNAL</auth>"
                '<policy context="default"><allow user="*"/><allow own="*"/>'
                '<allow send_destination="*"/><allow receive_sender="*"/></policy></busconfig>')
            bus = subprocess.Popen(["dbus-daemon", "--nofork", "--nopidfile", "--config-file=" + str(config)])
            processes.append(bus)
            deadline = time.monotonic() + 5
            while not socket.is_socket():
                if bus.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError("Private fixture bus failed to start")
                time.sleep(0.01)
            env["DBUS_" + kind.upper() + "_BUS_ADDRESS"] = address
        iwd = subprocess.Popen([provider, "restart"], env=env)
        processes.append(iwd)
        deadline = time.monotonic() + 5
        while True:
            query = subprocess.run(
                ["dbus-send", "--bus=" + env["DBUS_SYSTEM_BUS_ADDRESS"], "--type=method_call", "--print-reply",
                 "--dest=org.freedesktop.DBus", "/org/freedesktop/DBus",
                 "org.freedesktop.DBus.NameHasOwner", "string:net.connman.iwd"],
                env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=2)
            if b"boolean true" in query.stdout:
                break
            if iwd.poll() is not None or time.monotonic() > deadline:
                raise RuntimeError("Root-owned synthetic iwd did not become ready")
            time.sleep(0.01)
        subprocess.run(
            [runner, str(repo / "desktop/apps/settings/tests/network-native.mjs"),
             library, env["DBUS_SESSION_BUS_ADDRESS"]], cwd=repo, env=env,
            preexec_fn=ordinary, check=True, timeout=45)
        subprocess.run([provider, "quit"], env=env, preexec_fn=ordinary, check=True, timeout=5)
        if iwd.wait(timeout=5) != 0:
            raise RuntimeError("Synthetic iwd reported a failed operation")
    finally:
        for process in reversed(processes):
            stop(process)
