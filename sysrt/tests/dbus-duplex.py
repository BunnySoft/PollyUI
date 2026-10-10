"""Real independent JS service/client processes on a private, explicit bus."""
import json
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


runner, library, daemon = sys.argv[1:]
repo = Path(__file__).resolve().parents[2]
environment = {
    **os.environ, "DBUS_SESSION_BUS_ADDRESS": "unix:path=/nonexistent-session-bus",
    "DBUS_SYSTEM_BUS_ADDRESS": "unix:path=/nonexistent-system-bus",
}
with tempfile.TemporaryDirectory(prefix="polly-dbus-duplex-") as directory:
    root = Path(directory)
    address = f"unix:path={root / 'bus'}"
    config = root / "bus.conf"
    config.write_text(
        f"<busconfig><type>session</type><listen>{address}</listen>"
        "<auth>EXTERNAL</auth><policy context=\"default\">"
        "<allow user=\"*\"/><allow own=\"*\"/><allow send_destination=\"*\"/>"
        "<allow receive_sender=\"*\"/></policy></busconfig>", encoding="utf-8")
    bus = subprocess.Popen([daemon, "--nofork", "--nopidfile", "--print-address=1",
                            f"--config-file={config}"], stdout=subprocess.PIPE, text=True, env=environment)
    service = client = None
    try:
        actual = line(bus, "Private D-Bus daemon")
        if not actual.startswith(address):
            raise RuntimeError(f"Private daemon returned an unexpected address: {actual}")
        service = subprocess.Popen(
            [runner, str(repo / "sysrt" / "tests" / "dbus-js-service.mjs"), library, actual],
            cwd=repo, stdout=subprocess.PIPE, text=True, env=environment)
        for run in [0, 8, 1]:
            if line(service, "JS service") != f"READY {run} {service.pid}":
                raise RuntimeError("JS service readiness/process identity failed")
            subprocess.run(
                [runner, str(repo / "sysrt" / "tests" / "dbus-js-client.mjs"), library, actual],
                cwd=repo, env=environment, check=True, timeout=80)
            if bus.poll() is not None:
                raise RuntimeError("Private daemon exited unexpectedly")
        if service.wait(timeout=10) != 0:
            raise RuntimeError("JS service failed")
        stop(service)
        service = subprocess.Popen(
            [runner, str(repo / "sysrt" / "tests" / "dbus-js-disconnect.mjs"), library,
             json.dumps({"address": actual, "role": "service"})],
            cwd=repo, stdout=subprocess.PIPE, text=True, env=environment)
        if line(service, "Disconnect service") != f"SERVICE_READY {service.pid}":
            raise RuntimeError("Disconnect service readiness failed")
        client = subprocess.Popen(
            [runner, str(repo / "sysrt" / "tests" / "dbus-js-disconnect.mjs"), library,
             json.dumps({"address": actual, "role": "client"})],
            cwd=repo, stdout=subprocess.PIPE, text=True, env=environment)
        if line(client, "Disconnect client") != f"CLIENT_READY {client.pid}":
            raise RuntimeError("Disconnect client readiness failed")
        stop(bus)
        if service.wait(timeout=10) != 0 or client.wait(timeout=10) != 0:
            raise RuntimeError("Bus disconnect lifetime check failed")
        print("PASS: separate JS service/client processes, scalar/tuple replies and retained-request lifetime")
    finally:
        if client is not None:
            stop(client)
        if service is not None:
            stop(service)
        stop(bus)
