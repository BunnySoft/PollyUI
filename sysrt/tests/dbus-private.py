"""Run the JS/config client against a test-only service on an isolated bus."""
import os
from pathlib import Path
import selectors
import subprocess
import sys
import tempfile


def line(process, label):
    with selectors.DefaultSelector() as ready:
        ready.register(process.stdout, selectors.EVENT_READ)
        if not ready.select(timeout=10):
            raise RuntimeError(f"{label} did not become ready")
        result = process.stdout.readline().strip()
    if not result:
        raise RuntimeError(f"{label} exited during startup")
    return result


def stop(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
    process.stdout.close()


runner, library, fixture, daemon = sys.argv[1:]
repo = Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix="polly-dbus-private-") as directory:
    root = Path(directory)
    address = f"unix:path={root / 'bus'}"
    config = root / "bus.conf"
    config.write_text(
        f"<busconfig><type>session</type><listen>{address}</listen>"
        "<auth>EXTERNAL</auth><policy context=\"default\">"
        "<allow user=\"*\"/><allow own=\"*\"/><allow send_destination=\"*\"/>"
        "<allow receive_sender=\"*\"/></policy></busconfig>", encoding="utf-8")
    bus = subprocess.Popen([daemon, "--nofork", "--nopidfile", "--print-address=1",
                            f"--config-file={config}"], stdout=subprocess.PIPE, text=True)
    service = None
    try:
        actual = line(bus, "Private D-Bus daemon")
        if not actual.startswith(address):
            raise RuntimeError(f"Private daemon returned an unexpected address: {actual}")
        service = subprocess.Popen([fixture, actual], stdout=subprocess.PIPE, text=True)
        if line(service, "Private fixture service") != "READY":
            raise RuntimeError("Private fixture service readiness failed")
        subprocess.run(
            [runner, str(repo / "sysrt" / "tests" / "dbus.mjs"), library, actual],
            cwd=repo, env={**os.environ, "DBUS_SESSION_BUS_ADDRESS": "unix:path=/nonexistent-session-bus",
                           "DBUS_SYSTEM_BUS_ADDRESS": "unix:path=/nonexistent-system-bus"},
            check=True, timeout=45)
        if bus.poll() is not None or service.poll() is not None:
            raise RuntimeError("Private D-Bus fixture exited unexpectedly")
        print("PASS: private bus uint32 reply, remote error, timeout, cancellation and no replay")
    finally:
        if service is not None:
            stop(service)
        stop(bus)
