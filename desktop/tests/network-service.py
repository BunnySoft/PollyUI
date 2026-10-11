"""Root private-bus coordinator; both synthetic iwd and JS consumer run as UID1000."""
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
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


if os.geteuid() != 0:
    raise RuntimeError("Use the isolated root fixture coordinator, never the host system bus")
runner, library, provider = sys.argv[1:]
repo = Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix="polly-iwd-owner-") as directory:
    root = Path(directory)
    root.chmod(0o755)
    address = f"unix:path={root / 'bus'}"
    environment = {**os.environ, "DBUS_SYSTEM_BUS_ADDRESS": address,
                   "DBUS_SESSION_BUS_ADDRESS": "unix:path=/must-not-use"}
    config = root / "bus.conf"
    config.write_text(
        f"<busconfig><type>system</type><listen>{address}</listen><auth>EXTERNAL</auth>"
        '<policy context="default"><allow user="*"/><allow own="*"/>'
        '<allow send_destination="*"/><allow receive_sender="*"/></policy></busconfig>')
    bus = fixture = None
    try:
        bus = subprocess.Popen(["dbus-daemon", "--nofork", "--nopidfile", f"--config-file={config}"],
                               env=environment)
        deadline = time.monotonic() + 5
        while not (root / "bus").is_socket():
            if bus.poll() is not None or time.monotonic() >= deadline:
                raise RuntimeError("Private system-bus fixture startup failed")
            time.sleep(0.01)
        fixture = subprocess.Popen([provider, "restart"], env=environment, preexec_fn=ordinary)
        # A bus-daemon round trip confirms ownership, not a guessed startup sleep.
        deadline = time.monotonic() + 5
        while subprocess.run(
                ["dbus-send", f"--bus={address}", "--type=method_call", "--print-reply",
                 "--dest=org.freedesktop.DBus", "/org/freedesktop/DBus",
                 "org.freedesktop.DBus.NameHasOwner", "string:net.connman.iwd"],
                env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                timeout=2, check=True).stdout.find(b"boolean true") < 0:
            if fixture.poll() is not None or time.monotonic() >= deadline:
                raise RuntimeError("Ordinary-user synthetic iwd did not acquire its private name")
            time.sleep(0.01)
        subprocess.run([runner, str(repo / "desktop/tests/network-service.mjs"), library, address],
                       cwd=repo, env=environment, preexec_fn=ordinary, check=True, timeout=20)
        if fixture.poll() is not None:
            raise RuntimeError("The denied iwd owner unexpectedly exited")
    finally:
        stop(fixture)
        stop(bus)
