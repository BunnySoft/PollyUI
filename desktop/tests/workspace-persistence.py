#!/usr/bin/env python3
import os
from pathlib import Path
import subprocess
import sys
import tempfile

with tempfile.TemporaryDirectory(prefix="polly-workspaces-") as temporary:
    root = Path(temporary)
    run = root / "run"
    run.mkdir(mode=0o700)
    environment = dict(os.environ, XDG_RUNTIME_DIR=str(run),
                       XDG_CONFIG_HOME=str(root / "config"), XDG_DATA_HOME=str(root / "data"),
                       XDG_CACHE_HOME=str(root / "cache"), PU_RENDERER="raster", SDL_RENDER_DRIVER="software")
    for mode in ("bulk", "save", "reload", "damaged", "recover"):
        result = subprocess.run(["sh", sys.argv[1], "--headless", *sys.argv[2:], mode],
                                env=environment, text=True, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, timeout=25)
        if (result.returncode or f"PASS: workspace persistence {mode}" not in result.stdout
                or any(marker in result.stdout for marker in ("FAIL:", "Uncaught", "AddressSanitizer", "runtime error:"))):
            print(result.stdout)
            raise SystemExit(f"Workspace persistence failed: {mode}")
    print("PASS: workspace settings survive fresh compositor sessions and recover explicitly")
