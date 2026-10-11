"""Single-reader JS call/signal/agent routing on a real, isolated private bus."""
import os
from pathlib import Path
import selectors
import subprocess
import sys
import tempfile

runner, oracle, daemon, *flags = sys.argv[1:]
if flags not in ([], ["--valgrind"]):
    raise ValueError("Unsupported endpoint fixture option")
prefix = (["valgrind", "--quiet", "--error-exitcode=99", "--leak-check=full",
           "--show-leak-kinds=definite,indirect", "--errors-for-leak-kinds=definite,indirect"] if flags else [])
repo = Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix="polly-dbus-endpoint-") as directory:
    root = Path(directory)
    address = f"unix:path={root / 'bus'}"
    config = root / "bus.conf"
    config.write_text(
        f"<busconfig><type>session</type><listen>{address}</listen><auth>EXTERNAL</auth>"
        '<policy context="default"><allow user="*"/><allow own="*"/>'
        '<allow send_destination="*"/><allow receive_sender="*"/></policy></busconfig>')
    bus = subprocess.Popen([daemon, "--nofork", "--nopidfile", "--print-address=1",
                            f"--config-file={config}"], stdout=subprocess.PIPE, text=True)
    try:
        with selectors.DefaultSelector() as ready:
            ready.register(bus.stdout, selectors.EVENT_READ)
            if not ready.select(timeout=10):
                raise RuntimeError("Private endpoint bus did not become ready")
            actual = bus.stdout.readline().strip()
        if not actual.startswith(address):
            raise RuntimeError("Unexpected private bus address")
        subprocess.run(prefix + [runner, str(repo / "sysrt/tests/dbus-endpoint.mjs"), oracle, actual],
                       cwd=repo, env={**os.environ, "DBUS_SESSION_BUS_ADDRESS": "unix:path=/must-not-use",
                                      "DBUS_SYSTEM_BUS_ADDRESS": "unix:path=/must-not-use"},
                       check=True, timeout=120 if flags else 60)
    finally:
        if bus.poll() is None:
            bus.terminate()
            try:
                bus.wait(timeout=5)
            except subprocess.TimeoutExpired:
                bus.kill()
                bus.wait(timeout=5)
        bus.stdout.close()
