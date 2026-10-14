"""Read only /proc; the only managed PID is this fixture's own child."""
from pathlib import Path
import os
import subprocess
import sys

if os.getuid() == 0:
    raise SystemExit("Run the process fixture as an ordinary user")
runner, library = sys.argv[1:]
repo = Path(__file__).resolve().parents[4]
program = (
    "import time\n"
    "print('ready', flush=True)\n"
    "end=time.monotonic()+3\n"
    "while time.monotonic()<end: pass\n"
    "time.sleep(15)\n"
)
child = subprocess.Popen([sys.executable, "-c", program], stdout=subprocess.PIPE, text=True)
try:
    if child.stdout.readline().strip() != "ready":
        raise RuntimeError("Owned fixture process did not become ready")
    subprocess.run([runner, str(repo / "desktop/apps/processes/tests/native.mjs"), library, str(child.pid)],
                   cwd=repo, check=True, timeout=20)
    print("PASS: actual PID/name/state/RSS/CPU from isolated owned process; no management actions")
finally:
    child.stdout.close()
    if child.poll() is None:
        child.terminate()
    child.wait(timeout=5)
