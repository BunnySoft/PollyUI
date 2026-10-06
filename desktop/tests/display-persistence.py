#!/usr/bin/env python3
import os
from pathlib import Path
import subprocess
import sys
import tempfile

with tempfile.TemporaryDirectory(prefix="polly-display-profile-") as temporary:
    root = Path(temporary)
    run = root / "run"
    run.mkdir(mode=0o700)
    environment = dict(os.environ, XDG_RUNTIME_DIR=str(run), XDG_CONFIG_HOME=str(root / "config"),
                       XDG_DATA_HOME=str(root / "data"), XDG_CACHE_HOME=str(root / "cache"),
                       SDL_VIDEODRIVER="wayland", SDL_RENDER_DRIVER="software",
                       WLR_RENDERER="pixman", WLR_BACKENDS="headless", WLR_HEADLESS_OUTPUTS="2")
    for stage in ("save", "timeout", "keep", "unknown", "mismatch", "damaged"):
        result = subprocess.run([*sys.argv[1:], "profile", stage], env=environment, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60)
        if (result.returncode or f"PASS: display persistence {stage}" not in result.stdout
                or any(marker in result.stdout for marker in ("FAIL:", "Uncaught", "AddressSanitizer", "runtime error:"))):
            print(result.stdout)
            raise SystemExit(f"Display persistence failed: {stage}")
    print("PASS: fresh display sessions restore exact identities with native confirmation and rollback")
